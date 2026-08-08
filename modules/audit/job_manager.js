const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')
const { Worker } = require('worker_threads')
const { nanoid } = require('nanoid')
const { atomicWriteJson, readJson } = require('./utils.js')

class AuditJobManager extends EventEmitter {
  constructor({ storePath, coordinator }) {
    super()
    this.storePath = path.join(storePath, 'audit')
    this.jobsPath = path.join(this.storePath, 'jobs')
    this.logPath = path.join(this.storePath, 'audit-log.jsonl')
    this.coordinator = coordinator
    this.worker = null
    this.state = {
      jobId: null,
      status: 'idle',
      phase: 'idle',
      completed: 0,
      total: 0,
      reportPath: null,
      error: null,
      summary: null
    }
  }

  async initialize() {
    await fs.promises.mkdir(this.jobsPath, { recursive: true })
    const jobNames = await fs.promises.readdir(this.jobsPath).catch(() => [])
    const states = []
    for (const jobName of jobNames) {
      const state = await readJson(path.join(this.jobsPath, jobName, 'state.json'))
      if (state) states.push(state)
    }
    states.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    if (states[0]) {
      this.state = states[0]
      if (['running', 'cancelling'].includes(this.state.status)) {
        this.state.status = 'interrupted'
        this.state.phase = 'interrupted'
        await this.persistState()
      }
    }
  }

  getState() {
    return { ...this.state, lock: this.coordinator.getState() }
  }

  async persistState() {
    if (!this.state.jobId) return
    this.state.updatedAt = new Date().toISOString()
    await atomicWriteJson(path.join(this.jobsPath, this.state.jobId, 'state.json'), this.state)
  }

  async setState(patch) {
    this.state = { ...this.state, ...patch, updatedAt: new Date().toISOString() }
    await this.persistState()
    this.emit('state', this.getState())
  }

  async appendLog(message, level = 'info') {
    const entry = { at: new Date().toISOString(), jobId: this.state.jobId, level, message }
    await fs.promises.mkdir(this.storePath, { recursive: true })
    await fs.promises.appendFile(this.logPath, `${JSON.stringify(entry)}\n`, 'utf8')
    this.emit('log', entry)
  }

  async start(options) {
    if (this.worker || this.state.status === 'running') throw new Error('AUDIT_ALREADY_RUNNING')
    const jobId = `${new Date().toISOString().replace(/[:.]/g, '-')}_${nanoid(8)}`
    this.coordinator.beginAudit(jobId)
    let worker
    try {
      const jobDir = path.join(this.jobsPath, jobId)
      await fs.promises.mkdir(jobDir, { recursive: true })
      await this.setState({
        jobId,
        status: 'running',
        phase: 'starting',
        completed: 0,
        total: 0,
        reportPath: null,
        error: null,
        summary: null,
        startedAt: new Date().toISOString(),
        mode: options.mode,
        deepScope: options.deepScope
      })
      await this.appendLog(`启动${options.mode === 'deep' ? '深度' : '快速'}检查`)
      worker = new Worker(path.join(__dirname, 'audit_worker.js'), {
        workerData: { jobId, jobDir, options }
      })
    } catch (error) {
      this.coordinator.endAudit(jobId)
      throw error
    }
    this.worker = worker
    let workerFinished = false
    worker.on('message', async message => {
      if (message.type === 'progress') {
        await this.setState({ phase: message.phase, completed: message.completed, total: message.total })
      } else if (message.type === 'log') {
        await this.appendLog(message.message)
      } else if (message.type === 'completed') {
        workerFinished = true
        await this.setState({ status: 'completed', phase: 'completed', reportPath: message.reportPath, summary: message.summary, completedAt: new Date().toISOString() })
        await this.appendLog('检查完成')
        this.finishWorker(jobId)
      } else if (message.type === 'cancelled') {
        workerFinished = true
        await this.setState({ status: 'interrupted', phase: 'cancelled', completedAt: new Date().toISOString() })
        await this.appendLog('检查已停止', 'warning')
        this.finishWorker(jobId)
      } else if (message.type === 'failed') {
        workerFinished = true
        await this.setState({ status: 'failed', phase: 'failed', error: message.error, completedAt: new Date().toISOString() })
        await this.appendLog(message.error, 'error')
        this.finishWorker(jobId)
      }
    })
    worker.on('error', async error => {
      if (workerFinished) return
      workerFinished = true
      await this.setState({ status: 'failed', phase: 'failed', error: error.stack || error.message })
      await this.appendLog(error.stack || error.message, 'error')
      this.finishWorker(jobId)
    })
    worker.on('exit', async code => {
      if (!workerFinished && code !== 0) {
        workerFinished = true
        await this.setState({ status: 'failed', phase: 'failed', error: `Audit worker exited with code ${code}` })
        this.finishWorker(jobId)
      }
    })
    return this.getState()
  }

  finishWorker(jobId) {
    this.worker = null
    this.coordinator.endAudit(jobId)
    this.emit('state', this.getState())
  }

  async cancel() {
    if (!this.worker || this.state.status !== 'running') return this.getState()
    await this.setState({ status: 'cancelling', phase: 'cancelling' })
    this.worker.postMessage({ type: 'cancel' })
    return this.getState()
  }

  async interruptForExit(timeoutMs = 5000) {
    if (!this.worker) return
    this.worker.postMessage({ type: 'cancel' })
    const worker = this.worker
    await Promise.race([
      new Promise(resolve => worker.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, timeoutMs))
    ])
    if (this.worker) {
      await worker.terminate()
      this.worker = null
    }
    this.coordinator.endAudit(this.state.jobId)
    if (['running', 'cancelling'].includes(this.state.status)) {
      await this.setState({ status: 'interrupted', phase: 'interrupted' })
    }
  }

  async getReport() {
    if (!this.state.reportPath) return null
    return await readJson(this.state.reportPath)
  }

  async saveReview(review) {
    if (!this.state.jobId || !this.state.reportPath) throw new Error('AUDIT_REPORT_MISSING')
    const value = { ...review, jobId: this.state.jobId, updatedAt: new Date().toISOString() }
    await atomicWriteJson(path.join(this.jobsPath, this.state.jobId, 'review.json'), value)
    return value
  }

  async getReview() {
    if (!this.state.jobId) return null
    return await readJson(path.join(this.jobsPath, this.state.jobId, 'review.json'), {
      jobId: this.state.jobId,
      anomalyActionIds: [],
      duplicateSelections: {}
    })
  }
}

module.exports = { AuditJobManager }

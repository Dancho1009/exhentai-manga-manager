const path = require('path')
const { EventEmitter } = require('events')
const { Worker } = require('worker_threads')
const { nanoid } = require('nanoid')
const {
  AuditReportRepository,
  REPORT_TASK_TYPES,
  TASK_TYPES,
  createIdleState,
  normalizeTaskType
} = require('./report_repository.js')

const ACTIVE_STATUSES = new Set(['running', 'cancelling'])

class AuditWorkspaceManager extends EventEmitter {
  constructor({ storePath, coordinator }) {
    super()
    this.repository = new AuditReportRepository(storePath)
    this.storePath = this.repository.storePath
    this.jobsPath = this.repository.jobsPath
    this.coordinator = coordinator
    this.states = Object.fromEntries(TASK_TYPES.map(taskType => [taskType, createIdleState(taskType)]))
    this.activeTask = null
    this.worker = null
    this.executionController = null
    this.activePromise = null
    this.stateWriteQueue = Promise.resolve()
    this.pendingProgress = null
    this.progressFlushTimer = null
    this.progressFlushInFlight = Promise.resolve()
    this.progressIntervalMs = 100
  }

  async initialize() {
    await this.repository.initialize()
    for (const taskType of TASK_TYPES) {
      const state = await this.repository.loadChannelState(taskType)
      if (ACTIVE_STATUSES.has(state.status)) {
        state.latestJobId = state.activeJobId || state.latestJobId
        state.status = 'interrupted'
        state.phase = 'interrupted'
        state.activeJobId = null
        state.error = state.error || 'Application exited before the task completed'
        this.states[taskType] = await this.repository.saveChannelState(taskType, state)
      } else {
        this.states[taskType] = state
      }
    }
  }

  getState() {
    return {
      schemaVersion: 3,
      activeTask: this.activeTask ? { ...this.activeTask } : null,
      channels: Object.fromEntries(TASK_TYPES.map(taskType => [taskType, { ...this.states[taskType] }])),
      lock: this.coordinator.getState()
    }
  }

  getChannelState(taskType) {
    return { ...this.states[normalizeTaskType(taskType)] }
  }

  setChannelState(taskType, patch) {
    normalizeTaskType(taskType)
    const operation = this.stateWriteQueue.then(async () => {
      const next = await this.repository.saveChannelState(taskType, { ...this.states[taskType], ...patch })
      this.states[taskType] = next
      const state = this.getState()
      this.emit('state', state)
      return state
    })
    this.stateWriteQueue = operation.catch(() => {})
    return operation
  }

  queueProgress(taskType, patch) {
    this.pendingProgress = { taskType, patch: { ...(this.pendingProgress?.taskType === taskType ? this.pendingProgress.patch : {}), ...patch } }
    if (!this.progressFlushTimer) {
      this.progressFlushTimer = setTimeout(() => {
        this.progressFlushTimer = null
        void this.flushPendingProgress().catch(error => console.error('Flush audit progress failed because', error))
      }, this.progressIntervalMs)
    }
    return Promise.resolve()
  }

  flushPendingProgress() {
    const pending = this.pendingProgress
    this.pendingProgress = null
    if (!pending) return this.progressFlushInFlight
    const operation = this.progressFlushInFlight
      .catch(() => {})
      .then(() => this.setChannelState(pending.taskType, pending.patch))
    this.progressFlushInFlight = operation
    return operation
  }

  async flushProgress() {
    if (this.progressFlushTimer) {
      clearTimeout(this.progressFlushTimer)
      this.progressFlushTimer = null
    }
    await this.flushPendingProgress()
  }

  async appendLog(taskType, jobId, message, level = 'info') {
    const entry = { at: new Date().toISOString(), taskType, jobId, level, message }
    await this.repository.appendJobLog(taskType, jobId, entry)
    this.emit('log', entry)
  }

  ensureIdle() {
    if (this.activeTask || this.worker || this.activePromise) throw new Error('AUDIT_ALREADY_RUNNING')
  }

  async startAnomaly(options) {
    return await this.startWorker('anomaly', 'anomaly_worker.js', options)
  }

  async startDedupe(options) {
    return await this.startWorker('dedupe', 'dedupe_worker.js', options)
  }

  async startWorker(taskType, workerFilename, options) {
    normalizeTaskType(taskType, REPORT_TASK_TYPES)
    this.ensureIdle()
    const jobId = `${new Date().toISOString().replace(/[:.]/g, '-')}_${nanoid(8)}`
    this.coordinator.beginAudit(jobId)
    this.activeTask = { type: taskType, jobId }
    let worker
    try {
      const jobDir = await this.repository.createJob(taskType, jobId)
      await this.setChannelState(taskType, {
        activeJobId: jobId,
        status: 'running',
        phase: 'starting',
        completed: 0,
        total: 0,
        phaseCompleted: 0,
        phaseTotal: 0,
        error: null,
        options,
        startedAt: new Date().toISOString(),
        completedAt: null
      })
      await this.appendLog(taskType, jobId, taskType === 'anomaly' ? '启动异常检查' : '启动重复检查')
      worker = new Worker(path.join(__dirname, workerFilename), {
        workerData: { jobId, jobDir, options }
      })
    } catch (error) {
      this.activeTask = null
      this.worker = null
      this.coordinator.endAudit(jobId)
      try {
        await this.setChannelState(taskType, {
          activeJobId: null,
          latestJobId: jobId,
          status: 'failed',
          phase: 'failed',
          error: error.stack || error.message,
          completedAt: new Date().toISOString()
        })
      } catch (stateError) {
        console.error(`Persist ${taskType} startup failure failed because`, stateError)
        this.emit('state', this.getState())
      }
      throw error
    }
    this.worker = worker
    this.bindWorker(worker, taskType, jobId)
    return this.getState()
  }

  bindWorker(worker, taskType, jobId) {
    let terminalHandling = false
    const finalize = async (outcome, payload = {}) => {
      if (terminalHandling) return
      terminalHandling = true
      try {
        await this.flushProgress()
        if (outcome === 'completed') {
          const reportState = await this.repository.activateReport(taskType, jobId, payload.reportPath, payload.summary)
          await this.setChannelState(taskType, {
            ...reportState,
            activeJobId: null,
            latestJobId: jobId,
            status: 'completed',
            phase: 'completed',
            completed: payload.completed ?? this.states[taskType].total,
            total: payload.total ?? this.states[taskType].total,
            phaseCompleted: payload.phaseCompleted ?? this.states[taskType].phaseTotal,
            phaseTotal: payload.phaseTotal ?? this.states[taskType].phaseTotal,
            completedAt: new Date().toISOString(),
            error: null
          })
          await this.appendLog(taskType, jobId, '检查完成')
        } else if (outcome === 'cancelled') {
          await this.setChannelState(taskType, {
            activeJobId: null,
            latestJobId: jobId,
            status: 'interrupted',
            phase: 'cancelled',
            completedAt: new Date().toISOString(),
            error: null
          })
          await this.appendLog(taskType, jobId, '检查已停止', 'warning')
        } else {
          const error = payload.error instanceof Error ? payload.error.stack || payload.error.message : String(payload.error || 'Audit worker failed')
          await this.setChannelState(taskType, {
            activeJobId: null,
            latestJobId: jobId,
            status: 'failed',
            phase: 'failed',
            error,
            completedAt: new Date().toISOString()
          })
          await this.appendLog(taskType, jobId, error, 'error')
        }
      } catch (error) {
        console.error(`Finalize ${taskType} audit failed because`, error)
        try {
          await this.setChannelState(taskType, {
            activeJobId: null,
            latestJobId: jobId,
            status: 'failed',
            phase: 'failed',
            error: error.stack || error.message,
            completedAt: new Date().toISOString()
          })
        } catch (stateError) {
          console.error(`Persist ${taskType} audit failure state failed because`, stateError)
        }
      } finally {
        this.finishActive(jobId)
      }
    }
    const handleMessage = async message => {
      if (terminalHandling || this.activeTask?.jobId !== jobId) return
      if (message.type === 'progress') {
        await this.queueProgress(taskType, {
          phase: message.phase,
          completed: message.completed ?? message.overallCompleted ?? 0,
          total: message.total ?? message.overallTotal ?? 0,
          phaseCompleted: message.phaseCompleted ?? message.completed ?? 0,
          phaseTotal: message.phaseTotal ?? message.total ?? 0
        })
      } else if (message.type === 'log') {
        await this.appendLog(taskType, jobId, message.message, message.level || 'info')
      } else if (message.type === 'completed') {
        await finalize('completed', message)
      } else if (message.type === 'cancelled') {
        await finalize('cancelled')
      } else if (message.type === 'failed') {
        await finalize('failed', { error: message.error })
      }
    }
    worker.on('message', message => {
      void handleMessage(message).catch(error => finalize('failed', { error }))
    })
    worker.on('error', error => {
      void finalize('failed', { error })
    })
    worker.on('exit', code => {
      if (!terminalHandling) {
        const error = code === 0
          ? 'Audit worker exited without a terminal message'
          : `Audit worker exited with code ${code}`
        void finalize('failed', { error })
      }
    })
  }

  finishActive(jobId) {
    if (this.activeTask?.jobId !== jobId) return
    this.worker = null
    this.executionController = null
    this.activePromise = null
    this.activeTask = null
    this.coordinator.endAudit(jobId)
    this.emit('state', this.getState())
  }

  async runExecution(task) {
    this.ensureIdle()
    const taskType = 'execution'
    const jobId = `${new Date().toISOString().replace(/[:.]/g, '-')}_${nanoid(8)}`
    this.coordinator.beginAudit(jobId)
    this.activeTask = { type: taskType, jobId }
    this.executionController = new AbortController()
    let jobDir
    try {
      jobDir = await this.repository.createJob(taskType, jobId)
      await this.setChannelState(taskType, {
        activeJobId: jobId,
        status: 'running',
        phase: 'preparing-execution',
        completed: 0,
        total: 0,
        phaseCompleted: 0,
        phaseTotal: 0,
        error: null,
        startedAt: new Date().toISOString(),
        completedAt: null
      })
      await this.appendLog(taskType, jobId, '开始执行已批准项目')
    } catch (error) {
      this.executionController = null
      this.activeTask = null
      this.coordinator.endAudit(jobId)
      try {
        await this.setChannelState(taskType, {
          activeJobId: null,
          latestJobId: jobId,
          status: 'failed',
          phase: 'failed',
          error: error.stack || error.message,
          completedAt: new Date().toISOString()
        })
      } catch (stateError) {
        console.error('Persist execution startup failure failed because', stateError)
        this.emit('state', this.getState())
      }
      throw error
    }
    const operation = (async () => {
      try {
        const result = await task({
          executionId: jobId,
          executionDir: jobDir,
          isCancelled: () => this.executionController?.signal.aborted === true,
          setProgress: patch => this.setChannelState(taskType, patch),
          appendLog: (message, level) => this.appendLog(taskType, jobId, message, level)
        })
        await this.setChannelState(taskType, {
          activeJobId: null,
          latestJobId: jobId,
          status: 'completed',
          phase: 'verified',
          completedAt: new Date().toISOString(),
          error: null,
          summary: result
        })
        await this.appendLog(taskType, jobId, '执行完成')
        return result
      } catch (error) {
        const cancelled = error?.message === 'AUDIT_CANCELLED'
        await this.setChannelState(taskType, {
          activeJobId: null,
          latestJobId: jobId,
          status: cancelled ? 'interrupted' : 'failed',
          phase: cancelled ? 'cancelled' : 'failed',
          error: cancelled ? null : error.stack || error.message,
          completedAt: new Date().toISOString()
        })
        await this.appendLog(taskType, jobId, cancelled ? '执行已停止' : error.stack || error.message, cancelled ? 'warning' : 'error')
        throw error
      } finally {
        this.finishActive(jobId)
      }
    })()
    this.activePromise = operation
    return await operation
  }

  async cancelActive() {
    if (!this.activeTask) return this.getState()
    const { type } = this.activeTask
    if (this.states[type].status !== 'running') return this.getState()
    await this.flushProgress()
    await this.setChannelState(type, { status: 'cancelling', phase: 'cancelling' })
    if (this.worker) this.worker.postMessage({ type: 'cancel' })
    if (this.executionController) this.executionController.abort()
    return this.getState()
  }

  async interruptForExit(timeoutMs = 5000) {
    if (!this.activeTask) return
    const task = this.activeTask
    if (this.worker) this.worker.postMessage({ type: 'cancel' })
    if (this.executionController) this.executionController.abort()
    await this.flushProgress()
    await Promise.race([
      this.worker
        ? new Promise(resolve => this.worker.once('exit', resolve))
        : this.activePromise?.catch(() => {}) || Promise.resolve(),
      new Promise(resolve => setTimeout(resolve, timeoutMs))
    ])
    if (this.worker) await this.worker.terminate().catch(() => {})
    if (this.activeTask?.jobId === task.jobId) {
      await this.setChannelState(task.type, {
        activeJobId: null,
        latestJobId: task.jobId,
        status: 'interrupted',
        phase: 'interrupted',
        completedAt: new Date().toISOString()
      })
      this.finishActive(task.jobId)
    }
  }

  async getReport(taskType) {
    normalizeTaskType(taskType, REPORT_TASK_TYPES)
    return await this.repository.getReport(taskType, this.states[taskType])
  }

  async getReview(taskType) {
    normalizeTaskType(taskType, REPORT_TASK_TYPES)
    return await this.repository.getReview(taskType, this.states[taskType])
  }

  async saveReview(taskType, review) {
    normalizeTaskType(taskType, REPORT_TASK_TYPES)
    return await this.repository.saveReview(taskType, this.states[taskType], review)
  }

  async getLogs(limit = 400) {
    const perJobLimit = Math.max(20, Math.min(1000, Number(limit) || 400))
    const requests = []
    for (const taskType of TASK_TYPES) {
      const state = this.states[taskType]
      const jobIds = [...new Set([state.activeJobId, state.latestJobId, state.latestCompletedJobId].filter(Boolean))]
      for (const jobId of jobIds) requests.push(this.repository.getJobLogs(taskType, jobId, perJobLimit))
    }
    return (await Promise.all(requests))
      .flat()
      .sort((left, right) => String(left.at || '').localeCompare(String(right.at || '')))
      .slice(-perJobLimit)
  }
}

module.exports = {
  AuditWorkspaceManager,
  AuditJobManager: AuditWorkspaceManager,
  ACTIVE_STATUSES
}

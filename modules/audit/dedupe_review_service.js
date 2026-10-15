const fs = require('fs')
const path = require('path')
const { Worker } = require('worker_threads')
const { randomUUID } = require('crypto')
const { pathToFileURL } = require('url')
const { compareBookEvidence } = require('./dedupe_comparison.js')
const { readJson } = require('./utils.js')

class DedupeReviewService {
  constructor({ manager, previewRoot, sevenZipPath }) {
    this.manager = manager
    this.previewRoot = previewRoot
    this.sevenZipPath = sevenZipPath
    this.sessions = new Map()
  }
  async getGroup(request) {
    const report = await this.manager.getReport('dedupe')
    if (report?.reportId !== request.reportId) throw new Error('DEDUPE_REVIEW_MISMATCH')
    const group = report.groups.find(item => item.id === request.groupId)
    if (!group) throw new Error('DUPLICATE_GROUP_MISSING')
    return group
  }
  async getComparison(request) {
    const group = await this.getGroup(request)
    const members = [request.leftId, request.rightId].map(id => group.items.find(item => String(item.id) === String(id)))
    if (members.some(item => !item)) throw new Error('DUPLICATE_MEMBER_MISSING')
    const evidence = await Promise.all(members.map(item => this.manager.repository.getDedupeEvidence(item)))
    return { groupId: group.id, left: evidence[0]?.inspection || null, right: evidence[1]?.inspection || null,
      comparison: compareBookEvidence(evidence[0]?.inspection, evidence[1]?.inspection) }
  }
  async enrichExecutionPreview(preview) {
    preview.files = await Promise.all(preview.files.map(async file => {
      const group = await this.getGroup({ reportId: preview.reportId, groupId: file.groupId })
      const removed = group.items.find(item => item.filepath === file.source)
      const detail = await this.getComparison({ reportId: preview.reportId, groupId: file.groupId, leftId: file.keepId, rightId: removed.id })
      return { ...file, uniquePages: detail.comparison.onlyRight.length,
        ancillaryLoss: detail.comparison.ancillary.filter(entry => entry.right && entry.status !== 'same').map(entry => ({ path: entry.path, status: entry.status })) }
    }))
    return preview
  }
  async cleanup(ownerId) {
    const session = this.sessions.get(ownerId)
    if (!session) return
    this.sessions.delete(ownerId)
    Atomics.store(new Int32Array(session.cancelBuffer), 0, 1)
    await session.done.catch(() => {})
    await fs.promises.rm(session.outputDir, { recursive: true, force: true })
  }
  async preview(ownerId, request) {
    // Reserve the owner before asynchronous evidence reads so rapid requests
    // cancel the preceding generation even if it has not started its worker.
    const outputDir = path.join(this.previewRoot, String(ownerId), randomUUID())
    const cancelBuffer = new SharedArrayBuffer(4)
    const previous = this.sessions.get(ownerId)
    if (previous) Atomics.store(new Int32Array(previous.cancelBuffer), 0, 1)
    const session = { outputDir, cancelBuffer, done: Promise.resolve() }
    this.sessions.set(ownerId, session)
    const execute = async () => {
      if (previous) {
        await previous.done.catch(() => {})
        await fs.promises.rm(previous.outputDir, { recursive: true, force: true })
      }
      if (Atomics.load(new Int32Array(cancelBuffer), 0)) throw new Error('AUDIT_CANCELLED')
      const group = await this.getGroup(request)
      const entries = []
      for (const [side, id, index] of [['left', request.leftId, request.leftIndex], ['right', request.rightId, request.rightIndex]]) {
        const book = group.items.find(item => String(item.id) === String(id))
        if (!book) throw new Error('DUPLICATE_MEMBER_MISSING')
        const evidence = await this.manager.repository.getDedupeEvidence(book)
        if (request.textPath) {
          const entry = evidence?.inspection?.ancillary?.find(item => item.path === request.textPath)
          if (entry && /(?:\.ehviewer|\.(txt|json|xml|ya?ml|ini|nfo|md))$/i.test(entry.path)) entries.push({ key: side, book, entry })
        } else if (Number.isInteger(index) && index >= 0) {
          for (const offset of [-1, 0, 1]) {
            const entry = evidence?.inspection?.images?.[index + offset]
            if (entry) entries.push({ key: `${side}-${index + offset}`, book, entry })
          }
        }
      }
      if (Atomics.load(new Int32Array(cancelBuffer), 0)) throw new Error('AUDIT_CANCELLED')
      const worker = new Worker(path.join(__dirname, 'dedupe_preview_worker.js'), { workerData: { entries, outputDir, cancelBuffer, text: Boolean(request.textPath), sevenZipPath: this.sevenZipPath } })
      return await new Promise((resolve, reject) => {
        let result
        worker.on('message', message => { result = message })
        worker.on('error', reject)
        worker.on('exit', code => {
          if (code || !result) reject(new Error('DEDUPE_PREVIEW_FAILED'))
          else if (result.error) reject(new Error(result.error))
          else resolve(result.results.map(item => ({ ...item, url: item.path ? pathToFileURL(item.path).href : undefined })))
        })
      })
    }
    session.done = execute()
    try { return await session.done }
    finally {
      if (Atomics.load(new Int32Array(cancelBuffer), 0)) await fs.promises.rm(outputDir, { recursive: true, force: true })
    }
  }
  async getHistory() {
    const root = this.manager.repository.executionsPath
    const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => [])
    const history = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
      const log = await this.manager.repository.getExecutionActionLog(entry.name)
      const completed = [...log].reverse().find(item => item.status === 'verified' && item.taskType === 'dedupe')
      if (!completed) return null
      const files = log.filter(item => item.status === 'file-verified' && item.type === 'quarantine')
      const statePath = path.join(root, entry.name, 'dedupe-state.json')
      const state = await readJson(statePath)
      return { executionId: entry.name, at: completed.at, movedCount: files.length, files,
        backupDir: path.join(this.manager.repository.storePath, 'backups', entry.name), statePath: state ? statePath : null }
    }))
    return history.filter(Boolean).sort((a, b) => b.executionId.localeCompare(a.executionId))
  }
}
module.exports = { DedupeReviewService }

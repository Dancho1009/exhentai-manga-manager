const fs = require('fs')
const path = require('path')
const { atomicWriteJson, readJson } = require('./utils.js')
const { DEDUPE_RULES_VERSION } = require('./dedupe_title.js')

const REPORT_SCHEMA_VERSION = 4
const WORKSPACE_SCHEMA_VERSION = 5
const REVIEW_SCHEMA_VERSION = 2
const TASK_TYPES = ['anomaly', 'dedupe', 'execution']
const REPORT_TASK_TYPES = ['anomaly', 'dedupe']

const createIdleState = taskType => ({
  schemaVersion: WORKSPACE_SCHEMA_VERSION,
  taskType,
  activeJobId: null,
  status: 'idle',
  phase: 'idle',
  completed: 0,
  total: 0,
  phaseCompleted: 0,
  phaseTotal: 0,
  phaseStartedAt: null,
  phaseStartCompleted: 0,
  lastWorkPhase: null,
  currentItem: null,
  currentItems: [],
  latestJobId: null,
  latestReportId: null,
  latestReportPath: null,
  latestCompletedJobId: null,
  staleAt: null,
  staleReason: null,
  resolvedReportId: null,
  resolvedAnomalyIds: [],
  error: null,
  summary: null,
  options: null,
  startedAt: null,
  completedAt: null,
  updatedAt: null
})

const normalizeTaskType = (taskType, allowed = TASK_TYPES) => {
  if (!allowed.includes(taskType)) throw new Error(`INVALID_AUDIT_TASK_TYPE: ${taskType}`)
  return taskType
}

const getReportId = (taskType, jobId) => `${taskType}:${jobId}`

const clearLegacyActions = anomaly => ({ ...anomaly, action: null })

const applyResolvedAnomalies = (report, state) => {
  if (report?.reportType !== 'anomaly' || state?.resolvedReportId !== report.reportId) return report
  const resolvedIds = new Set((state.resolvedAnomalyIds || []).map(String))
  if (resolvedIds.size === 0) return report
  const anomalies = (report.anomalies || []).filter(item => !resolvedIds.has(String(item.id)))
  const resolvedCount = (report.anomalies || []).length - anomalies.length
  if (resolvedCount === 0) return report
  return {
    ...report,
    resolvedAnomalies: resolvedCount,
    summary: {
      ...(report.summary || {}),
      anomalies: anomalies.length,
      anomalyBooks: new Set(anomalies.filter(item => item.bookId).map(item => String(item.bookId))).size,
      actionableAnomalies: anomalies.filter(item => item.action).length
    },
    anomalies
  }
}

const toLegacyAnomalyReport = (report, jobId) => {
  const anomalies = (report.anomalies || []).map(clearLegacyActions)
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    reportType: 'anomaly',
    reportId: getReportId('anomaly', jobId),
    jobId,
    legacy: true,
    executable: false,
    createdAt: report.createdAt || new Date().toISOString(),
    source: report.source || {},
    options: {
      forceLocal: false,
      onlinePolicy: report.mode === 'online' ? report.onlineScope || 'conflicts' : 'none',
      forceOnline: false
    },
    summary: {
      libraryItems: report.summary?.libraryItems || 0,
      mangaRows: report.summary?.mangaRows || 0,
      metadataRows: report.summary?.metadataRows || 0,
      anomalies: anomalies.length,
      anomalyBooks: report.summary?.anomalyBooks || new Set(anomalies.filter(item => item.bookId).map(item => String(item.bookId))).size,
      actionableAnomalies: 0,
      onlineIdentities: report.summary?.onlineIdentities || 0,
      onlineAvailable: report.summary?.onlineAvailable || 0,
      onlineCopyright: report.summary?.onlineCopyright || 0
    },
    anomalies,
    onlineChecks: report.onlineChecks || []
  }
}

const toLegacyDedupeReport = (report, jobId) => ({
  schemaVersion: REPORT_SCHEMA_VERSION,
  reportType: 'dedupe',
  reportId: getReportId('dedupe', jobId),
  jobId,
  legacy: true,
  executable: false,
  createdAt: report.createdAt || new Date().toISOString(),
  source: report.source || {},
  options: { forceContent: false },
  summary: {
    libraryItems: report.summary?.libraryItems || 0,
    mangaRows: report.summary?.mangaRows || 0,
    metadataRows: report.summary?.metadataRows || 0,
    duplicateGroups: (report.duplicates || []).length,
    eligibleDuplicateGroups: report.summary?.eligibleDuplicateGroups || (report.duplicates || []).filter(item => item.eligible).length,
    excludedItems: 0,
    potentialBytes: report.summary?.potentialBytes || 0
  },
  groups: report.duplicates || [],
  excludedItems: []
})

class AuditReportRepository {
  constructor(storePath) {
    this.storePath = path.join(storePath, 'audit')
    this.channelsPath = path.join(this.storePath, 'channels')
    this.jobsPath = path.join(this.storePath, 'jobs')
    this.executionsPath = path.join(this.storePath, 'executions')
    this.migrationPath = path.join(this.storePath, 'migration-v3.json')
    this.reportCache = new Map()
  }

  async initialize() {
    await Promise.all([
      fs.promises.mkdir(this.channelsPath, { recursive: true }),
      fs.promises.mkdir(path.join(this.jobsPath, 'anomaly'), { recursive: true }),
      fs.promises.mkdir(path.join(this.jobsPath, 'dedupe'), { recursive: true }),
      fs.promises.mkdir(this.executionsPath, { recursive: true })
    ])
    await this.migrateLegacyReports()
  }

  getChannelStatePath(taskType) {
    return path.join(this.channelsPath, `${normalizeTaskType(taskType)}-state.json`)
  }

  getJobDir(taskType, jobId) {
    normalizeTaskType(taskType)
    if (!jobId) throw new Error('AUDIT_JOB_ID_MISSING')
    return taskType === 'execution'
      ? path.join(this.executionsPath, jobId)
      : path.join(this.jobsPath, taskType, jobId)
  }

  async createJob(taskType, jobId) {
    const jobDir = this.getJobDir(taskType, jobId)
    await fs.promises.mkdir(jobDir, { recursive: true })
    return jobDir
  }

  async clearInspectionRecords() {
    this.reportCache.clear()
    await Promise.all([
      fs.promises.rm(this.channelsPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
      fs.promises.rm(this.jobsPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
      fs.promises.rm(path.join(this.storePath, 'audit-log.jsonl'), { force: true }),
      fs.promises.rm(path.join(this.storePath, 'dedupe-review-history.json'), { force: true })
    ])
    await Promise.all([
      fs.promises.mkdir(this.channelsPath, { recursive: true }),
      fs.promises.mkdir(path.join(this.jobsPath, 'anomaly'), { recursive: true }),
      fs.promises.mkdir(path.join(this.jobsPath, 'dedupe'), { recursive: true })
    ])
  }

  async loadChannelState(taskType) {
    const fallback = createIdleState(normalizeTaskType(taskType))
    return { ...fallback, ...(await readJson(this.getChannelStatePath(taskType), fallback)) }
  }

  async saveChannelState(taskType, state) {
    const value = {
      ...createIdleState(normalizeTaskType(taskType)),
      ...state,
      schemaVersion: WORKSPACE_SCHEMA_VERSION,
      taskType,
      updatedAt: new Date().toISOString()
    }
    await atomicWriteJson(this.getChannelStatePath(taskType), value)
    return value
  }

  async activateReport(taskType, jobId, reportPath, summary) {
    const report = await readJson(reportPath)
    if (!report || report.reportType !== taskType || report.jobId !== jobId) {
      throw new Error(`AUDIT_REPORT_IDENTITY_MISMATCH: ${taskType}:${jobId}`)
    }
    this.reportCache.delete(taskType)
    return {
      latestReportId: report.reportId,
      latestReportPath: reportPath,
      latestCompletedJobId: jobId,
      summary: summary || report.summary || null,
      staleAt: null,
      staleReason: null,
      resolvedReportId: null,
      resolvedAnomalyIds: []
    }
  }

  async getReport(taskType, state) {
    normalizeTaskType(taskType, REPORT_TASK_TYPES)
    const reportPath = state?.latestReportPath
    if (!reportPath) return null
    const stat = await fs.promises.stat(reportPath).catch(() => null)
    if (!stat) return null
    const cached = this.reportCache.get(taskType)
    const value = cached?.path === reportPath && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size
      ? cached.value
      : await readJson(reportPath)
    if (value !== cached?.value) this.reportCache.set(taskType, { path: reportPath, mtimeMs: stat.mtimeMs, size: stat.size, value })
    const visibleReport = applyResolvedAnomalies(value, state)
    if (visibleReport?.reportType === 'dedupe' && visibleReport.schemaVersion < 4) return { ...visibleReport, legacy: true, executable: false }
    if (visibleReport?.reportType === 'dedupe' && visibleReport.dedupeVersion >= 2 && visibleReport.dedupeRulesVersion !== DEDUPE_RULES_VERSION) {
      return { ...visibleReport, outdatedRules: true, executable: false }
    }
    return state?.staleAt
      ? { ...visibleReport, stale: true, staleAt: state.staleAt, staleReason: state.staleReason, executable: false }
      : visibleReport
  }

  async getReview(taskType, state) {
    normalizeTaskType(taskType, REPORT_TASK_TYPES)
    if (!state?.latestCompletedJobId || !state.latestReportId) return null
    const fallback = taskType === 'anomaly'
      ? { schemaVersion: REVIEW_SCHEMA_VERSION, taskType, reportId: state.latestReportId, actionIds: [], manualActions: {} }
      : { schemaVersion: REVIEW_SCHEMA_VERSION, taskType, reportId: state.latestReportId, selections: {}, decisions: {}, quarantineRoot: '' }
    const reviewPath = path.join(this.getJobDir(taskType, state.latestCompletedJobId), 'review.json')
    let review = await readJson(reviewPath)
    if (!review) {
      review = fallback
      if (taskType === 'dedupe') {
        const report = await this.getReport(taskType, state)
        review.decisions = await require('./dedupe_review_repository.js').loadDedupeDecisions(this.storePath, report || {})
      }
    }
    return review?.reportId === state.latestReportId ? { ...fallback, ...review } : fallback
  }

  async saveReview(taskType, state, review) {
    normalizeTaskType(taskType, REPORT_TASK_TYPES)
    if (!state?.latestCompletedJobId || !state.latestReportId) throw new Error('AUDIT_REPORT_MISSING')
    const value = taskType === 'anomaly'
      ? {
          schemaVersion: REVIEW_SCHEMA_VERSION,
          taskType,
          reportId: state.latestReportId,
          actionIds: [...new Set((review?.actionIds || []).map(String))],
          manualActions: review?.manualActions && typeof review.manualActions === 'object' ? review.manualActions : {},
          updatedAt: new Date().toISOString()
        }
      : {
          schemaVersion: REVIEW_SCHEMA_VERSION,
          taskType,
          reportId: state.latestReportId,
          selections: review?.selections && typeof review.selections === 'object' ? review.selections : {},
          decisions: review?.decisions && typeof review.decisions === 'object' ? review.decisions : {},
          quarantineRoot: String(review?.quarantineRoot || ''),
          updatedAt: new Date().toISOString()
        }
    await atomicWriteJson(path.join(this.getJobDir(taskType, state.latestCompletedJobId), 'review.json'), value)
    if (taskType === 'dedupe') {
      const report = await this.getReport(taskType, state)
      await require('./dedupe_review_repository.js').saveDedupeDecisions(this.storePath, value.decisions, (report?.groups || []).map(group => group.id))
    }
    return value
  }

  async getDedupeEvidence(item) {
    const reference = item?.evidenceRef
    if (!reference || !/^[a-f0-9]{40}\.json$/.test(reference.filename) || !/^[\w-][\w.-]*$/.test(reference.jobId)) return null
    return await readJson(path.join(this.getJobDir('dedupe', reference.jobId), 'evidence', reference.filename))
  }

  async appendJobLog(taskType, jobId, entry) {
    const jobDir = await this.createJob(taskType, jobId)
    await fs.promises.appendFile(path.join(jobDir, 'log.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8')
  }

  async getJobLogs(taskType, jobId, limit = 400) {
    if (!jobId) return []
    const content = await fs.promises.readFile(path.join(this.getJobDir(taskType, jobId), 'log.jsonl'), 'utf8').catch(() => '')
    const lines = content.split(/\r?\n/).filter(Boolean).slice(-Math.max(1, Number(limit) || 400))
    return lines.flatMap(line => {
      try {
        const entry = JSON.parse(line)
        return entry && typeof entry === 'object' ? [entry] : []
      } catch {
        return []
      }
    })
  }

  async getExecutionActionLog(jobId) {
    if (!jobId) return []
    const content = await fs.promises.readFile(path.join(this.getJobDir('execution', jobId), 'action-audit.jsonl'), 'utf8').catch(() => '')
    return content.split(/\r?\n/).filter(Boolean).flatMap(line => {
      try {
        const entry = JSON.parse(line)
        return entry && typeof entry === 'object' ? [entry] : []
      } catch {
        return []
      }
    })
  }

  async migrateLegacyReports() {
    if (await readJson(this.migrationPath)) return
    const entries = await fs.promises.readdir(this.jobsPath, { withFileTypes: true }).catch(() => [])
    const legacy = []
    for (const entry of entries) {
      if (!entry.isDirectory() || REPORT_TASK_TYPES.includes(entry.name)) continue
      const legacyDir = path.join(this.jobsPath, entry.name)
      const state = await readJson(path.join(legacyDir, 'state.json'))
      const report = await readJson(path.join(legacyDir, 'report.json'))
      if (state && report) legacy.push({ jobId: entry.name, state, report })
    }
    legacy.sort((left, right) => String(right.state.updatedAt || right.report.createdAt || '').localeCompare(String(left.state.updatedAt || left.report.createdAt || '')))

    const newestAnomaly = legacy.find(item => ['quick', 'deep', 'online'].includes(item.report.mode || item.state.mode))
    const newestDedupe = legacy.find(item => (item.report.duplicates || []).length > 0 || (item.report.mode || item.state.mode) === 'deep')
    if (newestAnomaly) await this.migrateLegacyReport('anomaly', newestAnomaly, toLegacyAnomalyReport)
    if (newestDedupe) await this.migrateLegacyReport('dedupe', newestDedupe, toLegacyDedupeReport)
    await atomicWriteJson(this.migrationPath, {
      schemaVersion: REPORT_SCHEMA_VERSION,
      migratedAt: new Date().toISOString(),
      legacyJobCount: legacy.length,
      anomalyJobId: newestAnomaly?.jobId || null,
      dedupeJobId: newestDedupe?.jobId || null
    })
  }

  async migrateLegacyReport(taskType, legacy, converter) {
    const jobId = `legacy-${legacy.jobId}`
    const jobDir = await this.createJob(taskType, jobId)
    const reportPath = path.join(jobDir, 'report.json')
    const report = converter(legacy.report, jobId)
    await atomicWriteJson(reportPath, report)
    const state = await this.loadChannelState(taskType)
    if (!state.latestReportPath) {
      await this.saveChannelState(taskType, {
        ...state,
        status: 'completed',
        phase: 'completed',
        latestJobId: jobId,
        latestReportId: report.reportId,
        latestReportPath: reportPath,
        latestCompletedJobId: jobId,
        summary: report.summary,
        completedAt: report.createdAt
      })
    }
  }
}

module.exports = {
  AuditReportRepository,
  REPORT_SCHEMA_VERSION,
  WORKSPACE_SCHEMA_VERSION,
  REVIEW_SCHEMA_VERSION,
  TASK_TYPES,
  REPORT_TASK_TYPES,
  createIdleState,
  normalizeTaskType,
  getReportId
}

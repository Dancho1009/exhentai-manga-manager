const fs = require('fs')
const path = require('path')
const { atomicWriteJson, readJson, normalizePath, stableId, extractMetadataSourceIdentity } = require('./utils.js')
const { MANUAL_SOURCE_ANOMALY_TYPES } = require('./manual_source_action.js')

const IDENTITY_ANOMALY_TYPES = new Set(['filename-url-id-conflict', 'ehviewer-url-conflict', 'ehviewer-url-conflict-online'])
const confirmationFile = storePath => path.join(storePath, 'source-confirmations.json')
const confirmationKey = book => `${String(book.id)}:${normalizePath(book.filepath)}`
const markerFingerprint = marker => stableId(
  marker?.status || 'absent', marker?.entryPath || null, marker?.candidateCount || 0,
  marker?.gid ? String(marker.gid) : null, marker?.token ? String(marker.token).toLowerCase() : null
)

const buildSourceConfirmation = ({ book, stat, ehviewer, executionId, confirmedAt = new Date().toISOString() }) => {
  const identity = extractMetadataSourceIdentity(book.url)
  if (!identity || !Number.isFinite(stat?.size) || !Number.isFinite(stat?.mtimeMs)) return null
  return {
    bookId: String(book.id), filepath: normalizePath(book.filepath), hash: book.hash || null,
    size: stat.size, mtimeMs: stat.mtimeMs, identity,
    markerFingerprint: markerFingerprint(ehviewer), executionId, confirmedAt
  }
}

const matchesSourceConfirmation = (record, { book, stat, ehviewer }) => {
  const current = buildSourceConfirmation({ book, stat, ehviewer })
  return Boolean(current && record && record.bookId === current.bookId && record.filepath === current.filepath &&
    record.hash === current.hash && record.size === current.size && Math.abs(record.mtimeMs - current.mtimeMs) <= 1 &&
    stableId(record.identity) === stableId(current.identity) && record.markerFingerprint === current.markerFingerprint)
}

const loadSourceConfirmations = async storePath => {
  try {
    const value = JSON.parse(await fs.promises.readFile(confirmationFile(storePath), 'utf8'))
    if (value.schemaVersion !== 1 || !Array.isArray(value.confirmations)) throw new Error('SOURCE_CONFIRMATION_STORE_INVALID')
    return new Map(value.confirmations.map(record => [confirmationKey({ id: record.bookId, filepath: record.filepath }), record]))
  } catch (error) {
    if (error.code === 'ENOENT') return new Map()
    throw error
  }
}

const saveSourceConfirmations = async (storePath, records) => {
  if (!records.length) return
  const confirmations = await loadSourceConfirmations(storePath)
  for (const record of records) confirmations.set(confirmationKey({ id: record.bookId, filepath: record.filepath }), record)
  await atomicWriteJson(confirmationFile(storePath), { schemaVersion: 1, confirmations: [...confirmations.values()] })
}

// Recover only committed, explicitly selected sources. Legacy logs have no
// source snapshot, so accept unchanged current URLs with matching report evidence.
const restoreSourceConfirmations = async ({ storePath, books, healthById, confirmations, persist = true }) => {
  const state = await readJson(path.join(storePath, 'channels', 'execution-state.json'))
  const reportId = state?.options?.reportId
  if (state?.status !== 'completed' || state.options?.sourceTaskType !== 'anomaly' || !reportId?.startsWith('anomaly:')) return 0
  const jobId = state.latestJobId
  if (!jobId || path.basename(jobId) !== jobId) return 0
  const reportJobId = reportId.slice('anomaly:'.length)
  if (path.basename(reportJobId) !== reportJobId) return 0
  const report = await readJson(path.join(storePath, 'jobs', 'anomaly', reportJobId, 'report.json'))
  if (report?.reportId !== reportId) return 0
  const log = await fs.promises.readFile(path.join(storePath, 'executions', jobId, 'action-audit.jsonl'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  const entries = log.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  const verifiedIndex = entries.findLastIndex(entry => entry.status === 'verified' && entry.taskType === 'anomaly')
  if (verifiedIndex < 0 || entries.slice(verifiedIndex + 1).some(entry => entry.status === 'failed')) return 0
  const prepared = entries.slice(0, verifiedIndex).filter(entry => entry.status === 'prepared')
  if (prepared.length !== entries[verifiedIndex].repairedCount) return 0
  const byId = new Map(books.map(wrapped => [String(wrapped.raw.id), wrapped]))
  const anomalies = new Map((report.anomalies || []).map(item => [String(item.id), item]))
  const restored = []
  for (const entry of prepared) {
    const wrapped = byId.get(String(entry.bookId))
    const health = healthById.get(String(entry.bookId))
    if (!wrapped?.actual || !health || confirmations.has(confirmationKey(wrapped.raw))) continue
    const context = { book: { ...wrapped.raw, url: wrapped.effective.url }, stat: wrapped.actual, ehviewer: health.ehviewer }
    let record = entry.sourceConfirmation
    if (!record) {
      const anomaly = anomalies.get(String(entry.anomalyId))
      if (entry.type !== 'repair-url' || anomaly?.action || !MANUAL_SOURCE_ANOMALY_TYPES.has(anomaly?.type) ||
        entry.oldUrl !== entry.newUrl || entry.newUrl !== wrapped.effective.url ||
        normalizePath(anomaly.filepath) !== normalizePath(wrapped.raw.filepath) || wrapped.actual.mtimeMs > Date.parse(entry.at)) continue
      const reportedMarker = anomaly.evidence?.ehviewer || report.anomalies.find(item =>
        String(item.bookId) === String(entry.bookId) && item.evidence?.ehviewer)?.evidence.ehviewer
      if (markerFingerprint(reportedMarker) !== markerFingerprint(health.ehviewer)) continue
      record = buildSourceConfirmation({ ...context, executionId: jobId, confirmedAt: entry.at })
    }
    if (!matchesSourceConfirmation(record, context)) continue
    confirmations.set(confirmationKey(wrapped.raw), record)
    restored.push(record)
  }
  if (persist) await saveSourceConfirmations(storePath, restored)
  return restored.length
}

module.exports = {
  IDENTITY_ANOMALY_TYPES, confirmationKey, buildSourceConfirmation, matchesSourceConfirmation,
  loadSourceConfirmations, saveSourceConfirmations, restoreSourceConfirmations
}

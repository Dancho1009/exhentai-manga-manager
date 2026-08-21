const { buildGalleryUrl, extractGalleryIdentity } = require('../ehentai.js')

const MANUAL_SOURCE_ANOMALY_TYPES = new Set([
  'unverified-page-mismatch',
  'ehviewer-url-conflict-online',
  'filename-url-id-conflict'
])

const normalizeSource = value => value === 'ehviewer' ? 'ehviewer' : value === 'current' ? 'current' : null

const getEhviewerUrl = anomaly => {
  const identity = anomaly?.evidence?.ehviewer
  if (!identity?.gid || !identity?.token) return null
  return buildGalleryUrl('exhentai', identity.gid, identity.token)
}

const buildManualSourceAction = ({ anomaly, source, actual } = {}) => {
  const normalizedSource = normalizeSource(source)
  if (!anomaly?.id || !MANUAL_SOURCE_ANOMALY_TYPES.has(anomaly.type)) {
    throw new Error('MANUAL_SOURCE_SELECTION_UNSUPPORTED')
  }
  if (!normalizedSource) throw new Error('MANUAL_SOURCE_SELECTION_INVALID')

  const currentUrl = String(anomaly.evidence?.currentUrl || anomaly.evidence?.url || '').trim() || null
  const ehviewerUrl = getEhviewerUrl(anomaly)
  const newUrl = normalizedSource === 'current' ? currentUrl : ehviewerUrl
  if (!newUrl || !extractGalleryIdentity(newUrl)) throw new Error('MANUAL_SOURCE_URL_MISSING')
  if (!actual?.filepath || !Number.isFinite(Number(actual.bundleSize)) || !actual.mtimeMs) {
    throw new Error('MANUAL_SOURCE_FILE_SNAPSHOT_MISSING')
  }

  return {
    type: 'repair-url',
    repairKind: 'manual-source-selection',
    source: normalizedSource,
    anomalyId: String(anomaly.id),
    bookId: anomaly.bookId ? String(anomaly.bookId) : null,
    filepath: actual.filepath,
    expectedSize: actual.bundleSize,
    expectedMtimeMs: actual.mtimeMs,
    currentUrl,
    newUrl,
    reason: normalizedSource === 'current' ? '人工选择当前 URL 来源' : '人工选择 .ehviewer 来源'
  }
}

const getManualSourceCandidateUrls = anomaly => ({
  current: String(anomaly?.evidence?.currentUrl || anomaly?.evidence?.url || '').trim() || null,
  ehviewer: getEhviewerUrl(anomaly)
})

module.exports = {
  MANUAL_SOURCE_ANOMALY_TYPES,
  normalizeSource,
  getManualSourceCandidateUrls,
  buildManualSourceAction
}

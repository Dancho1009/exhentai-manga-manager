const path = require('path')
const { extractGalleryIdentity, normalizePath } = require('./utils.js')

const SUPPORTED_ANOMALY_ACTIONS = new Set(['repair-url'])

const normalizeId = value => String(value ?? '').trim()

const ensureMatchingReport = (report, review, taskType) => {
  if (!report?.reportId) throw new Error('AUDIT_REPORT_MISSING')
  if (review?.reportId !== report.reportId) throw new Error(`${taskType.toUpperCase()}_REVIEW_MISMATCH`)
}

const getRepairKind = anomaly => {
  if (anomaly?.action?.repairKind) return anomaly.action.repairKind
  const current = extractGalleryIdentity(anomaly?.action?.currentUrl)
  const candidate = extractGalleryIdentity(anomaly?.action?.newUrl)
  return current && candidate && current.gid === candidate.gid && current.token === candidate.token
    ? 'same-identity-domain-switch'
    : 'identity-replacement'
}

const normalizeAnomalyReview = (report, review = {}) => {
  ensureMatchingReport(report, review, 'anomaly')
  const actionIds = [...new Set((review.actionIds || []).map(normalizeId).filter(Boolean))]
  if (actionIds.length > 0 && report.executable === false) throw new Error('ANOMALY_REPORT_NOT_EXECUTABLE')

  const actions = new Map((report.anomalies || [])
    .filter(item => item?.action)
    .map(item => [normalizeId(item.id), item]))
  for (const actionId of actionIds) {
    const anomaly = actions.get(actionId)
    if (!anomaly) throw new Error(`ANOMALY_ACTION_MISSING: ${actionId}`)
    if (!SUPPORTED_ANOMALY_ACTIONS.has(anomaly.action.type)) {
      throw new Error(`UNSUPPORTED_ANOMALY_ACTION: ${anomaly.action.type}`)
    }
  }

  return {
    reportId: report.reportId,
    actionIds
  }
}

const normalizeDedupeReview = (report, review = {}) => {
  ensureMatchingReport(report, review, 'dedupe')
  const rawSelections = review.selections && typeof review.selections === 'object' ? review.selections : {}
  if (Object.keys(rawSelections).length > 0 && report.executable === false) throw new Error('DEDUPE_REPORT_NOT_EXECUTABLE')

  const groups = new Map((report.groups || []).map(group => [normalizeId(group.id), group]))
  const selections = {}
  const selectedBookIds = new Map()
  for (const [rawGroupId, rawSelection] of Object.entries(rawSelections)) {
    const groupId = normalizeId(rawGroupId)
    const group = groups.get(groupId)
    if (!group) throw new Error(`DUPLICATE_GROUP_MISSING: ${groupId}`)
    if (group.actionable === false) throw new Error(`DUPLICATE_GROUP_NOT_ACTIONABLE: ${groupId}`)

    const itemIds = new Set((group.items || []).map(item => normalizeId(item.id)))
    const keepId = normalizeId(rawSelection?.keepId)
    const quarantineIds = [...new Set((rawSelection?.quarantineIds || []).map(normalizeId).filter(Boolean))]
    if (!itemIds.has(keepId) || quarantineIds.length === 0 || quarantineIds.includes(keepId) || quarantineIds.some(id => !itemIds.has(id))) {
      throw new Error(`INVALID_DUPLICATE_SELECTION: ${groupId}`)
    }

    for (const bookId of [keepId, ...quarantineIds]) {
      const previousGroupId = selectedBookIds.get(bookId)
      if (previousGroupId && previousGroupId !== groupId) {
        throw new Error(`OVERLAPPING_DUPLICATE_SELECTION: ${bookId}:${previousGroupId}:${groupId}`)
      }
      selectedBookIds.set(bookId, groupId)
    }
    selections[groupId] = { keepId, quarantineIds }
  }

  return {
    reportId: report.reportId,
    selections,
    quarantineRoot: String(review.quarantineRoot || '').trim()
  }
}

const normalizeReview = (taskType, report, review) => {
  if (taskType === 'anomaly') return normalizeAnomalyReview(report, review)
  if (taskType === 'dedupe') return normalizeDedupeReview(report, review)
  throw new Error(`INVALID_AUDIT_TASK_TYPE: ${taskType}`)
}

const assertQuarantineRoot = (library, quarantineRoot) => {
  if (!quarantineRoot || !path.isAbsolute(quarantineRoot)) throw new Error('QUARANTINE_PATH_INVALID')
  const normalizedLibrary = normalizePath(library)
  const normalizedQuarantine = normalizePath(quarantineRoot)
  if (normalizedQuarantine === normalizedLibrary || normalizedQuarantine.startsWith(`${normalizedLibrary}${path.sep}`)) {
    throw new Error('QUARANTINE_MUST_BE_OUTSIDE_LIBRARY')
  }
  return path.resolve(quarantineRoot)
}

const buildExecutionPreview = ({ taskType, report, review, library }) => {
  const normalizedReview = normalizeReview(taskType, report, review)
  if (taskType === 'anomaly') {
    const selected = new Set(normalizedReview.actionIds)
    const anomalies = (report.anomalies || []).filter(item => item.action && selected.has(normalizeId(item.id)))
    const sameIdentityCount = anomalies.filter(item => getRepairKind(item) === 'same-identity-domain-switch').length
    const identityReplacementCount = anomalies.length - sameIdentityCount
    if (anomalies.length === 0) throw new Error('NO_APPROVED_ACTIONS')
    return {
      valid: true,
      taskType,
      reportId: report.reportId,
      selectedCount: anomalies.length,
      sameIdentityCount,
      identityReplacementCount
    }
  }

  const selectedGroups = Object.entries(normalizedReview.selections)
  if (selectedGroups.length === 0) throw new Error('NO_APPROVED_ACTIONS')
  const quarantineRoot = assertQuarantineRoot(library, normalizedReview.quarantineRoot)
  let quarantineFileCount = 0
  let potentialBytes = 0
  let manualReviewGroupCount = 0
  for (const [groupId, selection] of selectedGroups) {
    const group = report.groups.find(item => normalizeId(item.id) === groupId)
    const quarantineIds = new Set(selection.quarantineIds)
    quarantineFileCount += quarantineIds.size
    potentialBytes += (group.items || [])
      .filter(item => quarantineIds.has(normalizeId(item.id)))
      .reduce((sum, item) => sum + Number(item.size || 0), 0)
    if (!group.eligible) manualReviewGroupCount += 1
  }
  return {
    valid: true,
    taskType,
    reportId: report.reportId,
    selectedGroupCount: selectedGroups.length,
    quarantineFileCount,
    potentialBytes,
    manualReviewGroupCount,
    quarantineRoot
  }
}

module.exports = {
  SUPPORTED_ANOMALY_ACTIONS,
  normalizeAnomalyReview,
  normalizeDedupeReview,
  normalizeReview,
  getRepairKind,
  assertQuarantineRoot,
  buildExecutionPreview
}

const path = require('path')
const { extractGalleryIdentity, normalizePath } = require('./utils.js')
const { MANUAL_SOURCE_ANOMALY_TYPES } = require('./manual_source_action.js')

const SUPPORTED_ANOMALY_ACTIONS = new Set(['repair-url', 'repair-ehviewer', 'repair-local-scan'])

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

const getAnomalyAction = (anomaly, review = {}) => {
  const manualAction = review?.manualActions?.[normalizeId(anomaly?.id)]
  return manualAction?.type ? manualAction : anomaly?.action || null
}

const normalizeManualActions = (report, review = {}) => {
  const anomalies = new Map((report?.anomalies || []).map(item => [normalizeId(item.id), item]))
  const manualActions = {}
  const rawActions = review.manualActions && typeof review.manualActions === 'object' ? review.manualActions : {}
  for (const [rawId, rawAction] of Object.entries(rawActions)) {
    const id = normalizeId(rawId)
    const anomaly = anomalies.get(id)
    if (!anomaly || !MANUAL_SOURCE_ANOMALY_TYPES.has(anomaly.type)) throw new Error(`MANUAL_SOURCE_ANOMALY_MISSING: ${id}`)
    if (!rawAction || rawAction.type !== 'repair-url' || rawAction.repairKind !== 'manual-source-selection' ||
      !['current', 'ehviewer'].includes(rawAction.source) || String(rawAction.anomalyId) !== id) {
      throw new Error(`INVALID_MANUAL_SOURCE_ACTION: ${id}`)
    }
    const expectedIdentity = rawAction.source === 'current'
      ? extractGalleryIdentity(anomaly.evidence?.currentUrl)
      : extractGalleryIdentity(`https://exhentai.org/g/${anomaly.evidence?.ehviewer?.gid || ''}/${anomaly.evidence?.ehviewer?.token || ''}/`)
    const actionIdentity = extractGalleryIdentity(rawAction.newUrl)
    const actionCurrentIdentity = extractGalleryIdentity(rawAction.currentUrl)
    if (!expectedIdentity || !actionIdentity || expectedIdentity.gid !== actionIdentity.gid || expectedIdentity.token !== actionIdentity.token ||
      (rawAction.source === 'current' && (!actionCurrentIdentity || actionCurrentIdentity.gid !== expectedIdentity.gid || actionCurrentIdentity.token !== expectedIdentity.token))) {
      throw new Error(`INVALID_MANUAL_SOURCE_TARGET: ${id}`)
    }
    manualActions[id] = {
      ...rawAction,
      anomalyId: id,
      bookId: rawAction.bookId ? String(rawAction.bookId) : anomaly.bookId ? String(anomaly.bookId) : null,
      filepath: rawAction.filepath || anomaly.filepath || null
    }
  }
  return manualActions
}

const normalizeAnomalyReview = (report, review = {}) => {
  ensureMatchingReport(report, review, 'anomaly')
  const actionIds = [...new Set((review.actionIds || []).map(normalizeId).filter(Boolean))]
  const manualActions = normalizeManualActions(report, review)
  if (actionIds.length > 0 && report.executable === false) throw new Error('ANOMALY_REPORT_NOT_EXECUTABLE')

  const actions = new Map((report.anomalies || [])
    .map(item => [normalizeId(item.id), item]))
  for (const actionId of actionIds) {
    const anomaly = actions.get(actionId)
    const action = getAnomalyAction(anomaly, { manualActions })
    if (!anomaly || !action) throw new Error(`ANOMALY_ACTION_MISSING: ${actionId}`)
    if (!SUPPORTED_ANOMALY_ACTIONS.has(action.type)) {
      throw new Error(`UNSUPPORTED_ANOMALY_ACTION: ${action.type}`)
    }
  }

  return {
    reportId: report.reportId,
    actionIds,
    manualActions
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
    const anomalies = (report.anomalies || [])
      .map(item => ({ ...item, action: getAnomalyAction(item, normalizedReview) }))
      .filter(item => item.action && selected.has(normalizeId(item.id)))
    const sameIdentityCount = anomalies.filter(item => getRepairKind(item) === 'same-identity-domain-switch').length
    const versionUpgradeCount = anomalies.filter(item => getRepairKind(item) === 'gallery-version-upgrade').length
    const sourceRecoveryCount = anomalies.filter(item => getRepairKind(item) === 'source-recovery').length
    const manualSourceCount = anomalies.filter(item => getRepairKind(item) === 'manual-source-selection').length
    const ehviewerRebuildCount = anomalies.filter(item => item.action?.type === 'repair-ehviewer').length
    const localScanCount = anomalies.filter(item => item.action?.type === 'repair-local-scan').length
    const identityReplacementCount = anomalies.length - sameIdentityCount - versionUpgradeCount - sourceRecoveryCount - manualSourceCount - ehviewerRebuildCount - localScanCount
    if (anomalies.length === 0) throw new Error('NO_APPROVED_ACTIONS')
    return {
      valid: true,
      taskType,
      reportId: report.reportId,
      selectedCount: anomalies.length,
      sameIdentityCount,
      versionUpgradeCount,
      sourceRecoveryCount,
      manualSourceCount,
      ehviewerRebuildCount,
      localScanCount,
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
  getAnomalyAction,
  getRepairKind,
  assertQuarantineRoot,
  buildExecutionPreview
}

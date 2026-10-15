const path = require('path')
const { extractMetadataSourceIdentity, isSameMetadataSource, normalizePath } = require('./utils.js')
const { MANUAL_SOURCE_ANOMALY_TYPES } = require('./manual_source_action.js')
const { getBatchSafeActionIds } = require('./action_policy.js')

const SUPPORTED_ANOMALY_ACTIONS = new Set(['repair-url', 'repair-ehviewer', 'repair-local-scan', 'delete-orphan-metadata'])

const normalizeId = value => String(value ?? '').trim()

const ensureMatchingReport = (report, review, taskType) => {
  if (!report?.reportId) throw new Error('AUDIT_REPORT_MISSING')
  if (review?.reportId !== report.reportId) throw new Error(`${taskType.toUpperCase()}_REVIEW_MISMATCH`)
}

const getRepairKind = anomaly => {
  if (anomaly?.action?.repairKind) return anomaly.action.repairKind
  const current = extractMetadataSourceIdentity(anomaly?.action?.currentUrl)
  const candidate = extractMetadataSourceIdentity(anomaly?.action?.newUrl)
  return isSameMetadataSource(current, candidate)
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
      ? extractMetadataSourceIdentity(anomaly.evidence?.currentUrl || anomaly.evidence?.url)
      : extractMetadataSourceIdentity(`https://exhentai.org/g/${anomaly.evidence?.ehviewer?.gid || ''}/${anomaly.evidence?.ehviewer?.token || ''}/`)
    const actionIdentity = extractMetadataSourceIdentity(rawAction.newUrl)
    const actionCurrentIdentity = extractMetadataSourceIdentity(rawAction.currentUrl)
    if (!isSameMetadataSource(expectedIdentity, actionIdentity) ||
      (rawAction.source === 'current' && !isSameMetadataSource(actionCurrentIdentity, expectedIdentity))) {
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
    if (action.type === 'delete-orphan-metadata' && (
      anomaly.type !== 'orphan-metadata' ||
      normalizeId(action.metadataHash) !== normalizeId(anomaly.metadataHash) ||
      !String(action.expectedFingerprint || '').trim()
    )) {
      throw new Error(`INVALID_ORPHAN_METADATA_ACTION: ${actionId}`)
    }
  }

  return {
    reportId: report.reportId,
    actionIds,
    manualActions
  }
}

const buildSafeAnomalyReview = (report, review = {}) => {
  ensureMatchingReport(report, review, 'anomaly')
  return normalizeAnomalyReview(report, {
    ...review,
    actionIds: getBatchSafeActionIds(report)
  })
}

const normalizeDedupeReview = (report, review = {}) => {
  ensureMatchingReport(report, review, 'dedupe')
  const groups = new Map((report.groups || []).map(group => [normalizeId(group.id), group]))
  const selections = {}
  const decisions = {}
  const participants = new Map()
  const paths = new Map()
  const membersById = new Map((report.groups || []).flatMap(group => group.items.map(item => [normalizeId(item.id), item])))
  const register = (group, keepId, quarantineIds) => {
    if (group.actionable === false) throw new Error('DUPLICATE_GROUP_NOT_ACTIONABLE: ' + group.id)
    if (report.executable === false) throw new Error('DEDUPE_REPORT_NOT_EXECUTABLE')
    const itemIds = new Set(group.items.map(item => normalizeId(item.id)))
    if (!itemIds.has(keepId) || !quarantineIds.length || quarantineIds.includes(keepId) || quarantineIds.some(id => !itemIds.has(id))) throw new Error('INVALID_DUPLICATE_SELECTION: ' + group.id)
    for (const bookId of [keepId, ...quarantineIds]) {
      const previous = participants.get(bookId)
      if (previous && previous !== group.id) throw new Error('OVERLAPPING_DUPLICATE_SELECTION: ' + bookId)
      const item = group.items.find(item => normalizeId(item.id) === bookId)
      const filepath = item.filepath ? normalizePath(item.filepath) : null
      if (filepath && paths.has(filepath) && paths.get(filepath) !== bookId) throw new Error('OVERLAPPING_DUPLICATE_PATH: ' + filepath)
      if (filepath) for (const [otherPath, otherId] of paths) {
        if ((item.type === 'folder' && otherPath.startsWith(filepath + path.sep)) ||
          (membersById.get(otherId)?.type === 'folder' && filepath.startsWith(otherPath + path.sep))) throw new Error('OVERLAPPING_DUPLICATE_PATH: ' + filepath)
      }
      participants.set(bookId, group.id)
      if (filepath) paths.set(filepath, bookId)
      if (report.dedupeVersion >= 2 && !item.archiveSha256 && !item.contentProof) throw new Error('DUPLICATE_CONTENT_NOT_VERIFIED: ' + bookId)
    }
  }
  for (const [rawGroupId, value] of Object.entries(review.decisions || {})) {
    const groupId = normalizeId(rawGroupId)
    const group = groups.get(groupId)
    if (!group) throw new Error('DUPLICATE_GROUP_MISSING: ' + groupId)
    if (!['duplicate', 'different-version', 'not-duplicate', 'deferred'].includes(value?.disposition)) throw new Error('INVALID_DUPLICATE_DECISION: ' + groupId)
    if (group.evidenceRevision && value.evidenceRevision !== group.evidenceRevision) throw new Error('DUPLICATE_EVIDENCE_CHANGED: ' + groupId)
    const keepIds = [...new Set((value.keepIds || []).map(normalizeId))]
    const itemIds = new Set(group.items.map(item => normalizeId(item.id)))
    if (keepIds.some(id => !itemIds.has(id))) throw new Error('INVALID_DUPLICATE_SELECTION: ' + groupId)
    const quarantineToKeep = value.disposition === 'duplicate' ? Object.fromEntries(Object.entries(value.quarantineToKeep || {}).map(([id, keep]) => [normalizeId(id), normalizeId(keep)])) : {}
    if (value.disposition === 'duplicate' && !Object.keys(quarantineToKeep).length) throw new Error('INVALID_DUPLICATE_SELECTION: ' + groupId)
    for (const [id, keepId] of Object.entries(quarantineToKeep)) {
      if (keepIds.includes(id) || !keepIds.includes(keepId) || !itemIds.has(id)) throw new Error('INVALID_DUPLICATE_SELECTION: ' + groupId)
      if (group.items.find(item => normalizeId(item.id) === id)?.nestedBookIds?.length) throw new Error('DUPLICATE_FOLDER_CONTAINS_OTHER_BOOKS: ' + id)
      register(group, keepId, [id])
      if (report.dedupeVersion >= 2 && !(group.equivalenceClasses || []).some(equivalence => equivalence.eligible && equivalence.memberIds.includes(id) && equivalence.memberIds.includes(keepId))) {
        if (!String(value.reason || '').trim() || !value.confirmedConflictCodes?.includes('manual-differences')) throw new Error('DUPLICATE_DIFFERENCES_NOT_CONFIRMED: ' + groupId)
      }
    }
    decisions[groupId] = { disposition: value.disposition, evidenceRevision: group.evidenceRevision || null, keepIds, quarantineToKeep,
      reason: String(value.reason || '').trim(), confirmedConflictCodes: [...new Set((value.confirmedConflictCodes || []).map(String))], updatedAt: value.updatedAt || new Date().toISOString() }
  }
  for (const [rawGroupId, value] of Object.entries(review.selections || {})) {
    const groupId = normalizeId(rawGroupId)
    if (decisions[groupId]) continue
    if (report.dedupeVersion >= 2) throw new Error('DUPLICATE_REVIEW_REQUIRES_EVIDENCE_REVISION: ' + groupId)
    const group = groups.get(groupId)
    if (!group) throw new Error('DUPLICATE_GROUP_MISSING: ' + groupId)
    const keepId = normalizeId(value?.keepId)
    const quarantineIds = [...new Set((value?.quarantineIds || []).map(normalizeId).filter(Boolean))]
    register(group, keepId, quarantineIds)
    selections[groupId] = { keepId, quarantineIds }
  }
  return { reportId: report.reportId, selections, decisions, quarantineRoot: String(review.quarantineRoot || '').trim() }
}

const getDedupeActions = (report, review) => {
  const actions = Object.entries(review.selections || {}).map(([groupId, value]) => ({ groupId, ...value }))
  for (const [groupId, decision] of Object.entries(review.decisions || {})) {
    const byKeeper = new Map()
    for (const [id, keepId] of Object.entries(decision.quarantineToKeep || {})) {
      if (!byKeeper.has(keepId)) byKeeper.set(keepId, [])
      byKeeper.get(keepId).push(id)
    }
    for (const [keepId, quarantineIds] of byKeeper) actions.push({ groupId, keepId, quarantineIds })
  }
  return actions.map(action => {
    const group = report.groups.find(group => String(group.id) === action.groupId)
    return { ...action, group, keep: group.items.find(item => String(item.id) === action.keepId),
      quarantineItems: group.items.filter(item => action.quarantineIds.includes(String(item.id))) }
  })
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

const buildExecutionPreview = ({ taskType, report, review, library, collectionList = [] }) => {
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
    const orphanMetadataCount = anomalies.filter(item => item.action?.type === 'delete-orphan-metadata').length
    const identityReplacementCount = anomalies.length - sameIdentityCount - versionUpgradeCount - sourceRecoveryCount - manualSourceCount - ehviewerRebuildCount - localScanCount - orphanMetadataCount
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
      orphanMetadataCount,
      identityReplacementCount
    }
  }

  const actions = getDedupeActions(report, normalizedReview)
  const selectedGroups = [...new Set(actions.map(action => action.groupId))]
  if (selectedGroups.length === 0) throw new Error('NO_APPROVED_ACTIONS')
  const quarantineRoot = assertQuarantineRoot(library, normalizedReview.quarantineRoot)
  let quarantineFileCount = 0
  let potentialBytes = 0
  let manualReviewGroupCount = 0
  for (const { group, quarantineIds: ids } of actions) {
    const quarantineIds = new Set(ids)
    quarantineFileCount += quarantineIds.size
    potentialBytes += (group.items || [])
      .filter(item => quarantineIds.has(normalizeId(item.id)))
      .reduce((sum, item) => sum + Number(item.transferBytes ?? item.size ?? 0), 0)
    if (!group.eligible) manualReviewGroupCount += 1
  }
  return {
    valid: true,
    taskType,
    reportId: report.reportId,
    selectedGroupCount: selectedGroups.length,
    quarantineFileCount,
    potentialBytes,
    manualReviewGroupCount: new Set(actions.filter(action => !action.group.eligible || normalizedReview.decisions[action.groupId]?.confirmedConflictCodes?.includes('manual-differences')).map(action => action.groupId)).size,
    quarantineRoot,
    files: actions.flatMap(action => action.quarantineItems.map(item => ({ groupId: action.groupId, keepId: action.keep.id,
      keepTitle: action.keep.title, keepPath: action.keep.filepath, title: item.title, source: item.filepath,
      relativeTarget: path.relative(library, item.filepath), target: path.join(quarantineRoot, '{executionId}', path.relative(library, item.filepath)), size: item.transferBytes ?? item.size, kind: action.group.kind,
      reason: normalizedReview.decisions[action.groupId]?.reason || '', uncoveredEntries: item.uncoveredEntries || [],
      collectionTitles: collectionList.filter(collection => (collection.list || []).some(value => [item.id, item.hash].includes(value))).map(collection => collection.title || collection.id),
      mergedReadCount: Math.max(...[action.keep, ...action.quarantineItems].map(book => Number(book.readCount || 0))),
      mergedMark: [action.keep, ...action.quarantineItems].some(book => book.mark),
      mergedHidden: [action.keep, ...action.quarantineItems].every(book => book.hiddenBook) })))
  }
}

module.exports = {
  SUPPORTED_ANOMALY_ACTIONS,
  normalizeAnomalyReview,
  buildSafeAnomalyReview,
  normalizeDedupeReview,
  getDedupeActions,
  normalizeReview,
  getAnomalyAction,
  getRepairKind,
  assertQuarantineRoot,
  buildExecutionPreview
}

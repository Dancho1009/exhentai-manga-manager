const { extractMetadataSourceIdentity, isAutomaticSourceReplacementBlocked } = require('./utils.js')

const BATCH_SAFE_REPAIR_KINDS = new Set([
  'local-scan-sync',
  'same-identity-domain-switch',
  'source-recovery',
  'identity-replacement',
  'gallery-version-upgrade',
  'ehviewer-rebuild-from-current-metadata',
  'ehviewer-sync-to-current-metadata',
  'delete-orphan-metadata'
])

const MANUAL_REPAIR_KINDS = new Set(['manual-source-selection'])
const REPORT_ONLY_RECOMMENDATIONS = new Set([
  'no-action',
  'candidate-availability-uncertain',
  'current-availability-uncertain',
  'no-confirmed-available-candidate'
])
const MANUAL_RECOMMENDATIONS = new Set(['manual-review'])
const MANUAL_ANOMALY_TYPES = new Set([
  'ehviewer-url-conflict',
  'ehviewer-url-conflict-online',
  'filename-url-id-conflict',
  'unverified-page-mismatch'
])

const classifyAnomalyAction = anomaly => {
  const action = anomaly?.action
  if (!action) {
    const recommendedAction = String(anomaly?.recommendedAction || '')
    return {
      actionPolicy: MANUAL_RECOMMENDATIONS.has(recommendedAction) || (!REPORT_ONLY_RECOMMENDATIONS.has(recommendedAction) && MANUAL_ANOMALY_TYPES.has(anomaly?.type)) ||
        (anomaly?.type === 'metadata-incomplete' && extractMetadataSourceIdentity(anomaly.evidence?.currentUrl))
        ? 'manual'
        : 'report-only',
      actionRisk: 'none',
      actionReason: anomaly?.reason || '没有可执行动作'
    }
  }

  const repairKind = String(action.repairKind || '')
  if (isAutomaticSourceReplacementBlocked(action)) {
    return { actionPolicy: 'manual', actionRisk: 'medium', actionReason: '跨来源切换必须由用户选择来源，不能自动覆盖当前元数据' }
  }
  if (MANUAL_REPAIR_KINDS.has(repairKind)) {
    return {
      actionPolicy: 'manual',
      actionRisk: 'medium',
      actionReason: '需要用户选择来源'
    }
  }

  if (!BATCH_SAFE_REPAIR_KINDS.has(repairKind)) {
    return {
      actionPolicy: 'manual',
      actionRisk: 'medium',
      actionReason: '动作类型需要人工确认'
    }
  }

  return {
    actionPolicy: 'batch-safe',
    actionRisk: repairKind === 'delete-orphan-metadata' ? 'destructive' : 'low',
    actionReason: repairKind === 'delete-orphan-metadata'
      ? '将删除没有对应 Manga 的孤立 Metadata 记录'
      : '证据完整，可以在一次确认后批量处理'
  }
}

const withActionPolicy = anomaly => ({ ...anomaly, ...classifyAnomalyAction(anomaly) })

const classifyAnomalies = anomalies => (anomalies || []).map(withActionPolicy)

const getBatchSafeActions = report => classifyAnomalies(report?.anomalies)
  .filter(item => item.actionPolicy === 'batch-safe' && item.action)

const getBatchSafeActionIds = report => getBatchSafeActions(report).map(item => String(item.id))

const getWorkflowSummary = report => {
  const anomalies = classifyAnomalies(report?.anomalies)
  const books = new Map()
  for (const item of anomalies) {
    if (!item.bookId) continue
    const id = String(item.bookId)
    const bucket = books.get(id) || { batchSafe: 0, manual: 0, reportOnly: 0 }
    if (item.actionPolicy === 'batch-safe') bucket.batchSafe += 1
    else if (item.actionPolicy === 'manual') bucket.manual += 1
    else bucket.reportOnly += 1
    books.set(id, bucket)
  }
  return {
    batchSafeAnomalies: anomalies.filter(item => item.actionPolicy === 'batch-safe').length,
    batchSafeBooks: [...books.values()].filter(item => item.batchSafe > 0).length,
    manualReviewAnomalies: anomalies.filter(item => item.actionPolicy === 'manual').length,
    manualReviewBooks: [...books.values()].filter(item => item.manual > 0).length,
    reportOnlyAnomalies: anomalies.filter(item => item.actionPolicy === 'report-only').length,
    reportOnlyBooks: [...books.values()].filter(item => item.reportOnly > 0).length
  }
}

module.exports = {
  BATCH_SAFE_REPAIR_KINDS,
  MANUAL_REPAIR_KINDS,
  classifyAnomalyAction,
  classifyAnomalies,
  getBatchSafeActions,
  getBatchSafeActionIds,
  getWorkflowSummary
}

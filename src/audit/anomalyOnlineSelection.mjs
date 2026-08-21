const ONLINE_SOURCE_ANOMALY_TYPES = new Set([
  'ehviewer-invalid',
  'ehviewer-url-conflict',
  'ehviewer-source-recoverable'
])

export const collectOnlineSourceBookIds = (anomalies = []) => [...new Set(anomalies
  .filter(item => item?.bookId && ONLINE_SOURCE_ANOMALY_TYPES.has(item.type))
  .map(item => String(item.bookId)))]

export const summarizeOnlineSourceDecisions = (anomalies = []) => {
  const decisions = anomalies.filter(item => item?.type === 'ehviewer-url-conflict-online')
  const actionable = decisions.filter(item => item.action).length
  const manualReview = decisions.filter(item => item.recommendedAction === 'manual-review').length
  return {
    total: decisions.length,
    actionable,
    manualReview,
    inconclusive: decisions.length - actionable - manualReview
  }
}

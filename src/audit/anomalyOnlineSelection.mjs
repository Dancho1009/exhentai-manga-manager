const ONLINE_SOURCE_ANOMALY_TYPES = new Set([
  'ehviewer-invalid',
  'ehviewer-url-conflict',
  'ehviewer-source-recoverable'
])

export const collectOnlineSourceBookIds = (anomalies = []) => [...new Set(anomalies
  .filter(item => item?.bookId && ONLINE_SOURCE_ANOMALY_TYPES.has(item.type))
  .map(item => String(item.bookId)))]

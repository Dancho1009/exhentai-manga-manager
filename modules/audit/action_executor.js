const { executeApprovedAnomalies } = require('./anomaly_action_executor.js')
const { executeApprovedDuplicates } = require('./dedupe_action_executor.js')

const inferTaskType = options => {
  if (options.taskType) return options.taskType
  const hasAnomalyActions = (options.anomalyReview?.actionIds || []).length > 0
  const hasDedupeActions = Object.keys(options.dedupeReview?.selections || {}).length > 0
  if (hasAnomalyActions && !hasDedupeActions) return 'anomaly'
  if (hasDedupeActions && !hasAnomalyActions) return 'dedupe'
  throw new Error('EXECUTION_TASK_TYPE_REQUIRED')
}

const executeApprovedActions = async options => {
  const taskType = inferTaskType(options)
  if (taskType === 'anomaly') return await executeApprovedAnomalies(options)
  if (taskType === 'dedupe') return await executeApprovedDuplicates(options)
  throw new Error(`INVALID_AUDIT_TASK_TYPE: ${taskType}`)
}

module.exports = {
  executeApprovedActions,
  executeApprovedAnomalies,
  executeApprovedDuplicates
}

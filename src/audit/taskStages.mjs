const TERMINAL_PHASES = new Set(['idle', 'cancelling', 'cancelled', 'failed', 'interrupted'])

const stage = (id, labelKey, phases) => ({ id, labelKey, phases })

const anomalyStages = options => [
  stage('prepare', 'audit.stage_prepare', ['starting']),
  stage('snapshot', 'audit.stage_librarySnapshot', ['enumerating-library', 'snapshot-files']),
  stage('local-anomaly', 'audit.stage_localAnomaly', ['inspecting-book-health', 'reading-ehviewer-identities']),
  ...(options?.onlinePolicy && options.onlinePolicy !== 'none'
    ? [stage('online-sources', 'audit.stage_onlineSources', ['checking-online-sources'])]
    : []),
  stage('report', 'audit.stage_finalizeReport', ['finalizing-report', 'completed'])
]

const dedupeStages = () => [
  stage('prepare', 'audit.stage_prepare', ['starting']),
  stage('snapshot', 'audit.stage_librarySnapshot', ['enumerating-library', 'snapshot-files']),
  stage('archive-hash', 'audit.stage_archiveHash', ['hashing-archives']),
  stage('content-verification', 'audit.stage_contentVerification', ['inspecting-content']),
  stage('report', 'audit.stage_finalizeReport', ['finalizing-report', 'completed'])
]

const executionStages = options => [
  stage('validate-approvals', 'audit.stage_validateApprovals', ['validating-approvals']),
  stage('backup', 'audit.stage_backup', ['preparing-execution']),
  ...(options?.sourceTaskType === 'dedupe'
    ? [stage('quarantine', 'audit.stage_quarantineFiles', ['quarantining-files'])]
    : []),
  stage(
    'write-data',
    options?.sourceTaskType === 'dedupe' ? 'audit.stage_writeDedupeData' : 'audit.stage_writeAnomalyData',
    ['writing-metadata']
  ),
  stage('verify', 'audit.stage_verifyResult', ['verified', 'completed'])
]

export const getTaskStages = (taskType, options = {}) => {
  if (taskType === 'anomaly') return anomalyStages(options)
  if (taskType === 'dedupe') return dedupeStages()
  if (taskType === 'execution') return executionStages(options)
  return []
}

export const calculateTaskStages = ({ taskType, phase, lastWorkPhase, status, options } = {}) => {
  const definitions = getTaskStages(taskType, options)
  if (definitions.length === 0) {
    return { stages: [], completedCount: 0, totalCount: 0, currentStage: null, nextStage: null, remainingCount: 0 }
  }

  if (status === 'completed') {
    const stages = definitions.map(item => ({ ...item, state: 'completed' }))
    return {
      stages,
      completedCount: stages.length,
      totalCount: stages.length,
      currentStage: null,
      nextStage: null,
      remainingCount: 0
    }
  }

  const effectivePhase = TERMINAL_PHASES.has(phase) ? lastWorkPhase || phase : phase
  let currentIndex = definitions.findIndex(item => item.phases.includes(effectivePhase))
  if (currentIndex < 0) currentIndex = 0
  const currentState = status === 'failed'
    ? 'failed'
    : ['cancelling', 'interrupted'].includes(status) || ['cancelled', 'interrupted'].includes(phase)
      ? 'paused'
      : 'current'
  const stages = definitions.map((item, index) => ({
    ...item,
    state: index < currentIndex ? 'completed' : index === currentIndex ? currentState : 'upcoming'
  }))

  return {
    stages,
    completedCount: currentIndex,
    totalCount: stages.length,
    currentStage: stages[currentIndex],
    nextStage: stages[currentIndex + 1] || null,
    remainingCount: Math.max(0, stages.length - currentIndex - 1)
  }
}


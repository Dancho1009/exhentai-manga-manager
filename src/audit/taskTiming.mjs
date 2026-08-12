const parseTimestamp = value => {
  const timestamp = new Date(value || 0).getTime()
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null
}

const normalizeCount = value => Math.max(0, Number(value) || 0)

export const calculateTaskTiming = (state = {}, now = Date.now(), minSampleSeconds = 3) => {
  const startedAt = parseTimestamp(state.startedAt)
  const phaseStartedAt = parseTimestamp(state.phaseStartedAt) || startedAt
  const elapsedSeconds = startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : null
  const completed = normalizeCount(state.phaseCompleted ?? state.completed)
  const total = normalizeCount(state.phaseTotal ?? state.total)
  const phaseStartCompleted = normalizeCount(state.phaseStartCompleted)
  const phaseElapsedSeconds = phaseStartedAt ? Math.max(0, (now - phaseStartedAt) / 1000) : 0
  const progressed = Math.max(0, completed - phaseStartCompleted)
  let remainingSeconds = null

  if (
    state.status === 'running' &&
    total > completed &&
    progressed > 0 &&
    phaseElapsedSeconds >= minSampleSeconds
  ) {
    const secondsPerItem = phaseElapsedSeconds / progressed
    const estimate = Math.ceil((total - completed) * secondsPerItem)
    if (Number.isFinite(estimate) && estimate >= 0) remainingSeconds = estimate
  }

  return {
    elapsedSeconds,
    remainingSeconds,
    finishAt: remainingSeconds === null ? null : now + remainingSeconds * 1000
  }
}

export const formatTaskDuration = value => {
  if (!Number.isFinite(value) || value < 0) return '-'
  const seconds = Math.floor(value)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return [hours, minutes, remainder].map(item => String(item).padStart(2, '0')).join(':')
}

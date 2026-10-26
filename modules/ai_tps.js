// End-to-end output throughput for one HTTP attempt. Completion tokens already
// include reasoning; do not add reasoning tokens again or infer tokens from bytes.
const tokensPerSecond = (tokens, durationMs) => {
  if (!Number.isSafeInteger(tokens) || tokens < 0 || !Number.isFinite(durationMs) || durationMs <= 0) return null
  return Math.round(tokens * 1000 / durationMs * 100) / 100
}

const attemptThroughput = attempt => {
  const started = Date.parse(attempt?.startedAt)
  const ended = Date.parse(attempt?.responseCompletedAt || attempt?.completedAt)
  const durationMs = ended - started
  return { outputTps: tokensPerSecond(attempt?.usage?.completion_tokens, durationMs),
    tpsDurationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null }
}

module.exports = { tokensPerSecond, attemptThroughput }

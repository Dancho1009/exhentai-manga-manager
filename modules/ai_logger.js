const { beijingLogTimestamp } = require('./log_time.js')

const EVENTS = new Set(['request:start', 'request:finish', 'request:retry', 'task:start', 'task:progress', 'task:finish',
  'cache:hit', 'cache:miss', 'result:validated', 'result:invalid', 'candidates:start', 'candidates:finish'])
const COUNTS = new Set(['requestId', 'bookCount', 'pairCount', 'durationMs', 'timeoutMs', 'attempt', 'inputTokens', 'outputTokens', 'totalTokens',
  'streamBytes', 'contentBytes', 'reasoningBytes', 'limitBytes', 'receivedBytes', 'batchIndex', 'batchTotal',
  'maxOutputTokens', 'reasoningTokens', 'tpsDurationMs',
  'firstPassSavedCount', 'retrySavedCount', 'retryPendingCount', 'missingBookCount', 'failedBookCount', 'submittedBookCount',
  'cachedCount', 'completedCount', 'failedCount', 'requestCount', 'normalizationBatchSize', 'concurrency', 'verifiedCount', 'candidateCount', 'modelCount', 'totalCount', 'warningCount'])
const ENUMS = {
  provider: new Set(['compatible', 'chatgpt-json', 'chatgpt-account']),
  task: new Set(['analyze', 'normalize', 'dedupe', 'series', 'discovery', 'connection', 'models', 'verify-candidates']),
  status: new Set(['running', 'completed', 'failed', 'cancelled', 'partial', 'limited', 'cached']),
  reasoningEffort: new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  reasoningProtocol: new Set(['deepseek', 'openai']),
  thinkingMode: new Set(['inherit', 'enabled', 'disabled']),
  outputTokenField: new Set(['max_tokens', 'max_completion_tokens']),
  finishReason: new Set(['stop', 'length', 'aborted', 'insufficient_system_resource', 'content_filter', 'tool_calls', 'function_call']),
  truncationReason: new Set(['length', 'stream_incomplete']),
  requestParameter: new Set(['thinking', 'reasoning_effort', 'max_tokens', 'max_completion_tokens']),
  phase: new Set(['preparing', 'normalizing', 'candidates', 'classifying', 'verifying', 'completed']),
  limitKind: new Set(['stream', 'content']),
  timeoutMode: new Set(['stream_idle', 'request_total']),
  failureStage: new Set(['transport', 'json_parse', 'schema', 'business']),
  jsonEnvelope: new Set(['raw_json', 'markdown_fence']),
  validationReason: new Set(['INVALID_STRUCTURE', 'INVALID_VALUE', 'UNKNOWN_BOOK', 'EVIDENCE_MISMATCH', 'ORDINAL_EVIDENCE_MISSING',
    'PUBLICATION_EVIDENCE_MISSING', 'INVALID_DATE', 'RELATION_EVIDENCE_MISSING', 'RELATION_CONFLICT', 'UNREQUESTED_RELATION'])
}

const safeDetails = details => {
  const result = {}
  for (const key of COUNTS) if (Number.isSafeInteger(details[key]) && details[key] >= 0) result[key] = details[key]
  if (Number.isFinite(details.outputTps) && details.outputTps >= 0) result.outputTps = details.outputTps
  if (typeof details.stream === 'boolean') result.stream = details.stream
  if (typeof details.thinkingControlMismatch === 'boolean') result.thinkingControlMismatch = details.thinkingControlMismatch
  for (const key of ['runId', 'batchId']) if (typeof details[key] === 'string' && /^[a-zA-Z0-9_-]{1,150}$/.test(details[key])) result[key] = details[key]
  for (const [key, values] of Object.entries(ENUMS)) if (values.has(details[key])) result[key] = details[key]
  if (Number.isInteger(details.httpStatus) && details.httpStatus >= 100 && details.httpStatus <= 599) result.httpStatus = details.httpStatus
  if (typeof details.model === 'string' && details.model.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(details.model) && !/^(?:sk[-_]|bearer|eyJ)/i.test(details.model)) result.model = details.model
  if (typeof details.errorCode === 'string' && /^AI_[A-Z0-9_]{1,64}$/.test(details.errorCode)) result.errorCode = details.errorCode
  if (typeof details.fieldPath === 'string' && details.fieldPath.length <= 200 && /^[a-zA-Z]+(?:\[\d+\])?(?:\.[a-zA-Z]+(?:\[\d+\])?)*$/.test(details.fieldPath)) result.fieldPath = details.fieldPath
  return result
}

const ignoreAsyncFailure = value => { if (value && typeof value.catch === 'function') value.catch(() => {}) }

const createAiLogger = ({ write = line => console.info(line), now = Date.now } = {}) => {
  const log = (event, details = {}) => {
    try {
      if (!EVENTS.has(event)) return
      const fields = safeDetails(details || {})
      const at = beijingLogTimestamp(now())
      ignoreAsyncFailure(write(`[AI] ${event} ${JSON.stringify({ at, ...fields })}`))
    } catch {}
  }
  log.log = log
  return log
}

const safeAiLog = (logger, event, details) => {
  try {
    if (!EVENTS.has(event)) return
    const fields = safeDetails(details || {})
    const result = typeof logger === 'function' ? logger(event, fields) : logger?.log?.(event, fields)
    ignoreAsyncFailure(result)
  } catch {}
}

module.exports = { createAiLogger, safeAiLog }

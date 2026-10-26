const nodeFetch = require('node-fetch')
const { StringDecoder } = require('node:string_decoder')
const { jsonObjectOnlyHosts, reasoningEfforts, compatibleReasoningEfforts } = require('./ai_provider_capabilities.json')
const { SIWC_BASE_URL, createResponsesTransport } = require('./ai_responses.js')
const { createAiLogger, safeAiLog } = require('./ai_logger.js')
const { MAX_STREAM_BYTES, responseLimit } = require('./ai_response_limits.js')
const { normalizeAiJsonText } = require('./ai_json_parser.js')
const { tokensPerSecond } = require('./ai_tps.js')

const DEFAULT_AI_CONFIG = Object.freeze({
  enabled: false,
  provider: 'compatible',
  baseUrl: '',
  model: '',
  chatgptJsonModel: '',
  chatgptAccountModel: '',
  reasoningEffort: 'medium',
  compatibleReasoningProtocol: 'deepseek',
  compatibleThinkingMode: 'inherit',
  compatibleReasoningEffort: 'low',
  compatibleOutputTokenField: 'max_tokens',
  compatibleMaxOutputTokens: null,
  chatgptJsonReasoningEffort: 'medium',
  chatgptAccountReasoningEffort: 'medium',
  responseMode: 'json_schema',
  stream: false,
  timeoutMs: 60000,
  normalizationBatchSize: 8,
  concurrency: 2,
  dedupeEnabled: true,
  seriesEnabled: true
})
const MAX_REQUEST_BYTES = 128 * 1024
const RETRYABLE_STATUS = new Set([429, 502, 503, 504])

const aiError = (code, message, status) => {
  const error = new Error(message)
  error.code = code
  if (status) error.status = status
  return error
}

const boundedInteger = (value, fallback, min, max) => {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback
}

const normalizeAiConfig = value => {
  const source = value && typeof value === 'object' ? value : {}
  const baseUrl = typeof source.baseUrl === 'string' ? source.baseUrl.trim() : ''
  let responseMode = source.responseMode === 'json_object' ? 'json_object' : 'json_schema'
  try {
    if (jsonObjectOnlyHosts.includes(new URL(baseUrl).hostname)) responseMode = 'json_object'
  } catch {}
  const outputValue = source.compatibleMaxOutputTokens
  const maxOutputTokens = outputValue == null || outputValue === '' ? null : Number(outputValue)
  if (maxOutputTokens !== null && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1)) {
    throw aiError('AI_INVALID_OUTPUT_TOKENS', '最大输出 tokens 必须为正整数，或留空跟随上游。')
  }
  return {
    enabled: source.enabled === true,
    provider: ['chatgpt-json', 'chatgpt-account'].includes(source.provider) ? source.provider : 'compatible',
    baseUrl,
    model: typeof source.model === 'string' ? source.model.trim() : '',
    chatgptJsonModel: typeof source.chatgptJsonModel === 'string' ? source.chatgptJsonModel.trim() : '',
    chatgptAccountModel: typeof source.chatgptAccountModel === 'string' ? source.chatgptAccountModel.trim() : '',
    reasoningEffort: reasoningEfforts.includes(source.reasoningEffort) ? source.reasoningEffort : 'medium',
    compatibleReasoningProtocol: Object.hasOwn(compatibleReasoningEfforts, source.compatibleReasoningProtocol) ? source.compatibleReasoningProtocol : 'deepseek',
    compatibleThinkingMode: ['enabled', 'disabled'].includes(source.compatibleThinkingMode) ? source.compatibleThinkingMode : 'inherit',
    compatibleReasoningEffort: ['minimal', ...reasoningEfforts].includes(source.compatibleReasoningEffort) ? source.compatibleReasoningEffort : 'low',
    compatibleOutputTokenField: source.compatibleOutputTokenField === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens',
    compatibleMaxOutputTokens: maxOutputTokens,
    chatgptJsonReasoningEffort: reasoningEfforts.includes(source.chatgptJsonReasoningEffort) ? source.chatgptJsonReasoningEffort : 'medium',
    chatgptAccountReasoningEffort: reasoningEfforts.includes(source.chatgptAccountReasoningEffort) ? source.chatgptAccountReasoningEffort : 'medium',
    responseMode,
    stream: source.stream === true,
    timeoutMs: boundedInteger(source.timeoutMs ?? DEFAULT_AI_CONFIG.timeoutMs, DEFAULT_AI_CONFIG.timeoutMs, 1000, 300000),
    normalizationBatchSize: boundedInteger(source.normalizationBatchSize ?? DEFAULT_AI_CONFIG.normalizationBatchSize, DEFAULT_AI_CONFIG.normalizationBatchSize, 1, 1000),
    concurrency: boundedInteger(source.concurrency ?? DEFAULT_AI_CONFIG.concurrency, DEFAULT_AI_CONFIG.concurrency, 1, 1000),
    dedupeEnabled: source.dedupeEnabled !== false,
    seriesEnabled: source.seriesEnabled !== false
  }
}

const buildCompatibleRequestOptions = current => {
  const options = {}
  if (current.compatibleThinkingMode !== 'inherit') {
    const enabled = current.compatibleThinkingMode === 'enabled'
    if (enabled && !compatibleReasoningEfforts[current.compatibleReasoningProtocol]?.includes(current.compatibleReasoningEffort)) {
      throw aiError('AI_REASONING_UNSUPPORTED', '所选思考协议不支持这个思考等级，请修改设置。')
    }
    if (current.compatibleReasoningProtocol === 'deepseek') options.thinking = { type: current.compatibleThinkingMode }
    if (enabled || current.compatibleReasoningProtocol === 'openai') options.reasoning_effort = enabled ? current.compatibleReasoningEffort : 'none'
  }
  if (current.compatibleMaxOutputTokens !== null) options[current.compatibleOutputTokenField] = current.compatibleMaxOutputTokens
  return options
}

const truncatedError = (truncationReason, finishReason) => Object.assign(aiError('AI_RESPONSE_TRUNCATED',
  truncationReason === 'length' ? 'AI 单次输出达到上游长度限制。' : 'AI 响应流未完整结束。'), { truncationReason, finishReason })

const resolveAiConfig = value => {
  const current = normalizeAiConfig(value)
  if (current.provider === 'compatible') return current
  return {
    ...current,
    baseUrl: SIWC_BASE_URL,
    model: current.provider === 'chatgpt-json' ? current.chatgptJsonModel : current.chatgptAccountModel,
    reasoningEffort: current.provider === 'chatgpt-json' ? current.chatgptJsonReasoningEffort : current.chatgptAccountReasoningEffort,
    responseMode: 'json_schema'
  }
}

const completionUrl = baseUrl => {
  let url
  try { url = new URL(baseUrl) } catch {
    throw aiError('AI_INVALID_URL', '请填写有效的 AI 服务地址。')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw aiError('AI_INVALID_URL', 'AI 服务地址必须使用 HTTP 或 HTTPS，且不能包含账号、密码或锚点。')
  }
  const pathname = url.pathname.replace(/\/+$/, '')
  url.pathname = pathname.endsWith('/chat/completions') ? pathname : `${pathname}/chat/completions`
  return url.toString()
}

const cancelledError = () => aiError('AI_CANCELLED', 'AI 分析已取消。')
const waitForRetry = (delayMs, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(cancelledError())
  const onAbort = () => {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    reject(cancelledError())
  }
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', onAbort)
    resolve()
  }, delayMs)
  signal.addEventListener('abort', onAbort, { once: true })
})

const retryDelay = response => {
  const value = response.headers.get('retry-after')
  if (!value) return 500
  const seconds = Number(value)
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now()
  return Number.isFinite(milliseconds) ? Math.min(3000, Math.max(0, milliseconds)) : 500
}

const readBoundedBody = async (response, signal, onData, observer, limitKind = 'stream') => {
  responseLimit(limitKind, Number(response.headers.get('content-length')) || 0)
  if (!response.body) return ''
  let length = 0
  const chunks = []
  for await (const chunk of response.body) {
    if (signal?.aborted) throw cancelledError()
    const buffer = Buffer.from(chunk)
    if (buffer.length) onData?.()
    length += buffer.length
    await observer?.raw(buffer)
    responseLimit(limitKind, length)
    chunks.push(buffer)
  }
  observer?.received()
  return Buffer.concat(chunks).toString('utf8')
}

const parseCompletion = async (text, requestedModel, observer, streamed = false) => {
  let body
  try { body = JSON.parse(text) } catch {
    throw aiError('AI_INVALID_RESPONSE', 'AI 服务返回的响应不是有效 JSON。')
  }
  observer?.usage(body?.usage, body?.model)
  const rejectedOption = body?.error && rejectedRequestOption(text)
  if (rejectedOption) throw Object.assign(aiError('AI_REQUEST_OPTIONS_UNSUPPORTED', `上游拒绝请求参数：${rejectedOption}，请调整思考协议或输出长度设置。`), { requestParameter: rejectedOption })
  const choice = body?.choices?.[0]
  const content = choice?.message?.content
  if (!streamed && typeof content === 'string') {
    responseLimit('content', Buffer.byteLength(content))
    await observer?.text('content', content, true)
    if (typeof choice.message.reasoning_content === 'string') await observer?.text('reasoning', choice.message.reasoning_content)
  }
  if (choice?.finish_reason === 'length') throw truncatedError('length', 'length')
  if (['aborted', 'insufficient_system_resource'].includes(choice?.finish_reason)) throw truncatedError('stream_incomplete', choice.finish_reason)
  if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') {
    throw aiError('AI_REFUSED', 'AI 服务未完成本次内容分析。')
  }
  if (typeof content !== 'string') throw aiError('AI_INVALID_RESPONSE', 'AI 服务未返回可解析的消息内容。')
  responseLimit('content', Buffer.byteLength(content))
  let value
  const normalized = normalizeAiJsonText(content)
  try { value = JSON.parse(normalized.text) } catch {
    throw Object.assign(aiError('AI_INVALID_JSON', 'AI 返回的分析结果不是有效 JSON 对象。'), {
      failureStage: 'json_parse', jsonEnvelope: normalized.envelope
    })
  }
  await observer?.parsed(value)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(aiError('AI_INVALID_JSON', 'AI 返回的分析结果必须是 JSON 对象。'), {
      failureStage: 'json_parse', jsonEnvelope: normalized.envelope
    })
  }
  const usage = {}
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    if (Number.isSafeInteger(body.usage?.[key]) && body.usage[key] >= 0) usage[key] = body.usage[key]
  }
  const reasoningTokens = body.usage?.completion_tokens_details?.reasoning_tokens
  if (Number.isSafeInteger(reasoningTokens) && reasoningTokens >= 0) usage.completion_tokens_details = { reasoning_tokens: reasoningTokens }
  observer?.usage(body.usage, body.model)
  return { value, usage, finishReason: choice?.finish_reason, model: typeof body.model === 'string' ? body.model : requestedModel }
}

const parseCompletionStream = async (response, requestedModel, signal, onData, observer) => {
  if (response.headers.get('content-type')?.includes('application/json')) return parseCompletion(await readBoundedBody(response, signal, onData, observer), requestedModel, observer)
  responseLimit('stream', Number(response.headers.get('content-length')) || 0)
  if (!response.body) throw truncatedError('stream_incomplete')
  const decoder = new StringDecoder('utf8')
  let pending = '', content = '', contentBytes = 0, model = requestedModel, usage, finishReason = null, done = false, length = 0
  const consume = async frame => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
    if (!data || done) return
    if (data.trim() === '[DONE]') { done = true; return }
    let chunk
    try { chunk = JSON.parse(data) } catch { throw aiError('AI_INVALID_RESPONSE', 'AI 返回的响应事件格式无效。') }
    if (chunk?.error) {
      const rejectedOption = rejectedRequestOption(data)
      if (rejectedOption) throw Object.assign(aiError('AI_REQUEST_OPTIONS_UNSUPPORTED', `上游拒绝请求参数：${rejectedOption}，请调整思考协议或输出长度设置。`), { requestParameter: rejectedOption })
      throw aiError('AI_RESPONSE_FAILED', 'AI 服务未完成本次分析。')
    }
    if (typeof chunk?.model === 'string') model = chunk.model
    if (chunk?.usage && typeof chunk.usage === 'object') usage = chunk.usage
    if (chunk?.usage) observer?.usage(chunk.usage, chunk.model)
    const choice = chunk?.choices?.[0]
    if (!choice) return
    if (choice.delta?.refusal || choice.message?.refusal || choice.finish_reason === 'content_filter') throw aiError('AI_REFUSED', 'AI 服务未完成本次内容分析。')
    if (typeof choice.delta?.reasoning_content === 'string') await observer?.text('reasoning', choice.delta.reasoning_content)
    if (typeof choice.delta?.content === 'string') {
      content += choice.delta.content
      contentBytes += Buffer.byteLength(choice.delta.content)
      await observer?.text('content', choice.delta.content)
    } else if (typeof choice.message?.content === 'string') {
      content = choice.message.content
      contentBytes = Buffer.byteLength(content)
      await observer?.text('content', content, true)
    }
    responseLimit('content', contentBytes)
    if (choice.finish_reason != null) finishReason = choice.finish_reason
  }
  const complete = () => {
    if (signal?.aborted) throw cancelledError()
    if (!done && !finishReason) throw truncatedError('stream_incomplete')
    observer?.received()
    return parseCompletion(JSON.stringify({ model, usage, choices: [{ finish_reason: finishReason, message: { content } }] }), requestedModel, observer, true)
  }
  for await (const chunk of response.body) {
    if (signal?.aborted) throw cancelledError()
    const buffer = Buffer.from(chunk)
    if (buffer.length) onData?.()
    length += buffer.length
    await observer?.raw(buffer)
    responseLimit('stream', length)
    pending += decoder.write(buffer)
    let separator
    while ((separator = /\r?\n\r?\n/.exec(pending))) {
      await consume(pending.slice(0, separator.index))
      pending = pending.slice(separator.index + separator[0].length)
      if (done) return complete()
    }
  }
  pending += decoder.end()
  if (pending.trim()) await consume(pending)
  return complete()
}

const parseModelList = text => {
  let body
  try { body = JSON.parse(text) } catch {
    throw aiError('AI_INVALID_MODEL_LIST', 'AI 服务返回的模型列表格式无效。')
  }
  if (!Array.isArray(body?.data)) throw aiError('AI_INVALID_MODEL_LIST', 'AI 服务返回的模型列表格式无效。')
  const models = body.data.map(item => typeof item?.id === 'string' ? item.id.trim() : '').filter(Boolean)
  return { models: [...new Set(models)].sort() }
}

const isResponseFormatUnsupported = text => {
  let error
  try { error = JSON.parse(text)?.error } catch { return false }
  const message = typeof error?.message === 'string' ? error.message : ''
  const parameter = typeof error?.param === 'string' ? error.param : ''
  return /\bresponse_format\b/i.test(`${parameter} ${message}`) &&
    /\b(?:unsupported|unavailable|not supported|not available)\b/i.test(message)
}

const rejectedRequestOption = text => {
  let error
  try { error = JSON.parse(text)?.error } catch { return null }
  const fields = ['thinking', 'reasoning_effort', 'max_completion_tokens', 'max_tokens']
  if (fields.includes(error?.param)) return error.param
  const message = typeof error?.message === 'string' ? error.message : ''
  if (!/unsupported|unknown|unrecognized|not supported|invalid parameter/i.test(message)) return null
  return fields.find(field => new RegExp(`\\b${field}\\b`, 'i').test(message)) || null
}

const createAiService = ({ getConfig = () => DEFAULT_AI_CONFIG, getApiKey = () => '', getOAuthCredential = async () => null, fetchImpl = nodeFetch,
  logger = createAiLogger(), now = Date.now, traceStore } = {}) => {
  const responses = createResponsesTransport({ fetchImpl, getOAuthCredential, logger })
  let nextRequestId = 0
  const clock = () => { try { const value = now(); return Number.isFinite(value) ? value : Date.now() } catch { return Date.now() } }
  const loggedRequest = async (task, options, operation) => {
    const startedAt = clock(), requestId = ++nextRequestId
    const trace = { clock, details: { requestId, task, phase: ({normalize:'normalizing',dedupe:'classifying',series:'classifying'})[task] || task, bookCount: Array.isArray(options.payload?.books) ? options.payload.books.length : 0,
      pairCount: Array.isArray(options.payload?.pairs) ? options.payload.pairs.length : 0, ...options.traceContext } }
    let started = false
    try {
      const current = resolveAiConfig(options.config ?? await getConfig())
      Object.assign(trace.details, { provider: current.provider, model: current.model,
        timeoutMs: current.timeoutMs, timeoutMode: task !== 'models' && (current.provider !== 'compatible' || current.stream) ? 'stream_idle' : 'request_total',
        ...(task !== 'models' ? { stream: current.provider !== 'compatible' || current.stream } : {}),
        ...(current.provider !== 'compatible' ? { reasoningEffort: current.reasoningEffort } : {}) })
      if (current.provider === 'compatible' && task !== 'models') {
        const options = buildCompatibleRequestOptions(current)
        Object.assign(trace.details, { reasoningProtocol: current.compatibleReasoningProtocol,
          thinkingMode: current.compatibleThinkingMode, reasoningEffort: options.reasoning_effort,
          maxOutputTokens: current.compatibleMaxOutputTokens, outputTokenField: current.compatibleOutputTokenField })
      }
      trace.observer = traceStore?.createRequest(trace.details, requestId)
      safeAiLog(logger, 'request:start', trace.details)
      started = true
      const result = await operation(current, trace)
      if (task === 'models') await trace.observer?.parsed(result)
      await trace.observer?.finish(result)
      safeAiLog(logger, 'request:finish', { ...trace.details, status: 'completed', httpStatus: trace.httpStatus,
        ...(!trace.observer ? { outputTps: tokensPerSecond(result.usage?.completion_tokens, trace.tpsDurationMs), tpsDurationMs: trace.tpsDurationMs } : {}),
        ...trace.observer?.stats(),
        durationMs: Math.max(0, Math.round(clock() - startedAt)), inputTokens: result.usage?.prompt_tokens,
        outputTokens: result.usage?.completion_tokens, totalTokens: result.usage?.total_tokens,
        reasoningTokens: result.usage?.completion_tokens_details?.reasoning_tokens, finishReason: result.finishReason,
        modelCount: Array.isArray(result.models) ? result.models.length : undefined })
      if (trace.observer) Object.defineProperty(result, 'traceContext', { value: trace.observer.context })
      return result
    } catch (error) {
      await trace.observer?.finish(null, error)
      if (trace.observer) error.traceContext = trace.observer.context
      if (!started) safeAiLog(logger, 'request:start', trace.details)
      safeAiLog(logger, 'request:finish', { ...trace.details, status: error.code === 'AI_CANCELLED' ? 'cancelled' : 'failed',
        ...trace.observer?.stats(),
        durationMs: Math.max(0, Math.round(clock() - startedAt)), httpStatus: error.status || trace.httpStatus,
         errorCode: /^AI_[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'AI_REQUEST_FAILED',
         failureStage: error.failureStage, jsonEnvelope: error.jsonEnvelope,
        truncationReason: error.truncationReason, finishReason: error.finishReason, requestParameter: error.requestParameter,
        limitKind: error.limitKind, limitBytes: error.limitBytes, receivedBytes: error.receivedBytes })
      throw error
    }
  }
  const fetchText = async ({ url, method, body, signal, current, apiKey, trace, readResponse = readBoundedBody }) => {
    if (signal?.aborted) throw cancelledError()
    const key = String(apiKey ?? await getApiKey()).trim()
    const headers = body === undefined ? { Accept: 'application/json' } : { 'Content-Type': 'application/json' }
    if (body !== undefined && current.stream) headers.Accept = 'text/event-stream'
    if (key) headers.Authorization = `Bearer ${key}`
    const controller = new AbortController()
    let timedOut = false
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) controller.abort()
    let timer
    const resetTimeout = () => {
      clearTimeout(timer)
      timer = setTimeout(() => { timedOut = true; controller.abort() }, current.timeoutMs)
    }
    resetTimeout()
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (controller.signal.aborted) throw cancelledError()
        if (trace) trace.attemptStartedAt = clock()
        await trace?.observer?.startAttempt(attempt + 1, { url, method, body })
        const response = await fetchImpl(url, {
          method, headers, body, signal: controller.signal,
          redirect: 'error', size: MAX_STREAM_BYTES
        })
        if (trace) trace.httpStatus = response.status
        trace?.observer?.headers(response)
        if (response.ok && current.stream && body !== undefined) resetTimeout()
        // Consume even error responses with the same limit, without exposing their body.
        const text = await (response.ok ? readResponse(response, controller.signal, current.stream && body !== undefined ? resetTimeout : undefined, trace?.observer) : readBoundedBody(response, controller.signal, undefined, trace?.observer))
        if (trace) trace.tpsDurationMs = Math.max(0, clock() - trace.attemptStartedAt)
        if (controller.signal.aborted) throw cancelledError()
        if (!response.ok) {
          if (attempt === 0 && RETRYABLE_STATUS.has(response.status)) {
            await trace?.observer?.retry(response.status === 429 ? 'AI_RATE_LIMITED' : 'AI_HTTP_ERROR')
            safeAiLog(logger, 'request:retry', { ...trace?.details, attempt: attempt + 2, httpStatus: response.status,
              errorCode: response.status === 429 ? 'AI_RATE_LIMITED' : 'AI_HTTP_ERROR' })
            await waitForRetry(retryDelay(response), controller.signal)
            continue
          }
          if ([401, 403].includes(response.status)) throw aiError('AI_AUTH_FAILED', 'AI 服务鉴权失败，请检查 API Key 和权限。', response.status)
          if (response.status === 429) throw aiError('AI_RATE_LIMITED', 'AI 服务请求过于频繁，请稍后重试。', response.status)
          if ([400, 422].includes(response.status) && isResponseFormatUnsupported(text)) {
            throw aiError('AI_RESPONSE_FORMAT_UNSUPPORTED', 'AI 服务不支持当前输出格式，请在设置中选择 JSON 对象模式后重试。', response.status)
          }
          const rejectedOption = [400, 422].includes(response.status) && rejectedRequestOption(text)
          if (rejectedOption) throw Object.assign(aiError('AI_REQUEST_OPTIONS_UNSUPPORTED', `上游拒绝请求参数：${rejectedOption}，请调整思考协议或输出长度设置。`, response.status), { requestParameter: rejectedOption })
          throw aiError('AI_HTTP_ERROR', `AI 服务请求失败（HTTP ${response.status}）。`, response.status)
        }
        return text
      }
    } catch (error) {
      if (timedOut) throw aiError('AI_TIMEOUT', 'AI 服务请求超时。')
      if (signal?.aborted || controller.signal.aborted) throw cancelledError()
      if (error.code?.startsWith('AI_')) throw error
      if (error.type === 'max-size') responseLimit('stream', MAX_STREAM_BYTES + 1)
      throw aiError('AI_NETWORK_ERROR', '无法连接 AI 服务，请检查服务地址、网络和代理设置。')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      controller.abort()
    }
  }

  const request = async ({ payload, systemPrompt, schema, signal, apiKey }, allowDisabled, current, trace) => {
    if (!allowDisabled && !current.enabled) throw aiError('AI_DISABLED', '请先在设置中启用 AI 辅助判断。')
    const url = current.provider === 'compatible' ? completionUrl(current.baseUrl) : null
    if (!current.model) throw aiError('AI_MODEL_REQUIRED', '请填写 AI 模型名称。')
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      throw aiError('AI_SCHEMA_REQUIRED', '本次分析缺少 JSON 结果格式定义。')
    }
    if (current.provider !== 'compatible') return responses.analyze({ current, payload, systemPrompt, schema, signal, trace })
    let body
    try {
      const systemContent = `${String(systemPrompt || '')}\nReturn one JSON object only.` +
        (current.responseMode === 'json_object' ? `\nThe result must follow this JSON schema exactly:\n${JSON.stringify(schema)}` : '')
      body = JSON.stringify({
        model: current.model,
        ...buildCompatibleRequestOptions(current),
        stream: current.stream,
        ...(current.stream ? { stream_options: { include_usage: true } } : {}),
        temperature: 0,
        response_format: current.responseMode === 'json_schema'
          ? { type: 'json_schema', json_schema: { name: 'audit_relation', strict: true, schema } }
          : { type: 'json_object' },
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: JSON.stringify(payload) }
        ]
      })
    } catch {
      throw aiError('AI_INVALID_INPUT', '本次分析数据不能转换为 JSON。')
    }
    if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
      throw aiError('AI_INPUT_TOO_LARGE', 'AI 请求内容超过 128 KiB 限制，请缩小本次分析范围。')
    }
    if (current.stream) return fetchText({ url, method: 'POST', body, signal, current, apiKey, trace,
      readResponse: (response, requestSignal, onData, observer) => parseCompletionStream(response, current.model, requestSignal, onData, observer) })
    return parseCompletion(await fetchText({ url, method: 'POST', body, signal, current, apiKey, trace }), current.model, trace?.observer)
  }

  return {
    analyze: (options = {}) => loggedRequest(['normalize', 'dedupe', 'series'].includes(options.payload?.task) ? options.payload.task : 'analyze', options,
      (current, trace) => request(options, false, current, trace)),
    listModels: (options = {}) => loggedRequest('models', options, async (current, trace) => {
      const { apiKey, signal } = options
      if (current.provider !== 'compatible') return responses.listModels({ current, signal, trace })
      const url = new URL(completionUrl(current.baseUrl))
      url.pathname = url.pathname.replace(/\/chat\/completions$/, '/models')
      const key = typeof apiKey === 'string' && apiKey.trim() ? apiKey : undefined
      return parseModelList(await fetchText({ url: url.toString(), method: 'GET', signal, current, apiKey: key, trace,
        readResponse: (response, requestSignal, onData, observer) => readBoundedBody(response, requestSignal, onData, observer, 'content') }))
    }),
    testConnection: (options = {}) => loggedRequest('connection', options, async (current, trace) => {
      const { apiKey, signal } = options
      const result = await request({
        apiKey, signal,
        systemPrompt: 'This is a connection test. Return exactly {"ok":true}.',
        payload: { test: 'connection' },
        schema: { type: 'object', properties: { ok: { type: 'boolean', enum: [true] } }, required: ['ok'], additionalProperties: false }
      }, true, current, trace)
      if (result.value.ok !== true || Object.keys(result.value).length !== 1) {
        throw aiError('AI_INVALID_TEST_RESULT', '已连接 AI 服务，但模型未按要求返回测试结果。')
      }
      return result
    })
  }
}

module.exports = { DEFAULT_AI_CONFIG, normalizeAiConfig, resolveAiConfig, buildCompatibleRequestOptions, createAiService }

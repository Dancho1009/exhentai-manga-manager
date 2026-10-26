const { StringDecoder } = require('node:string_decoder')
const { version: appVersion } = require('../package.json')
const { reasoningEfforts } = require('./ai_provider_capabilities.json')
const { safeAiLog } = require('./ai_logger.js')
const { MAX_STREAM_BYTES, responseLimit } = require('./ai_response_limits.js')
const { normalizeAiJsonText } = require('./ai_json_parser.js')

const SIWC_BASE_URL = 'https://api.openai.com/v1'
// Codex credentials use the Codex backend, while SIWC credentials use the public API.
// Source: openai/codex, codex-rs/model-provider-info/src/lib.rs.
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'
const MAX_REQUEST_BYTES = 128 * 1024

const aiError = (code, message, status) => {
  const error = new Error(message)
  error.code = code
  if (status) error.status = status
  return error
}
const cancelledError = () => aiError('AI_CANCELLED', 'AI 分析已取消。')

const checkResponseLength = response => {
  responseLimit('stream', Number(response.headers.get('content-length')) || 0)
}

const readBoundedBody = async (response, observer) => {
  checkResponseLength(response)
  responseLimit('content', Number(response.headers.get('content-length')) || 0)
  const chunks = []
  let length = 0
  if (!response.body) return ''
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk)
    length += buffer.length
    await observer?.raw(buffer)
    responseLimit('content', length)
    chunks.push(buffer)
  }
  observer?.received()
  return Buffer.concat(chunks).toString('utf8')
}

const responseFailure = (body, status) => {
  const code = body?.error?.code ?? body?.response?.error?.code ?? body?.code
  const parameter = body?.error?.param ?? body?.response?.error?.param
  const message = body?.error?.message ?? body?.response?.error?.message
  if ([400, 422].includes(status) && (['reasoning.effort', 'reasoning_effort'].includes(parameter) ||
    (typeof message === 'string' && /reasoning[._ ]effort/i.test(message) && /unsupported|not supported|invalid|not allowed/i.test(message)))) {
    return aiError('AI_REASONING_UNSUPPORTED', '当前模型不支持所选思考程度，请选择模型支持的档位。', status)
  }
  if (status === 401 || status === 403 || code === 'invalid_api_key' || code === 'token_expired') {
    return aiError('AI_AUTH_FAILED', 'ChatGPT 登录已失效或没有调用权限，请重新登录或导入凭据。', status)
  }
  if (status === 429 || ['subscription_sharing_usage_limit_exceeded', 'rate_limit_exceeded', 'usage_limit_reached', 'insufficient_quota'].includes(code)) {
    return aiError('AI_RATE_LIMITED', 'ChatGPT 额度已用完或请求过于频繁，请稍后重试。', status)
  }
  if (code === 'subscription_sharing_usage_unavailable') {
    return aiError('AI_PLAN_UNAVAILABLE', '当前 ChatGPT 账户暂时无法使用套餐额度，请检查账户权限。', status)
  }
  if (code === 'model_not_found' || code === 'unsupported_model') {
    return aiError('AI_MODEL_UNAVAILABLE', '当前 ChatGPT 账户无法使用所选模型，请重新获取模型列表。', status)
  }
  return status
    ? aiError('AI_HTTP_ERROR', `ChatGPT 请求失败（HTTP ${status}）。`, status)
    : aiError('AI_RESPONSE_FAILED', 'ChatGPT 未完成本次分析，请稍后重试。')
}

const parseJsonObject = content => {
  const normalized = normalizeAiJsonText(content)
  let value
  try { value = JSON.parse(normalized.text) } catch {
    throw Object.assign(aiError('AI_INVALID_JSON', 'AI 返回的分析结果不是有效 JSON 对象。'), {
      failureStage: 'json_parse', jsonEnvelope: normalized.envelope
    })
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(aiError('AI_INVALID_JSON', 'AI 返回的分析结果必须是 JSON 对象。'), {
      failureStage: 'json_parse', jsonEnvelope: normalized.envelope
    })
  }
  return value
}

const completedResult = async (response, deltas, requestedModel, observer) => {
  if (!response || (response.status && response.status !== 'completed')) {
    throw aiError('AI_RESPONSE_TRUNCATED', 'ChatGPT 返回内容未完整结束，请缩小本次分析范围后重试。')
  }
  const output = Array.isArray(response.output) ? response.output : []
  const content = output.flatMap(item => Array.isArray(item?.content) ? item.content : [])
  if (content.some(item => item?.type === 'refusal')) throw aiError('AI_REFUSED', 'AI 服务未完成本次内容分析。')
  const texts = content.filter(item => item?.type === 'output_text' && typeof item.text === 'string').map(item => item.text)
  const text = texts.length ? texts.join('') : deltas
  if (!text) throw aiError('AI_INVALID_RESPONSE', 'ChatGPT 未返回可解析的消息内容。')
  responseLimit('content', Buffer.byteLength(text))
  await observer?.text('content', text, true)
  const usage = {}
  for (const [source, target] of [['input_tokens', 'prompt_tokens'], ['output_tokens', 'completion_tokens'], ['total_tokens', 'total_tokens']]) {
    if (Number.isSafeInteger(response.usage?.[source]) && response.usage[source] >= 0) usage[target] = response.usage[source]
  }
  observer?.usage(usage, response.model)
  const value = parseJsonObject(text)
  await observer?.parsed(value)
  return { value, usage, model: typeof response.model === 'string' ? response.model : requestedModel }
}

const parseResponseStream = async (response, requestedModel, signal, onData, observer) => {
  checkResponseLength(response)
  if (!response.body) throw aiError('AI_INVALID_RESPONSE', 'ChatGPT 未返回响应流。')
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let length = 0
  let deltas = ''
  let contentBytes = 0
  const consume = async frame => {
    const lines = frame.split(/\r?\n/)
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
    if (!data || data === '[DONE]') return null
    let event
    try { event = JSON.parse(data) } catch {
      throw aiError('AI_INVALID_RESPONSE', 'ChatGPT 返回的响应事件格式无效。')
    }
    const type = event?.type || lines.find(line => line.startsWith('event:'))?.slice(6).trim()
    if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
      deltas += event.delta
      contentBytes += Buffer.byteLength(event.delta)
      await observer?.text('content', event.delta)
      responseLimit('content', contentBytes)
    }
    if (['response.reasoning_summary_text.delta', 'response.reasoning_text.delta'].includes(type) && typeof event.delta === 'string') await observer?.text('reasoning', event.delta)
    if (type === 'response.refusal.delta' || type === 'response.refusal.done') throw aiError('AI_REFUSED', 'AI 服务未完成本次内容分析。')
    if (type === 'response.failed' || type === 'error') throw responseFailure(event)
    if (type === 'response.incomplete') throw aiError('AI_RESPONSE_TRUNCATED', 'ChatGPT 返回内容被截断，请缩小本次分析范围。')
    if (type === 'response.completed') { observer?.received(); return completedResult(event.response, deltas, requestedModel, observer) }
    return null
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
      const frame = pending.slice(0, separator.index)
      pending = pending.slice(separator.index + separator[0].length)
      const result = await consume(frame)
      if (result) return result
    }
  }
  if (signal?.aborted) throw cancelledError()
  pending += decoder.end()
  if (pending.trim()) {
    const result = await consume(pending)
    if (result) return result
  }
  throw aiError('AI_RESPONSE_TRUNCATED', 'ChatGPT 响应流提前结束，请重试。')
}

const parseChatGptModels = text => {
  let body
  try { body = JSON.parse(text) } catch {
    throw aiError('AI_INVALID_MODEL_LIST', 'ChatGPT 返回的模型列表格式无效。')
  }
  if (!Array.isArray(body?.models)) throw aiError('AI_INVALID_MODEL_LIST', 'ChatGPT 返回的模型列表格式无效。')
  const seen = new Set()
  const modelOptions = []
  for (const item of body.models) {
    const id = typeof item?.slug === 'string' ? item.slug.trim() : ''
    if (item?.visibility !== 'list' || !id || seen.has(id)) continue
    seen.add(id)
    const option = { id, label: typeof item.display_name === 'string' && item.display_name.trim() ? item.display_name.trim() : id }
    const supported = item.supported_reasoning_levels ?? item.supported_reasoning_efforts
    if (Array.isArray(supported)) option.reasoningEfforts = [...new Set(supported.map(value => typeof value === 'string' ? value : value?.effort).filter(value => reasoningEfforts.includes(value)))]
    const defaultEffort = item.default_reasoning_level ?? item.default_reasoning_effort
    if (reasoningEfforts.includes(defaultEffort)) option.defaultReasoningEffort = defaultEffort
    modelOptions.push(option)
  }
  return { models: modelOptions.map(item => item.id), modelOptions }
}

const createResponsesTransport = ({ fetchImpl, getOAuthCredential, logger }) => {
  const catalogs = new Map()
  const perform = async ({ current, signal, body, models = false, trace }) => {
    if (signal?.aborted) throw cancelledError()
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
      let rejectedAccessToken
      for (let attempt = 0; attempt < 2; attempt++) {
        if (controller.signal.aborted) throw cancelledError()
        const credential = await getOAuthCredential(current.provider, { forceRefresh: attempt === 1, signal: controller.signal, rejectedAccessToken })
        if (controller.signal.aborted) throw cancelledError()
        if (!credential || !['codex', 'siwc'].includes(credential.kind) || !credential.accessToken) {
          throw aiError('AI_AUTH_REQUIRED', '请先登录 ChatGPT 或导入有效的 JSON 凭据。')
        }
        const catalogKey = `${current.provider}:${credential.credentialId || `${credential.kind}:${credential.accountId || ''}`}`
        const selected = catalogs.get(catalogKey)?.find(option => option.id === current.model)
        if (!models && Array.isArray(selected?.reasoningEfforts) && !selected.reasoningEfforts.includes(current.reasoningEffort)) {
          throw aiError('AI_REASONING_UNSUPPORTED', '当前模型不支持所选思考程度，请选择模型支持的档位。')
        }
        const baseUrl = credential.kind === 'codex' ? CODEX_BASE_URL : SIWC_BASE_URL
        const url = new URL(`${baseUrl}/${models ? 'models' : 'responses'}`)
        const headers = {
          Accept: models ? 'application/json' : 'text/event-stream',
          Authorization: `Bearer ${credential.accessToken}`
        }
        if (!models) headers['Content-Type'] = 'application/json'
        if (credential.kind === 'codex') {
          if (!credential.accountId) throw aiError('AI_AUTH_REQUIRED', 'Codex JSON 凭据缺少账户 ID，请重新导入完整凭据。')
          // Source: openai/codex, model-provider/src/bearer_auth_provider.rs.
          headers['ChatGPT-Account-ID'] = credential.accountId
          headers.originator = 'exhentai_manga_manager'
          headers['User-Agent'] = `exhentai-manga-manager/${appVersion}`
          if (models) url.searchParams.set('client_version', appVersion)
        }
        if (trace) trace.attemptStartedAt = trace.clock?.() ?? Date.now()
        await trace?.observer?.startAttempt(attempt + 1, { url: url.toString(), method: models ? 'GET' : 'POST', body })
        const response = await fetchImpl(url.toString(), {
          method: models ? 'GET' : 'POST', headers, body,
          signal: controller.signal, redirect: 'error', size: MAX_STREAM_BYTES
        })
        if (trace) trace.httpStatus = response.status
        trace?.observer?.headers(response)
        if (!response.ok) {
          const text = await readBoundedBody(response, trace?.observer)
          if (controller.signal.aborted) throw cancelledError()
          if (response.status === 401 && attempt === 0) {
            await trace?.observer?.retry('AI_AUTH_FAILED')
            safeAiLog(logger, 'request:retry', { ...trace?.details, attempt: attempt + 2, httpStatus: response.status, errorCode: 'AI_AUTH_FAILED' })
            rejectedAccessToken = credential.accessToken
            continue
          }
          let errorBody
          try { errorBody = JSON.parse(text) } catch {}
          throw responseFailure(errorBody, response.status)
        }
        // Once a successful stream starts, never replay an inference request.
        if (!models) resetTimeout()
        const result = models
          ? parseChatGptModels(await readBoundedBody(response, trace?.observer))
          : await parseResponseStream(response, current.model, controller.signal, resetTimeout, trace?.observer)
        if (trace) trace.tpsDurationMs = Math.max(0, (trace.clock?.() ?? Date.now()) - trace.attemptStartedAt)
        if (controller.signal.aborted) throw cancelledError()
        if (models) {
          for (const key of catalogs.keys()) if (key.startsWith(`${current.provider}:`) && key !== catalogKey) catalogs.delete(key)
          catalogs.set(catalogKey, result.modelOptions)
        }
        return result
      }
    } catch (error) {
      if (timedOut) throw aiError('AI_TIMEOUT', 'AI 服务请求超时。')
      if (signal?.aborted || controller.signal.aborted) throw cancelledError()
      if (error.code?.startsWith('AI_')) throw error
      if (error.type === 'max-size') responseLimit('stream', MAX_STREAM_BYTES + 1)
      throw aiError('AI_NETWORK_ERROR', '无法连接 ChatGPT，请检查网络和代理设置。')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      controller.abort()
    }
  }
  return {
    listModels: options => perform({ ...options, models: true }),
    analyze: async ({ current, payload, systemPrompt, schema, signal, trace }) => {
      let body
      try {
        body = JSON.stringify({
          model: current.model,
          reasoning: { effort: current.reasoningEffort },
          instructions: `${String(systemPrompt || '')}\nReturn one JSON object only.`,
          input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify(payload) }] }],
          text: { format: { type: 'json_schema', name: 'audit_relation', strict: true, schema } },
          store: false,
          stream: true
        })
      } catch {
        throw aiError('AI_INVALID_INPUT', '本次分析数据不能转换为 JSON。')
      }
      if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
        throw aiError('AI_INPUT_TOO_LARGE', 'AI 请求内容超过 128 KiB 限制，请缩小本次分析范围。')
      }
      return perform({ current, signal, body, trace })
    }
  }
}

module.exports = { SIWC_BASE_URL, CODEX_BASE_URL, createResponsesTransport }

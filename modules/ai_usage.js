const { version: appVersion } = require('../package.json')

// The Codex client reads this endpoint with Codex OAuth credentials only.
// Source: openai/codex, backend-client/src/client/rate_limit_resets.rs.
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage'
const MAX_USAGE_BYTES = 256 * 1024
const error = (code, message) => Object.assign(new Error(message), { code })
const cancelled = () => error('AI_CANCELLED', '操作已取消。')

const emptyUsage = (code) => ({ status: 'unavailable', fetchedAt: null, primary: null, secondary: null,
  usageUrl: CHATGPT_USAGE_URL, ...(code ? { error: code } : {}) })

const parseUsageWindow = (window, now) => {
  if (!window || typeof window !== 'object' || Array.isArray(window)) return null
  const used = typeof window.used_percent === 'number' && Number.isFinite(window.used_percent) && window.used_percent >= 0 ? window.used_percent : null
  const duration = typeof window.limit_window_seconds === 'number' && Number.isFinite(window.limit_window_seconds) && window.limit_window_seconds > 0 ? window.limit_window_seconds : null
  const reset = typeof window.reset_at === 'number' && Number.isFinite(window.reset_at) && window.reset_at > 0 ? window.reset_at * 1000 : null
  const after = typeof window.reset_after_seconds === 'number' && Number.isFinite(window.reset_after_seconds) && window.reset_after_seconds >= 0 ? now + window.reset_after_seconds * 1000 : null
  return { remainingPercent: used === null ? null : Math.max(0, Math.min(100, 100 - used)),
    resetsAt: reset ?? after, windowSeconds: duration }
}

const parseCodexUsage = (body, now = Date.now()) => {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.prototype.hasOwnProperty.call(body, 'rate_limit')) {
    throw error('AI_USAGE_INVALID_RESPONSE', 'ChatGPT 额度返回格式无效，请稍后重试。')
  }
  const rateLimit = body.rate_limit
  if (rateLimit !== null && (!rateLimit || typeof rateLimit !== 'object' || Array.isArray(rateLimit))) {
    throw error('AI_USAGE_INVALID_RESPONSE', 'ChatGPT 额度返回格式无效，请稍后重试。')
  }
  const primary = parseUsageWindow(rateLimit?.primary_window, now), secondary = parseUsageWindow(rateLimit?.secondary_window, now)
  return { status: primary || secondary ? 'ready' : 'unavailable', fetchedAt: now, primary, secondary,
    usageUrl: CHATGPT_USAGE_URL, ...(!primary && !secondary ? { error: 'AI_USAGE_UNAVAILABLE' } : {}) }
}

const fetchCodexUsage = async ({ fetchImpl, getCredential, signal, now = Date.now, timeoutMs = 15000 }) => {
  if (signal?.aborted) throw cancelled()
  const controller = new AbortController()
  let timedOut = false
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  try {
    let rejectedAccessToken
    for (let attempt = 0; attempt < 2; attempt++) {
      const credential = await getCredential({ forceRefresh: attempt === 1, rejectedAccessToken, signal: controller.signal })
      if (controller.signal.aborted) throw cancelled()
      // SIWC grants use the public API. They must never be sent to backend-api.
      if (credential?.kind !== 'codex') return emptyUsage('AI_USAGE_UNAVAILABLE')
      if (!credential.accessToken || !credential.accountId) throw error('AI_USAGE_AUTH_FAILED', '请重新导入 ChatGPT 凭据后刷新额度。')
      const response = await fetchImpl(CODEX_USAGE_URL, { method: 'GET', headers: {
        Accept: 'application/json', Authorization: `Bearer ${credential.accessToken}`,
        'ChatGPT-Account-Id': credential.accountId, 'User-Agent': `exhentai-manga-manager/${appVersion}`
      }, signal: controller.signal, redirect: 'error', credentials: 'omit' })
      const chunks = []
      let bytes = 0
      if (Number(response.headers?.get('content-length')) > MAX_USAGE_BYTES) throw error('AI_USAGE_INVALID_RESPONSE', 'ChatGPT 额度返回内容过大。')
      if (response.body) for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > MAX_USAGE_BYTES) throw error('AI_USAGE_INVALID_RESPONSE', 'ChatGPT 额度返回内容过大。')
        chunks.push(buffer)
      }
      if (controller.signal.aborted) throw cancelled()
      if (response.status === 401 && attempt === 0) { rejectedAccessToken = credential.accessToken; continue }
      if (!response.ok) {
        if (response.status === 401) throw error('AI_USAGE_AUTH_FAILED', 'ChatGPT 登录已失效，请重新导入凭据后刷新额度。')
        if (response.status === 403) throw error('AI_USAGE_FORBIDDEN', '当前账户暂时无法读取额度，请到 ChatGPT 用量页面查看。')
        if (response.status === 429) throw error('AI_USAGE_RATE_LIMITED', '额度刷新过于频繁，请稍后重试。')
        throw error('AI_USAGE_REQUEST_FAILED', '无法读取 ChatGPT 额度，请稍后重试。')
      }
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw error('AI_USAGE_INVALID_RESPONSE', 'ChatGPT 额度返回格式无效，请稍后重试。') }
      return parseCodexUsage(body, now())
    }
  } catch (cause) {
    if (signal?.aborted) throw cancelled()
    if (timedOut) throw error('AI_USAGE_TIMEOUT', '读取 ChatGPT 额度超时，请检查网络和代理。')
    if (cause.code?.startsWith('AI_')) throw cause
    throw error('AI_USAGE_REQUEST_FAILED', '无法连接 ChatGPT 额度服务，请检查网络和代理。')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    controller.abort()
  }
}

module.exports = { CHATGPT_USAGE_URL, CODEX_USAGE_URL, emptyUsage, parseCodexUsage, fetchCodexUsage }

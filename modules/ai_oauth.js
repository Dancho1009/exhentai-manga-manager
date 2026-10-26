const http = require('http')
const { EventEmitter } = require('events')
const { randomBytes, randomUUID, createHash, createPublicKey, verify, timingSafeEqual } = require('crypto')
const nodeFetch = require('node-fetch')
const { AiCredentialStore } = require('./ai_credentials.js')
const { emptyUsage, fetchCodexUsage } = require('./ai_usage.js')

const ISSUER = 'https://auth.openai.com'
const RESOURCE = 'https://api.openai.com/v1'
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`
const CODEX_AUTHORIZE_URL = `${ISSUER}/oauth/authorize`
const CODEX_TOKEN_URL = `${ISSUER}/oauth/token`
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`
const PLAN_SCOPE = 'chatgpt.tokens.use.direct'
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const PROVIDERS = ['chatgpt-json', 'chatgpt-account']
const MAX_JSON_BYTES = 256 * 1024
const fail = (code, message) => Object.assign(new Error(message), { code })
const cancelled = () => fail('AI_CANCELLED', '操作已取消。')
const string = value => typeof value === 'string' ? value.trim() : ''
const emailOf = value => {
  const email = string(value)
  return email.length <= 254 && /^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+$/.test(email) ? email : ''
}
const accountEmail = record => emailOf(record.email) || emailOf(jwtParts(record.idToken || '')?.claims?.email) ||
  emailOf(jwtParts(record.accessToken || '')?.claims?.['https://api.openai.com/profile']?.email)
const scopesOf = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : string(value).split(/\s+/).filter(Boolean)
const jwtParts = token => {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    return { header: JSON.parse(Buffer.from(parts[0], 'base64url')), claims: JSON.parse(Buffer.from(parts[1], 'base64url')), parts }
  } catch { return null }
}
const epochMs = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  if (typeof value === 'string' && value.trim()) {
    if (/^\d+(?:\.\d+)?$/.test(value)) return epochMs(Number(value))
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}
const tokenExpiry = (tokens, claims, now) => epochMs(tokens.expires_at ?? tokens.expiry ?? tokens.expired) ||
  epochMs(claims?.exp) || (Number(tokens.expires_in) > 0 && epochMs(tokens.saved_at) ? epochMs(tokens.saved_at) + Number(tokens.expires_in) * 1000 : null)
const assertProvider = provider => {
  if (!PROVIDERS.includes(provider)) throw fail('AI_INVALID_PROVIDER', '不支持的 AI 登录方式。')
}
const sameSecret = (left, right) => {
  const a = Buffer.from(left), b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
const maskedLabel = record => {
  if (record.email && record.identityVerified) {
    const [local, domain] = record.email.split('@')
    if (local && domain) return `${local.slice(0, 2)}***@${domain}`.slice(0, 100)
  }
  return `ChatGPT · …${string(record.accountId || record.subject || record.clientId || record.credentialId).slice(-6)}`
}

// Parsing never turns pasted JWT claims into a verified account identity.
const parseOAuthJson = (json, now = Date.now()) => {
  if (typeof json !== 'string' || Buffer.byteLength(json) > MAX_JSON_BYTES) throw fail('AI_OAUTH_JSON_INVALID', '请粘贴不超过 256 KiB 的 OAuth JSON。')
  let source
  try { source = JSON.parse(json) } catch { throw fail('AI_OAUTH_JSON_INVALID', 'JSON 格式无效，请粘贴完整的 OAuth JSON。') }
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw fail('AI_OAUTH_JSON_INVALID', 'OAuth JSON 必须是对象。')
  const tokens = source.tokens && typeof source.tokens === 'object' && !Array.isArray(source.tokens) ? source.tokens : source
  const accessToken = string(tokens.access_token ?? tokens.accessToken)
  if (!accessToken || /\s/.test(accessToken)) throw fail('AI_OAUTH_JSON_INVALID', 'OAuth JSON 缺少有效的 access_token。')
  const access = jwtParts(accessToken)?.claims
  const idToken = string(tokens.id_token ?? tokens.idToken ?? source.id_token)
  const idClaims = jwtParts(idToken)?.claims
  const scopes = scopesOf(tokens.scope ?? source.scope ?? source.scopes ?? access?.scope)
  const suppliedClient = string(source.client_id ?? tokens.client_id ?? source.clientId ?? access?.client_id)
  const audience = Array.isArray(access?.aud) ? access.aud : [access?.aud]
  const kind = scopes.includes(PLAN_SCOPE) || suppliedClient.startsWith('oaiapp_') || source.kind === 'siwc' ? 'siwc' : 'codex'
  const idAudiences = Array.isArray(idClaims?.aud) ? idClaims.aud : [idClaims?.aud]
  const clientId = suppliedClient || (kind === 'codex' ? [...audience, ...idAudiences].find(item => item === CODEX_CLIENT_ID) || '' : '')
  const accountId = string(tokens.account_id ?? source.account_id ?? source.chatgptAccountId ?? access?.['https://api.openai.com/auth']?.chatgpt_account_id ?? idClaims?.['https://api.openai.com/auth']?.chatgpt_account_id)
  if (kind === 'codex' && !accountId) throw fail('AI_OAUTH_JSON_INVALID', 'Codex OAuth JSON 缺少 account_id。')
  if (kind === 'siwc' && (!clientId || clientId === 'dynamic_agent_client' || !scopes.includes(PLAN_SCOPE))) {
    throw fail('AI_OAUTH_SCOPE_REQUIRED', '凭据缺少 ChatGPT 调用授权或注册信息，请使用网页登录。')
  }
  return {
    version: 1, kind, credentialId: randomUUID(), accessToken,
    refreshToken: string(tokens.refresh_token ?? tokens.refreshToken ?? source.refresh_token), idToken,
    accountId, clientId, scopes, expiresAt: tokenExpiry({ ...source, ...tokens }, access, now),
    subject: '', email: emailOf(idClaims?.email ?? access?.['https://api.openai.com/profile']?.email ?? tokens.email ?? source.email), identityVerified: false,
    loggedInAt: null, importedAt: now, savedAt: now, hostId: string(source.ext_agent_host_id), earliestRefreshAt: epochMs(tokens.earliest_refresh_at)
  }
}

class AiOAuthManager extends EventEmitter {
  constructor({ storePath, safeStorage, fetchImpl = nodeFetch, openExternal = () => {}, appName = 'ExHentai Manga Manager', now = Date.now, loginTimeoutMs = 5 * 60 * 1000, callbackPorts = [1455, 1457] }) {
    super()
    Object.assign(this, { storePath, fetchImpl, openExternal, appName, now, loginTimeoutMs, callbackPorts })
    this.stores = Object.fromEntries(PROVIDERS.map(slot => [slot, new AiCredentialStore({ storePath, safeStorage, slot })]))
    this.revisions = { 'chatgpt-json': 0, 'chatgpt-account': 0 }
    this.refreshing = new Map()
    this.usageStates = new Map()
    this.usageRefreshing = new Map()
    this.failures = new Map()
    this.pendingLogin = null
    this.startingLogin = null
    this.closed = false
  }

  async read(provider) {
    assertProvider(provider)
    const text = await this.stores[provider].get()
    if (!text) return null
    try {
      const record = JSON.parse(text)
      if (record.version !== 1 || !['siwc', 'codex'].includes(record.kind)) throw new Error('INVALID')
      return record
    } catch { throw fail('AI_CREDENTIAL_DECRYPT_FAILED', '已保存的 ChatGPT 凭据无效，请重新导入或登录。') }
  }

  async getState(provider = 'chatgpt-account') {
    const record = await this.read(provider)
    const hasCredential = Boolean(record?.accessToken)
    const canRefresh = Boolean(record?.refreshToken && record.clientId && (record.kind === 'siwc' || record.clientId === CODEX_CLIENT_ID))
    const expired = hasCredential && record.expiresAt !== null && record.expiresAt <= this.now()
    const error = provider === 'chatgpt-account' && hasCredential && record.kind !== 'codex' ? 'AI_OAUTH_RELOGIN_REQUIRED' : this.failures.get(provider)
    const pending = provider === 'chatgpt-account' ? this.pendingLogin : null
    return {
      provider, credentialId: hasCredential ? record.credentialId : null,
      hasCredential, usable: hasCredential && (!expired || canRefresh) && !['AI_OAUTH_EXPIRED', 'AI_OAUTH_RELOGIN_REQUIRED'].includes(error),
      status: pending ? pending.status : error ? (error === 'AI_OAUTH_EXPIRED' ? 'expired' : 'failed') : !hasCredential ? 'signed-out' : expired && !canRefresh ? 'expired' : provider === 'chatgpt-json' ? 'imported' : 'signed-in',
      account: hasCredential ? { label: maskedLabel(record), kind: record.kind, expiresAt: record.expiresAt, canRefresh,
        email: accountEmail(record) || null, identityVerified: record.identityVerified === true,
        loggedInAt: epochMs(record.loggedInAt), importedAt: epochMs(record.importedAt) } : null,
      usage: hasCredential ? this.usageState(provider, record) : emptyUsage(),
      loginPending: Boolean(pending), ...(error ? { error } : {})
    }
  }

  async publish(provider) {
    const state = await this.getState(provider)
    if (!this.closed) this.emit('state', state)
    return state
  }

  usageState(provider, record) {
    const cached = this.usageStates.get(provider)
    return cached?.credentialId === record.credentialId ? { ...cached.state } : emptyUsage(record.kind === 'siwc' ? 'AI_USAGE_UNAVAILABLE' : undefined)
  }

  clearUsage(provider) {
    this.usageRefreshing.get(provider)?.controller.abort()
    this.usageRefreshing.delete(provider)
    this.usageStates.delete(provider)
  }

  async refreshUsage(provider) {
    assertProvider(provider)
    if (this.closed) throw cancelled()
    if (this.usageRefreshing.has(provider)) return this.usageRefreshing.get(provider).operation
    const record = await this.read(provider)
    if (!record?.accessToken) throw fail('AI_OAUTH_REQUIRED', '请先导入 ChatGPT 凭据或完成网页登录。')
    if (this.usageRefreshing.has(provider)) return this.usageRefreshing.get(provider).operation
    if (record.kind === 'siwc') {
      this.usageStates.set(provider, { credentialId: record.credentialId, state: emptyUsage('AI_USAGE_UNAVAILABLE') })
      return this.publish(provider)
    }
    const revision = this.revisions[provider]
    const previous = this.usageState(provider, record)
    this.usageStates.set(provider, { credentialId: record.credentialId, state: { ...previous, status: 'loading', error: undefined } })
    const controller = new AbortController()
    const operation = (async () => {
      await this.publish(provider)
      try {
        const state = await fetchCodexUsage({ fetchImpl: this.fetchImpl, now: this.now, signal: controller.signal,
          getCredential: options => this.getCredential(provider, options) })
        if (controller.signal.aborted || revision !== this.revisions[provider] || this.closed) throw cancelled()
        this.usageStates.set(provider, { credentialId: record.credentialId, state })
      } catch (error) {
        if (controller.signal.aborted || revision !== this.revisions[provider] || this.closed) throw cancelled()
        this.usageStates.set(provider, { credentialId: record.credentialId, state: { ...previous, status: 'failed', error: error.code?.startsWith('AI_') ? error.code : 'AI_USAGE_REQUEST_FAILED' } })
      }
      return this.publish(provider)
    })().finally(() => { if (this.usageRefreshing.get(provider)?.operation === operation) this.usageRefreshing.delete(provider) })
    this.usageRefreshing.set(provider, { operation, controller })
    return operation
  }

  async importJson(json) {
    const record = parseOAuthJson(json, this.now())
    if (record.kind === 'siwc' && record.idToken) {
      const claims = await this.validateIdToken(record.idToken, record.clientId, { allowExpired: true })
      Object.assign(record, { subject: claims.sub, email: emailOf(claims.email), identityVerified: true })
    }
    if (this.closed) throw cancelled()
    this.revisions['chatgpt-json']++
    this.clearUsage('chatgpt-json')
    await this.stores['chatgpt-json'].set(JSON.stringify(record))
    this.failures.delete('chatgpt-json')
    return this.publish('chatgpt-json')
  }

  async requestJson(url, { body, signal, method = 'POST', timeoutMs = 30000, optionalEmpty = false, jsonBody = false } = {}) {
    if (signal?.aborted || this.closed) throw cancelled()
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    const timer = setTimeout(abort, timeoutMs)
    try {
      const response = await this.fetchImpl(url, { method, headers: body ? { 'Content-Type': jsonBody ? 'application/json' : 'application/x-www-form-urlencoded', Accept: 'application/json' } : { Accept: 'application/json' },
        ...(body ? { body: jsonBody ? JSON.stringify(body) : new URLSearchParams(body).toString() } : {}), signal: controller.signal, redirect: 'error' })
      let bytes = 0
      const chunks = []
      if (response.body) for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > MAX_JSON_BYTES) throw fail('AI_OAUTH_NETWORK_ERROR', '登录服务返回内容过大。')
        chunks.push(buffer)
      }
      if (controller.signal.aborted) throw cancelled()
      if (!response.ok) {
        if ([400, 401, 403].includes(response.status)) throw fail('AI_OAUTH_EXPIRED', '授权已失效，请重新导入凭据或网页登录。')
        throw fail('AI_OAUTH_NETWORK_ERROR', '无法完成 ChatGPT 授权请求，请稍后重试。')
      }
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text && optionalEmpty) return {}
      try { return JSON.parse(text) } catch { throw fail('AI_OAUTH_NETWORK_ERROR', '登录服务返回格式无效。') }
    } catch (error) {
      if (signal?.aborted || this.closed) throw cancelled()
      if (error.code?.startsWith('AI_')) throw error
      throw fail('AI_OAUTH_NETWORK_ERROR', '无法连接 ChatGPT 登录服务，请检查网络和代理。')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      controller.abort()
    }
  }

  async discovery(signal) {
    if (!this.discoveryDocument) {
      const document = await this.requestJson(DISCOVERY_URL, { method: 'GET', signal })
      let jwks
      try { jwks = new URL(document.jwks_uri) } catch {}
      if (document.issuer !== ISSUER || !jwks || jwks.origin !== ISSUER || jwks.username || jwks.password || jwks.hash) throw fail('AI_OAUTH_IDENTITY_INVALID', '无法验证 ChatGPT 登录服务身份。')
      this.discoveryDocument = document
    }
    return this.discoveryDocument
  }

  async validateIdToken(token, clientId, { nonce, subject, allowExpired = false, signal } = {}) {
    const jwt = jwtParts(token)
    const invalid = () => fail('AI_OAUTH_IDENTITY_INVALID', 'ChatGPT 账户身份验证失败，请重新登录。')
    if (!jwt || !['RS256', 'ES256', 'EdDSA'].includes(jwt.header.alg) || !string(jwt.header.kid)) throw invalid()
    const discovery = await this.discovery(signal)
    if (!this.jwks?.keys?.some(key => key.kid === jwt.header.kid)) this.jwks = await this.requestJson(discovery.jwks_uri, { method: 'GET', signal })
    const jwk = this.jwks?.keys?.find(key => key.kid === jwt.header.kid && (!key.use || key.use === 'sig') && (!key.alg || key.alg === jwt.header.alg))
    if (!jwk || (jwt.header.alg === 'RS256' && jwk.kty !== 'RSA') || (jwt.header.alg === 'ES256' && jwk.kty !== 'EC') || (jwt.header.alg === 'EdDSA' && jwk.kty !== 'OKP')) throw invalid()
    let valid = false
    try {
      const key = createPublicKey({ key: jwk, format: 'jwk' })
      const algorithm = jwt.header.alg === 'EdDSA' ? null : jwt.header.alg === 'RS256' ? 'RSA-SHA256' : 'sha256'
      valid = verify(algorithm, Buffer.from(jwt.parts.slice(0, 2).join('.')), { key, ...(jwt.header.alg === 'ES256' ? { dsaEncoding: 'ieee-p1363' } : {}) }, Buffer.from(jwt.parts[2], 'base64url'))
    } catch {}
    const claims = jwt.claims, now = this.now() / 1000
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!valid || claims.iss !== ISSUER || !audiences.includes(clientId) || !string(claims.sub) || !Number.isFinite(claims.exp) || (!allowExpired && claims.exp <= now - 30) || (Number.isFinite(claims.nbf) && claims.nbf > now + 30) || (nonce !== undefined && claims.nonce !== nonce) || (subject && claims.sub !== subject)) throw invalid()
    return claims
  }

  async startLogin(options = {}) {
    if (this.pendingLogin) return this.getState('chatgpt-account')
    if (this.startingLogin) return this.startingLogin
    this.startingLogin = this.beginLogin(options).finally(() => { this.startingLogin = null })
    return this.startingLogin
  }

  async beginLogin({ newAccount = false } = {}) {
    if (this.closed) throw cancelled()
    const saved = newAccount ? null : await this.read('chatgpt-account')
    const previous = saved?.kind === 'codex' ? saved : null
    const attempt = { status: 'waiting', state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'), verifier: randomBytes(48).toString('base64url'),
      clientId: CODEX_CLIENT_ID, subject: previous?.subject || '', accountId: previous?.accountId || '', controller: new AbortController(), revision: this.revisions['chatgpt-account'] }
    const server = http.createServer((req, res) => { void this.handleCallback(attempt, req, res).catch(() => { if (!res.writableEnded) res.end('Sign-in failed. Return to the app.'); void this.finishLogin(attempt, 'AI_OAUTH_LOGIN_FAILED') }) })
    server.requestTimeout = 10000
    server.headersTimeout = 10000
    attempt.server = server
    try {
      // These two loopback ports are registered by the Codex public OAuth client.
      // Source: openai/codex, login/src/server.rs (DEFAULT_PORT/FALLBACK_PORT).
      let bound = false
      for (const port of this.callbackPorts) {
        try {
          await new Promise((resolve, reject) => {
            const onError = error => { server.removeListener('listening', onListening); reject(error) }
            const onListening = () => { server.removeListener('error', onError); resolve() }
            server.once('error', onError)
            server.once('listening', onListening)
            server.listen(port, '127.0.0.1')
          })
          bound = true
          break
        } catch (error) { if (error.code !== 'EADDRINUSE') throw error }
      }
      if (!bound) throw fail('AI_OAUTH_CALLBACK_BUSY', 'ChatGPT 登录回调端口正被其他程序占用，请完成或取消其他登录后重试。')
      if (this.closed || attempt.revision !== this.revisions['chatgpt-account']) throw cancelled()
      attempt.redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`
      const url = new URL(CODEX_AUTHORIZE_URL)
      const params = { client_id: CODEX_CLIENT_ID, response_type: 'code', redirect_uri: attempt.redirectUri,
        scope: 'openid profile email offline_access', state: attempt.state, nonce: attempt.nonce,
        code_challenge_method: 'S256', code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
        id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'exhentai_manga_manager' }
      if (previous?.email) params.login_hint = previous.email
      if (newAccount) params.prompt = 'select_account'
      url.search = new URLSearchParams(params).toString()
      attempt.url = url.toString()
      this.pendingLogin = attempt
      this.failures.delete('chatgpt-account')
      attempt.timer = setTimeout(() => { void this.finishLogin(attempt, 'AI_OAUTH_LOGIN_TIMEOUT') }, this.loginTimeoutMs)
      attempt.timer.unref?.()
      try { await this.openExternal(attempt.url) } catch { throw fail('AI_OAUTH_BROWSER_FAILED', '无法打开浏览器，请重试网页登录。') }
      return this.publish('chatgpt-account')
    } catch (error) {
      if (this.pendingLogin === attempt) await this.finishLogin(attempt, error.code || 'AI_OAUTH_LOGIN_FAILED')
      else server.close()
      if (error.code?.startsWith('AI_')) throw error
      throw fail('AI_OAUTH_LOGIN_FAILED', '无法启动 ChatGPT 网页登录，请重试。')
    }
  }

  async handleCallback(attempt, req, res) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    let url
    try { url = new URL(req.url, attempt.redirectUri) } catch { res.writeHead(400).end('Invalid callback.'); return }
    if (req.method !== 'GET' || url.pathname !== '/auth/callback') { res.writeHead(404).end('Not found.'); return }
    if (this.pendingLogin !== attempt || attempt.status !== 'waiting' || !sameSecret(url.searchParams.get('state') || '', attempt.state)) { res.writeHead(400).end('Invalid sign-in state. Return to the app.'); return }
    const clientId = string(url.searchParams.get('client_id')) || attempt.clientId
    if (url.searchParams.has('error')) {
      res.writeHead(400).end('Authorization was not completed. Return to the app.')
      await this.finishLogin(attempt, 'AI_OAUTH_SCOPE_REQUIRED')
      return
    }
    if (!url.searchParams.get('code') || clientId !== CODEX_CLIENT_ID) {
      res.writeHead(400).end('Incomplete registration. Return to the app.')
      await this.finishLogin(attempt, 'AI_OAUTH_CALLBACK_INVALID')
      return
    }
    attempt.status = 'exchanging'
    await this.publish('chatgpt-account')
    try {
      const tokens = await this.requestJson(CODEX_TOKEN_URL, { signal: attempt.controller.signal, body: { grant_type: 'authorization_code', client_id: clientId,
        code: url.searchParams.get('code'), code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri } })
      const claims = await this.validateIdToken(string(tokens.id_token), clientId, { nonce: attempt.nonce, subject: attempt.subject, signal: attempt.controller.signal })
      const scopes = scopesOf(tokens.scope)
      const accountId = string(claims['https://api.openai.com/auth']?.chatgpt_account_id)
      if (!accountId || (attempt.accountId && accountId !== attempt.accountId)) throw fail('AI_OAUTH_IDENTITY_INVALID', 'ChatGPT 账户身份验证失败，请重新登录。')
      if (!string(tokens.access_token)) throw fail('AI_OAUTH_LOGIN_FAILED', '登录服务未返回有效凭据，请重新登录。')
      const expiresAt = Number(tokens.expires_in) > 0 ? this.now() + Number(tokens.expires_in) * 1000 : epochMs(jwtParts(tokens.access_token)?.claims?.exp)
      const record = { version: 1, kind: 'codex', credentialId: randomUUID(), clientId, accountId, subject: claims.sub, email: emailOf(claims.email), identityVerified: true,
        accessToken: tokens.access_token, refreshToken: string(tokens.refresh_token), idToken: tokens.id_token, scopes,
        loggedInAt: this.now(), importedAt: null, expiresAt, savedAt: this.now(), earliestRefreshAt: epochMs(tokens.earliest_refresh_at) }
      if (this.pendingLogin !== attempt || attempt.controller.signal.aborted || attempt.revision !== this.revisions['chatgpt-account']) throw cancelled()
      this.revisions['chatgpt-account']++
      this.clearUsage('chatgpt-account')
      await this.stores['chatgpt-account'].set(JSON.stringify(record))
      this.failures.delete('chatgpt-account')
      res.end('ChatGPT sign-in complete. You can close this page and return to the app.')
      await this.finishLogin(attempt)
    } catch (error) {
      if (!res.writableEnded) res.writeHead(400).end('Sign-in failed. Return to the app for details.')
      await this.finishLogin(attempt, error.code?.startsWith('AI_') ? error.code : 'AI_OAUTH_LOGIN_FAILED')
    }
  }

  async finishLogin(attempt, error) {
    if (this.pendingLogin !== attempt) return
    this.pendingLogin = null
    clearTimeout(attempt.timer)
    attempt.controller.abort()
    attempt.server.close()
    attempt.server.closeIdleConnections?.()
    if (error && error !== 'AI_CANCELLED') this.failures.set('chatgpt-account', error)
    return this.publish('chatgpt-account')
  }

  async reopenLogin() {
    const attempt = this.pendingLogin
    if (!attempt) throw fail('AI_OAUTH_REQUIRED', '请先开始 ChatGPT 网页登录。')
    try { await this.openExternal(attempt.url) } catch { throw fail('AI_OAUTH_BROWSER_FAILED', '无法打开浏览器，请重试网页登录。') }
    return this.getState('chatgpt-account')
  }

  async cancelLogin() {
    this.revisions['chatgpt-account']++
    if (this.pendingLogin) await this.finishLogin(this.pendingLogin, 'AI_CANCELLED')
    return this.getState('chatgpt-account')
  }

  async getCredential(provider, { forceRefresh = false, rejectedAccessToken, signal } = {}) {
    assertProvider(provider)
    if (signal?.aborted || this.closed) throw cancelled()
    const record = await this.read(provider)
    if (!record?.accessToken) throw fail('AI_OAUTH_REQUIRED', '请先导入 ChatGPT 凭据或完成网页登录。')
    if (provider === 'chatgpt-account' && record.kind !== 'codex') throw fail('AI_OAUTH_RELOGIN_REQUIRED', '网页登录方式已更新，请重新登录 ChatGPT 以读取账户额度。')
    if (forceRefresh && rejectedAccessToken && record.accessToken !== rejectedAccessToken) return record
    const expired = record.expiresAt !== null && record.expiresAt <= this.now() + 60000
    if (!forceRefresh && record.earliestRefreshAt > this.now() && record.expiresAt > this.now()) return record
    if (!forceRefresh && !expired) return record
    if (!record.refreshToken || !record.clientId || (record.kind === 'codex' && record.clientId !== CODEX_CLIENT_ID)) {
      if (!forceRefresh && (record.expiresAt === null || record.expiresAt > this.now())) return record
      this.failures.set(provider, 'AI_OAUTH_EXPIRED')
      await this.publish(provider)
      throw fail('AI_OAUTH_EXPIRED', 'ChatGPT 凭据已过期，请重新导入或网页登录。')
    }
    if (!this.refreshing.has(provider)) {
      const controller = new AbortController(), revision = this.revisions[provider]
      const operation = this.refreshRecord(provider, record, revision, controller.signal).finally(() => { this.refreshing.delete(provider) })
      // Several audit requests share one rotating refresh token.
      operation.catch(() => {})
      this.refreshing.set(provider, { operation, controller })
    }
    const operation = this.refreshing.get(provider).operation
    if (!signal) return operation
    return new Promise((resolve, reject) => {
      const abort = () => reject(cancelled())
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }

  async refreshRecord(provider, record, revision, signal) {
    try {
      const body = { grant_type: 'refresh_token', client_id: record.clientId, refresh_token: record.refreshToken }
      if (record.kind === 'siwc') body.resource = RESOURCE
      const tokens = await this.requestJson(record.kind === 'siwc' ? TOKEN_URL : `${ISSUER}/oauth/token`, { body, signal, jsonBody: record.kind === 'codex' })
      if (!string(tokens.access_token)) throw fail('AI_OAUTH_REFRESH_FAILED', 'ChatGPT 凭据续期失败，请重新登录或导入。')
      const claims = jwtParts(tokens.access_token)?.claims
      const refreshedAccount = claims?.['https://api.openai.com/auth']?.chatgpt_account_id
      if ((record.kind === 'codex' && refreshedAccount && record.accountId !== refreshedAccount) || (record.kind === 'siwc' && record.subject && claims?.sub && record.subject !== claims.sub)) {
        throw fail('AI_OAUTH_IDENTITY_INVALID', '续期后的 ChatGPT 账户不一致，请重新登录。')
      }
      const next = { ...record, accessToken: tokens.access_token, refreshToken: string(tokens.refresh_token) || record.refreshToken,
        idToken: string(tokens.id_token) || record.idToken, expiresAt: Number(tokens.expires_in) > 0 ? this.now() + Number(tokens.expires_in) * 1000 : epochMs(claims?.exp),
        scopes: tokens.scope ? scopesOf(tokens.scope) : record.scopes, savedAt: this.now(), earliestRefreshAt: epochMs(tokens.earliest_refresh_at) }
      if (record.kind === 'siwc') {
        if (!next.scopes.includes(PLAN_SCOPE)) throw fail('AI_OAUTH_SCOPE_REQUIRED', 'ChatGPT 调用授权已失效，请重新授权。')
      }
      if (tokens.id_token) {
        const identity = await this.validateIdToken(tokens.id_token, record.clientId, { subject: record.subject || undefined, signal })
        if (record.kind === 'codex' && string(identity['https://api.openai.com/auth']?.chatgpt_account_id) !== record.accountId) {
          throw fail('AI_OAUTH_IDENTITY_INVALID', '续期后的 ChatGPT 账户不一致，请重新登录。')
        }
        next.subject = identity.sub
        next.email = emailOf(identity.email) || record.email
        next.identityVerified = true
      }
      if (signal.aborted || this.closed || revision !== this.revisions[provider]) throw cancelled()
      await this.stores[provider].set(JSON.stringify(next))
      this.failures.delete(provider)
      await this.publish(provider)
      return next
    } catch (error) {
      if (revision === this.revisions[provider] && !signal.aborted && !this.closed) {
        this.failures.set(provider, error.code === 'AI_OAUTH_EXPIRED' ? 'AI_OAUTH_EXPIRED' : 'AI_OAUTH_REFRESH_FAILED')
        await this.publish(provider)
      }
      throw error
    }
  }

  async logout(provider) {
    assertProvider(provider)
    this.revisions[provider]++
    this.clearUsage(provider)
    this.refreshing.get(provider)?.controller.abort()
    if (provider === 'chatgpt-account' && this.pendingLogin) await this.finishLogin(this.pendingLogin, 'AI_CANCELLED')
    const record = await this.read(provider)
    let warning
    if (provider === 'chatgpt-account' && record?.kind === 'codex' && (record.refreshToken || record.accessToken)) {
      // Revoke only the session stored by this application; imported JSON stays local-only.
      // Source: openai/codex, login/src/auth/revoke.rs.
      try {
        const body = record.refreshToken ? { token: record.refreshToken, token_type_hint: 'refresh_token', client_id: record.clientId } :
          { token: record.accessToken, token_type_hint: 'access_token' }
        await this.requestJson(`${ISSUER}/oauth/revoke`, { body, jsonBody: true, timeoutMs: 10000, optionalEmpty: true })
      } catch { warning = 'AI_REVOCATION_UNCONFIRMED' }
    } else if (record?.kind === 'siwc' && record.refreshToken) {
      try {
        const document = await this.discovery()
        const endpoint = new URL(document.revocation_endpoint)
        if (endpoint.origin !== ISSUER || endpoint.username || endpoint.password || endpoint.hash) throw new Error('INVALID_ENDPOINT')
        await this.requestJson(endpoint.toString(), { body: { token: record.refreshToken, token_type_hint: 'refresh_token', client_id: record.clientId }, timeoutMs: 10000, optionalEmpty: true })
      } catch { warning = 'AI_REVOCATION_UNCONFIRMED' }
    }
    if (provider === 'chatgpt-account' && record?.kind === 'siwc') {
      await this.stores[provider].set(JSON.stringify({ ...record, accessToken: '', refreshToken: '', idToken: '' }))
    } else await this.stores[provider].clear()
    this.failures.delete(provider)
    return { ...await this.publish(provider), ...(warning ? { warning } : {}) }
  }

  dispose() {
    this.closed = true
    for (const provider of PROVIDERS) this.revisions[provider]++
    for (const { controller } of this.refreshing.values()) controller.abort()
    for (const { controller } of this.usageRefreshing.values()) controller.abort()
    const attempt = this.pendingLogin
    if (attempt) {
      clearTimeout(attempt.timer)
      attempt.controller.abort()
      attempt.server.close()
      attempt.server.closeAllConnections?.()
      this.pendingLogin = null
    }
  }
}

module.exports = { AiOAuthManager, parseOAuthJson }

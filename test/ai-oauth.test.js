const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { Readable } = require('node:stream')
const http = require('node:http')
const { generateKeyPairSync, sign, randomBytes, createCipheriv, createDecipheriv, createHash } = require('node:crypto')
const fetch = require('node-fetch')
const { Response } = fetch
const { AiOAuthManager, parseOAuthJson } = require('../modules/ai_oauth.js')
const { AiCredentialStore } = require('../modules/ai_credentials.js')

const ISSUER = 'https://auth.openai.com'
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-signing-key', alg: 'RS256', use: 'sig' }
const jwt = claims => {
  const content = [Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url')].join('.')
  return content + '.' + sign('RSA-SHA256', Buffer.from(content), privateKey).toString('base64url')
}
const jsonResponse = (value, status = 200) => new Response(Readable.from([JSON.stringify(value)]), { status, headers: { 'Content-Type': 'application/json' } })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const fixture = async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'emm-oauth-'))
  const secret = randomBytes(32)
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', secret, iv)
      const result = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), result])
    },
    decryptString(value) {
      const cipher = createDecipheriv('aes-256-gcm', secret, value.subarray(0, 12))
      cipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8')
    }
  }
  let clock = Date.now(), authorization, tokenOverrides = {}, fetchOverride
  const calls = [], events = []
  const manager = new AiOAuthManager({ storePath: root, safeStorage, now: () => clock,
    callbackPorts: [0],
    openExternal: async url => { authorization = new URL(url) },
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      if (fetchOverride) { const result = await fetchOverride(url, options); if (result) return result }
      if (url.endsWith('/.well-known/openid-configuration')) return jsonResponse({ issuer: ISSUER, jwks_uri: ISSUER + '/.well-known/jwks.json', revocation_endpoint: ISSUER + '/oauth/revoke' })
      if (url.endsWith('/.well-known/jwks.json')) return jsonResponse({ keys: [jwk] })
      if (url.endsWith('/oauth/revoke')) return new Response('', { status: 200 })
      const body = options.headers['Content-Type'] === 'application/json' ? new URLSearchParams(JSON.parse(options.body)) : new URLSearchParams(options.body)
      return jsonResponse({ access_token: 'codex-access-secret', refresh_token: 'codex-refresh-secret', token_type: 'Bearer', scope: 'openid profile email offline_access', expires_in: 3600,
        id_token: jwt({ iss: ISSUER, aud: body.get('client_id'), sub: 'verified-user', email: 'test@example.invalid', exp: Math.floor(clock / 1000) + 3600,
          'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' },
          ...(body.get('grant_type') === 'authorization_code' ? { nonce: authorization.searchParams.get('nonce') } : {}) }), ...tokenOverrides })
    }
  })
  manager.on('state', state => events.push(state))
  t.after(async () => {
    manager.dispose()
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    await fs.rm(root, { recursive: true, force: true })
  })
  const callback = async (params = {}) => {
    const url = new URL(authorization.searchParams.get('redirect_uri'))
    url.search = new URLSearchParams({ state: authorization.searchParams.get('state'), code: 'code-secret', ...params }).toString()
    const response = await fetch(url)
    const text = await response.text()
    return { status: response.status, text }
  }
  return { root, safeStorage, manager, calls, events, callback, authorization: () => authorization,
    overrideTokens: values => { tokenOverrides = values }, overrideFetch: value => { fetchOverride = value }, advance: ms => { clock += ms }, now: () => clock }
}

test('OAuth JSON accepts top-level and nested Codex tokens and rejects incomplete inputs', () => {
  const source = { access_token: 'private-access', refresh_token: 'private-refresh', account_id: 'private-account' }
  for (const value of [source, { tokens: source }]) {
    const parsed = parseOAuthJson(JSON.stringify(value))
    assert.equal(parsed.kind, 'codex')
    assert.equal(parsed.accountId, source.account_id)
    assert.equal(parsed.refreshToken, source.refresh_token)
    assert.equal(parsed.clientId, '', 'do not invent a refresh client for unknown tokens')
  }
  for (const value of ['[]', 'null', '{}', '{private-access', JSON.stringify({ access_token: 'private-access' })]) {
    assert.throws(() => parseOAuthJson(value), error => error.code === 'AI_OAUTH_JSON_INVALID' && !error.message.includes('private-access'))
  }
  assert.throws(() => parseOAuthJson(JSON.stringify({ access_token: 'opaque', client_id: 'oaiapp_example', account_id: 'a' })), { code: 'AI_OAUTH_SCOPE_REQUIRED' })
  const cached = parseOAuthJson(JSON.stringify({ tokens: { ...source, id_token: jwt({ aud: CODEX_CLIENT_ID }) } }))
  assert.equal(cached.clientId, CODEX_CLIENT_ID, 'A full Codex auth cache can identify its original client using the ID token')
})

test('OAuth slots are encrypted, isolated from the existing API key, and restored after restart', async t => {
  const f = await fixture(t)
  assert.deepEqual(await fs.readdir(f.root), [], 'constructing auth does not do startup work')
  const apiStore = new AiCredentialStore({ storePath: f.root, safeStorage: f.safeStorage })
  await apiStore.set('original-api-key')
  const apiBefore = await fs.readFile(apiStore.filePath, 'utf8')
  const state = await f.manager.importJson(JSON.stringify({ tokens: { access_token: 'private-access', refresh_token: 'private-refresh', account_id: 'account-12345' } }))
  assert.equal(state.status, 'imported')
  assert.equal(state.usable, true)
  assert.equal(state.account.canRefresh, false)
  assert.equal(typeof state.credentialId, 'string')
  assert.doesNotMatch(JSON.stringify(state), /private-access|private-refresh|account-12345/)
  assert.equal((await f.manager.getState('chatgpt-account')).hasCredential, false)
  const disk = await fs.readFile(path.join(f.root, 'ai-chatgpt-json.json'), 'utf8')
  assert.doesNotMatch(disk, /private-access|private-refresh|account-12345/)
  const reopened = new AiOAuthManager({ storePath: f.root, safeStorage: f.safeStorage })
  t.after(() => reopened.dispose())
  assert.equal((await reopened.getCredential('chatgpt-json')).accessToken, 'private-access')
  assert.equal((await reopened.getState('chatgpt-json')).credentialId, state.credentialId)
  await assert.rejects(f.manager.importJson('{broken'), { code: 'AI_OAUTH_JSON_INVALID' })
  assert.equal((await reopened.getState('chatgpt-json')).hasCredential, true)
  await f.manager.logout('chatgpt-json')
  assert.equal((await reopened.getState('chatgpt-json')).hasCredential, false)
  assert.equal(await fs.readFile(apiStore.filePath, 'utf8'), apiBefore)
})

test('expired Codex access tokens refresh once across concurrent calls and save the rotating token', async t => {
  const f = await fixture(t)
  const accessToken = jwt({ aud: [CODEX_CLIENT_ID], exp: Math.floor(f.now() / 1000) - 10 })
  await f.manager.importJson(JSON.stringify({ access_token: accessToken, refresh_token: 'old-refresh', account_id: 'account' }))
  assert.equal((await f.manager.getState('chatgpt-json')).account.canRefresh, true)
  let refreshes = 0
  f.overrideFetch(async (url, options) => {
    if (url !== ISSUER + '/oauth/token') return null
    refreshes++
    assert.equal(options.headers['Content-Type'], 'application/json')
    assert.deepEqual(JSON.parse(options.body), { grant_type: 'refresh_token', client_id: CODEX_CLIENT_ID, refresh_token: 'old-refresh' })
    return jsonResponse({ access_token: 'fresh-access', refresh_token: 'rotated-refresh', expires_in: 3600 })
  })
  const results = await Promise.all(Array.from({ length: 8 }, () => f.manager.getCredential('chatgpt-json')))
  assert.equal(refreshes, 1)
  assert.ok(results.every(record => record.accessToken === 'fresh-access' && record.refreshToken === 'rotated-refresh'))
  const fresh = await f.manager.getCredential('chatgpt-json', { forceRefresh: true, rejectedAccessToken: accessToken })
  assert.equal(fresh.accessToken, 'fresh-access')
  assert.equal(refreshes, 1, 'late 401s reuse the refresh performed by another request')
})

test('unknown refresh client is never guessed and expiry returns a safe re-login error', async t => {
  const f = await fixture(t)
  await f.manager.importJson(JSON.stringify({ access_token: 'unknown-access', refresh_token: 'private-refresh', account_id: 'account', expires_at: f.now() - 1000, client_id: 'unknown-client' }))
  await assert.rejects(f.manager.getCredential('chatgpt-json'), { code: 'AI_OAUTH_EXPIRED' })
  assert.equal(f.calls.length, 0)
  assert.equal((await f.manager.getState('chatgpt-json')).usable, false)
})

test('refresh failures preserve the stored credential and never expose the upstream body', async t => {
  const f = await fixture(t)
  await f.manager.importJson(JSON.stringify({ access_token: 'original-access', refresh_token: 'private-refresh', account_id: 'account', client_id: CODEX_CLIENT_ID }))
  f.overrideFetch(async () => jsonResponse({ error: 'private-refresh original-access' }, 400))
  await assert.rejects(f.manager.getCredential('chatgpt-json', { forceRefresh: true }), error => error.code === 'AI_OAUTH_EXPIRED' && !/private-refresh|original-access/.test(error.message))
  assert.equal((await f.manager.read('chatgpt-json')).accessToken, 'original-access')
  assert.equal((await f.manager.getState('chatgpt-json')).usable, false)
})

test('logout during a refresh prevents late credentials from reappearing', async t => {
  const f = await fixture(t)
  await f.manager.importJson(JSON.stringify({ access_token: 'old-access', refresh_token: 'old-refresh', account_id: 'a', client_id: CODEX_CLIENT_ID }))
  const entered = deferred(), finish = deferred()
  f.overrideFetch(async () => { entered.resolve(); await finish.promise; return jsonResponse({ access_token: 'late-access', refresh_token: 'late-refresh', expires_in: 3600 }) })
  const pending = f.manager.getCredential('chatgpt-json', { forceRefresh: true })
  const rejection = assert.rejects(pending, { code: 'AI_CANCELLED' })
  await entered.promise
  await f.manager.logout('chatgpt-json')
  finish.resolve()
  await rejection
  assert.equal((await f.manager.getState('chatgpt-json')).hasCredential, false)
})

test('Codex web login validates state, PKCE, client and signed account identity before committing', async t => {
  const f = await fixture(t)
  const state = await f.manager.startLogin()
  assert.equal(state.status, 'waiting')
  assert.equal(state.loginPending, true)
  const url = f.authorization()
  assert.equal(url.origin, ISSUER)
  assert.equal(url.pathname, '/oauth/authorize')
  assert.equal(url.searchParams.get('client_id'), CODEX_CLIENT_ID)
  assert.equal(url.searchParams.get('scope'), 'openid profile email offline_access')
  assert.equal(url.searchParams.get('resource'), null)
  assert.equal(new URL(url.searchParams.get('redirect_uri')).hostname, '127.0.0.1')
  const bad = await f.callback({ state: 'incorrect-state' })
  assert.equal(bad.status, 400)
  assert.equal(f.calls.length, 0)
  assert.equal((await f.manager.getState()).loginPending, true)
  const result = await f.callback()
  assert.equal(result.status, 200)
  const record = await f.manager.getCredential('chatgpt-account')
  assert.equal(record.kind, 'codex')
  assert.equal(record.subject, 'verified-user')
  assert.equal(record.clientId, CODEX_CLIENT_ID)
  assert.equal(record.accountId, 'fixture-account')
  assert.equal(record.loggedInAt, f.now())
  const exchange = f.calls.find(call => call.url === ISSUER + '/oauth/token')
  const body = new URLSearchParams(exchange.options.body)
  assert.equal(body.get('client_id'), CODEX_CLIENT_ID)
  assert.equal(exchange.options.headers['Content-Type'], 'application/x-www-form-urlencoded')
  assert.equal(body.has('resource'), false)
  assert.equal(body.get('redirect_uri'), url.searchParams.get('redirect_uri'))
  assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), url.searchParams.get('code_challenge'))
  assert.equal((await f.manager.getState()).status, 'signed-in')
  assert.equal((await f.manager.getState()).account.label, 'te***@example.invalid')
  assert.equal((await f.manager.getState()).account.email, 'test@example.invalid')
  assert.equal((await f.manager.getState()).account.identityVerified, true)
  assert.doesNotMatch(JSON.stringify(f.events), /codex-access-secret|codex-refresh-secret|code-secret|id_token|idToken/)
  await f.manager.startLogin()
  const returning = f.authorization()
  assert.equal(returning.searchParams.get('client_id'), CODEX_CLIENT_ID)
  assert.equal(returning.searchParams.get('agent_name_hint'), null)
  assert.equal(returning.searchParams.get('login_hint'), 'test@example.invalid')
  await f.manager.cancelLogin()
  assert.equal((await f.manager.getState()).status, 'signed-in', 'cancel keeps the active account')
})

for (const failure of ['account', 'nonce', 'signature', 'subject', 'audience']) {
  test(`web login rejects ${failure} without replacing the previous account`, async t => {
    const f = await fixture(t)
    await f.manager.startLogin()
    await f.callback()
    const previous = await f.manager.read('chatgpt-account')
    await f.manager.startLogin()
    {
      const claims = { iss: ISSUER, aud: failure === 'audience' ? 'other-client' : CODEX_CLIENT_ID, sub: failure === 'subject' ? 'other-user' : 'verified-user',
        'https://api.openai.com/auth': { chatgpt_account_id: failure === 'account' ? 'other-account' : 'fixture-account' },
        exp: Math.floor(f.now() / 1000) + 3600, nonce: failure === 'nonce' ? 'incorrect-nonce' : f.authorization().searchParams.get('nonce') }
      let idToken = jwt(claims)
      if (failure === 'signature') idToken = idToken.slice(0, -20) + 'invalid-signature-end'
      f.overrideTokens({ id_token: idToken })
    }
    assert.equal((await f.callback()).status, 400)
    assert.equal((await f.manager.read('chatgpt-account')).credentialId, previous.credentialId)
    assert.equal((await f.manager.getState()).loginPending, false)
    assert.ok((await f.manager.getState()).error)
  })
}

test('Codex Account refresh uses its original client, rotates tokens and preserves login date', async t => {
  const f = await fixture(t)
  await f.manager.startLogin()
  await f.callback()
  const before = await f.manager.read('chatgpt-account')
  f.advance(3600000)
  f.overrideTokens({ access_token: 'renewed-codex-access', refresh_token: 'renewed-codex-refresh' })
  const record = await f.manager.getCredential('chatgpt-account')
  assert.equal(record.accessToken, 'renewed-codex-access')
  assert.equal(record.credentialId, before.credentialId)
  assert.equal(record.loggedInAt, before.loggedInAt)
  const call = f.calls.filter(call => call.url === ISSUER + '/oauth/token').at(-1)
  assert.equal(call.options.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(call.options.body), { grant_type: 'refresh_token', client_id: CODEX_CLIENT_ID, refresh_token: 'codex-refresh-secret' })
})

test('Codex logout revokes only this application session, clears local tokens and supports a fresh login', async t => {
  const f = await fixture(t)
  await f.manager.startLogin()
  await f.callback()
  const result = await f.manager.logout('chatgpt-account')
  assert.equal(result.hasCredential, false)
  const revoke = f.calls.find(call => call.url.endsWith('/oauth/revoke'))
  assert.equal(revoke.options.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(revoke.options.body), { token: 'codex-refresh-secret', token_type_hint: 'refresh_token', client_id: CODEX_CLIENT_ID })
  assert.equal(await f.manager.read('chatgpt-account'), null)
  await f.manager.startLogin()
  assert.equal(f.authorization().searchParams.get('client_id'), CODEX_CLIENT_ID)
  assert.equal(f.authorization().searchParams.get('id_token_hint'), null)
})

test('failed remote revocation still clears local tokens and reports the specific warning', async t => {
  const f = await fixture(t)
  const record = { version: 1, kind: 'siwc', credentialId: 'legacy-siwc', clientId: 'oaiapp_fixture', accessToken: 'legacy-access', refreshToken: 'legacy-refresh', expiresAt: f.now() + 100000, savedAt: f.now() }
  await f.manager.stores['chatgpt-account'].set(JSON.stringify(record))
  f.overrideFetch(async url => url.endsWith('/oauth/revoke') ? jsonResponse({}, 503) : null)
  const result = await f.manager.logout('chatgpt-account')
  assert.equal(result.hasCredential, false)
  assert.equal(result.warning, 'AI_REVOCATION_UNCONFIRMED')
})

test('Codex web login rejects an unexpected callback client before exchanging a code', async t => {
  const f = await fixture(t)
  await f.manager.startLogin()
  assert.equal((await f.callback({ client_id: 'other-client' })).status, 400)
  assert.equal(f.calls.length, 0)
  assert.equal((await f.manager.getState()).hasCredential, false)
})

test('cancel and timeout close the loopback listener without leaving a login or credential', async t => {
  const f = await fixture(t)
  await f.manager.startLogin()
  const url = f.authorization().searchParams.get('redirect_uri')
  await f.manager.reopenLogin()
  await f.manager.cancelLogin()
  await assert.rejects(fetch(url))
  assert.equal((await f.manager.getState()).loginPending, false)
  f.manager.loginTimeoutMs = 10
  const finished = new Promise(resolve => f.manager.once('state', state => { if (!state.loginPending) resolve(state); else f.manager.once('state', resolve) }))
  await f.manager.startLogin()
  const state = await finished
  assert.equal(state.error, 'AI_OAUTH_LOGIN_TIMEOUT')
  assert.equal(state.hasCredential, false)
})

test('JSON account summaries display supplied email as unverified and preserve the import date across refresh', async t => {
  const f = await fixture(t)
  const state = await f.manager.importJson(JSON.stringify({ access_token: 'json-private-access', account_id: 'fixture-account', email: 'pasted@example.invalid',
    refresh_token: 'json-private-refresh', client_id: CODEX_CLIENT_ID }))
  assert.equal(state.account.email, 'pasted@example.invalid')
  assert.equal(state.account.identityVerified, false)
  assert.equal(state.account.loggedInAt, null)
  assert.equal(state.account.importedAt, f.now())
  const importedAt = state.account.importedAt
  f.advance(60000)
  await f.manager.getCredential('chatgpt-json', { forceRefresh: true })
  const refreshed = await f.manager.getState('chatgpt-json')
  assert.equal(refreshed.account.importedAt, importedAt)
  assert.equal(refreshed.account.loggedInAt, null)
  assert.equal(refreshed.account.identityVerified, true, 'a newly signed refresh ID token can establish the displayed identity')
  assert.equal(refreshed.credentialId, state.credentialId)
  assert.doesNotMatch(JSON.stringify(refreshed), /json-private-access|json-private-refresh|codex-access-secret|id_token/)
})

test('legacy SIWC Account requires re-login and cannot reuse its registration in the Codex flow', async t => {
  const f = await fixture(t)
  const record = { version: 1, kind: 'siwc', credentialId: 'legacy-siwc', clientId: 'oaiapp_previous', accessToken: 'old-siwc-secret', refreshToken: 'old-siwc-refresh',
    idToken: jwt({ email: 'legacy@example.invalid' }), subject: 'old-siwc-subject', email: '', expiresAt: f.now() + 100000, savedAt: f.now() - 100000 }
  await f.manager.stores['chatgpt-account'].set(JSON.stringify(record))
  const before = await f.manager.getState('chatgpt-account')
  assert.equal(before.usable, false)
  assert.equal(before.error, 'AI_OAUTH_RELOGIN_REQUIRED')
  assert.equal(before.account.email, 'legacy@example.invalid')
  assert.equal(before.account.loggedInAt, null, 'refresh/write time is not a historical login date')
  await assert.rejects(f.manager.getCredential('chatgpt-account'), { code: 'AI_OAUTH_RELOGIN_REQUIRED' })
  assert.equal(f.calls.length, 0)
  await f.manager.startLogin()
  const url = f.authorization()
  assert.equal(url.pathname, '/oauth/authorize')
  assert.equal(url.searchParams.get('client_id'), CODEX_CLIENT_ID)
  assert.equal(url.searchParams.has('id_token_hint'), false)
  assert.equal(url.searchParams.has('ext_agent_host_id'), false)
  assert.equal((await f.manager.read('chatgpt-account')).credentialId, 'legacy-siwc', 'opening the browser does not discard previous credentials')
  await f.callback()
  const migrated = await f.manager.read('chatgpt-account')
  assert.equal(migrated.kind, 'codex')
  assert.equal(migrated.accountId, 'fixture-account')
  assert.notEqual(migrated.credentialId, 'legacy-siwc')
})

test('SIWC JSON still validates its imported identity and uses the SIWC refresh protocol', async t => {
  const f = await fixture(t)
  const idToken = jwt({ iss: ISSUER, aud: 'oaiapp_json', sub: 'siwc-user', email: 'siwc@example.invalid', exp: Math.floor(f.now() / 1000) + 3600 })
  const state = await f.manager.importJson(JSON.stringify({ kind: 'siwc', access_token: 'siwc-access', refresh_token: 'siwc-refresh', client_id: 'oaiapp_json', scope: SCOPE, id_token: idToken }))
  assert.equal(state.account.kind, 'siwc')
  assert.equal(state.account.identityVerified, true)
  f.overrideTokens({ access_token: 'siwc-new-access', refresh_token: 'siwc-new-refresh', scope: SCOPE,
    id_token: jwt({ iss: ISSUER, aud: 'oaiapp_json', sub: 'siwc-user', email: 'siwc@example.invalid', exp: Math.floor(f.now() / 1000) + 3600 }) })
  await f.manager.getCredential('chatgpt-json', { forceRefresh: true })
  const request = f.calls.find(call => call.url.endsWith('/api/accounts/oauth/token'))
  assert.equal(request.options.headers['Content-Type'], 'application/x-www-form-urlencoded')
  const body = new URLSearchParams(request.options.body)
  assert.equal(body.get('client_id'), 'oaiapp_json')
  assert.equal(body.get('resource'), 'https://api.openai.com/v1')
  assert.equal(body.get('refresh_token'), 'siwc-refresh')
  const calls = f.calls.length
  const unavailable = await f.manager.refreshUsage('chatgpt-json')
  assert.equal(unavailable.usage.status, 'unavailable')
  assert.equal(unavailable.usage.error, 'AI_USAGE_UNAVAILABLE')
  assert.equal(f.calls.length, calls, 'SIWC quota is not guessed from Codex endpoints')
})

test('manual quota refresh shares one request across windows and failure preserves the last successful snapshot', async t => {
  const f = await fixture(t)
  await f.manager.startLogin()
  await f.callback()
  const before = await f.manager.getState('chatgpt-account')
  assert.equal(before.usage.fetchedAt, null)
  const entered = deferred(), finish = deferred()
  let requests = 0
  f.overrideFetch(async url => {
    if (!url.endsWith('/wham/usage')) return null
    requests++
    entered.resolve()
    await finish.promise
    return jsonResponse({ rate_limit: { primary_window: { used_percent: 17, limit_window_seconds: 18000, reset_at: f.now() / 1000 + 60 },
      secondary_window: { used_percent: 3, limit_window_seconds: 604800, reset_at: f.now() / 1000 + 3600 } } })
  })
  const pending = Array.from({ length: 5 }, () => f.manager.refreshUsage('chatgpt-account'))
  await entered.promise
  assert.equal((await f.manager.getState()).usage.status, 'loading')
  finish.resolve()
  const results = await Promise.all(pending)
  assert.equal(requests, 1)
  assert.ok(results.every(value => value.usage.primary.remainingPercent === 83 && value.usage.secondary.remainingPercent === 97))
  const ready = results[0]
  assert.equal(ready.credentialId, before.credentialId)
  f.advance(60000)
  f.overrideFetch(async url => url.endsWith('/wham/usage') ? jsonResponse({ error: 'codex-refresh-secret' }, 500) : null)
  const failed = await f.manager.refreshUsage('chatgpt-account')
  assert.equal(failed.usage.status, 'failed')
  assert.equal(failed.usage.error, 'AI_USAGE_REQUEST_FAILED')
  assert.equal(failed.usage.fetchedAt, ready.usage.fetchedAt)
  assert.deepEqual(failed.usage.primary, ready.usage.primary)
  assert.equal(failed.credentialId, before.credentialId)
  assert.equal(failed.account.loggedInAt, before.account.loggedInAt)
  assert.doesNotMatch(JSON.stringify(f.events), /codex-access-secret|codex-refresh-secret|fixture-account/)
})

test('late quota responses cannot repopulate a signed-out account', async t => {
  const f = await fixture(t)
  await f.manager.startLogin()
  await f.callback()
  const entered = deferred(), finish = deferred()
  f.overrideFetch(async url => {
    if (!url.endsWith('/wham/usage')) return null
    entered.resolve()
    await finish.promise
    return jsonResponse({ rate_limit: { primary_window: { used_percent: 17 } } })
  })
  const pending = f.manager.refreshUsage('chatgpt-account')
  const rejected = assert.rejects(pending, { code: 'AI_CANCELLED' })
  await entered.promise
  await f.manager.logout('chatgpt-account')
  finish.resolve()
  await rejected
  const state = await f.manager.getState()
  assert.equal(state.hasCredential, false)
  assert.equal(state.usage.primary, null)
  assert.equal(state.usage.fetchedAt, null)
})

test('native callback binds the registered fallback without cancelling another application', async t => {
  const f = await fixture(t)
  const occupied = http.createServer((_req, res) => res.end('unrelated'))
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => occupied.close(resolve)))
  f.manager.callbackPorts = [occupied.address().port, 0]
  await f.manager.startLogin()
  assert.notEqual(new URL(f.authorization().searchParams.get('redirect_uri')).port, String(occupied.address().port))
  await f.manager.cancelLogin()
  f.manager.callbackPorts = [occupied.address().port]
  await assert.rejects(f.manager.startLogin(), { code: 'AI_OAUTH_CALLBACK_BUSY' })
  assert.equal((await f.manager.getState()).loginPending, false)
  assert.equal(await (await fetch(`http://127.0.0.1:${occupied.address().port}`)).text(), 'unrelated')
})

test('failed Codex Account revocation still clears the application credential and reports a warning', async t => {
  const f = await fixture(t)
  await f.manager.startLogin()
  await f.callback()
  f.overrideFetch(async url => url.endsWith('/oauth/revoke') ? jsonResponse({ error: 'private-token' }, 500) : null)
  const state = await f.manager.logout('chatgpt-account')
  assert.equal(state.hasCredential, false)
  assert.equal(state.warning, 'AI_REVOCATION_UNCONFIRMED')
  assert.equal(await f.manager.read('chatgpt-account'), null)
  assert.doesNotMatch(JSON.stringify(state), /private-token/)
})

test('Account revocation falls back to its access token and clearing imported Codex JSON never revokes its source session', async t => {
  const f = await fixture(t)
  await f.manager.startLogin()
  await f.callback()
  const account = await f.manager.read('chatgpt-account')
  await f.manager.stores['chatgpt-account'].set(JSON.stringify({ ...account, refreshToken: '' }))
  await f.manager.logout('chatgpt-account')
  const revoke = f.calls.find(call => call.url.endsWith('/oauth/revoke'))
  assert.deepEqual(JSON.parse(revoke.options.body), { token: 'codex-access-secret', token_type_hint: 'access_token' })
  await f.manager.importJson(JSON.stringify({ access_token: 'imported-access', refresh_token: 'imported-refresh', account_id: 'fixture-account', client_id: CODEX_CLIENT_ID }))
  const calls = f.calls.length
  await f.manager.logout('chatgpt-json')
  assert.equal(f.calls.length, calls)
  assert.equal(await f.manager.read('chatgpt-json'), null)
})

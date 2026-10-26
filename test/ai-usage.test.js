const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')
const { Response } = require('node-fetch')
const { parseCodexUsage, fetchCodexUsage, CODEX_USAGE_URL, CHATGPT_USAGE_URL } = require('../modules/ai_usage.js')

const now = 1800000000000
const jsonResponse = (value, status = 200) => new Response(Readable.from([JSON.stringify(value)]), { status })
const fixturePayload = () => ({ rate_limit: { primary_window: { used_percent: 17, limit_window_seconds: 18000, reset_at: now / 1000 + 60 },
  secondary_window: { used_percent: 3, limit_window_seconds: 604800, reset_at: now / 1000 + 86400 } } })
const credential = { kind: 'codex', accessToken: 'access-secret', accountId: 'account-secret' }

test('Codex usage converts consumed percentages and absolute reset seconds without inventing missing limits', () => {
  const result = parseCodexUsage(fixturePayload(), now)
  assert.deepEqual(result, { status: 'ready', fetchedAt: now,
    primary: { remainingPercent: 83, resetsAt: now + 60000, windowSeconds: 18000 },
    secondary: { remainingPercent: 97, resetsAt: now + 86400000, windowSeconds: 604800 }, usageUrl: CHATGPT_USAGE_URL })
  const weekly = parseCodexUsage({ rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 604800 }, secondary_window: null } }, now)
  assert.equal(weekly.primary.windowSeconds, 604800, 'primary can be weekly and must not be labelled five-hour by position')
  assert.equal(weekly.primary.resetsAt, null)
  assert.equal(weekly.secondary, null)
  const unavailable = parseCodexUsage({ rate_limit: null }, now)
  assert.equal(unavailable.status, 'unavailable')
  assert.equal(unavailable.primary, null)
  assert.equal(unavailable.secondary, null)
  assert.equal(unavailable.error, 'AI_USAGE_UNAVAILABLE')
  const unknown = parseCodexUsage({ rate_limit: { primary_window: { used_percent: null, limit_window_seconds: 18000, reset_after_seconds: 15 } } }, now)
  assert.equal(unknown.primary.remainingPercent, null)
  assert.equal(unknown.primary.resetsAt, now + 15000)
  assert.equal(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 101 } } }, now).primary.remainingPercent, 0)
  for (const body of [null, [], {}, { rate_limit: 3 }]) assert.throws(() => parseCodexUsage(body), { code: 'AI_USAGE_INVALID_RESPONSE' })
})

test('quota read uses the selected Codex account and never follows a credential redirect', async () => {
  const result = await fetchCodexUsage({ now: () => now, getCredential: async () => credential,
    fetchImpl: async (url, options) => {
      assert.equal(url, CODEX_USAGE_URL)
      assert.equal(options.method, 'GET')
      assert.equal(options.headers.Authorization, 'Bearer access-secret')
      assert.equal(options.headers['ChatGPT-Account-Id'], 'account-secret')
      assert.equal(options.redirect, 'error')
      assert.equal(options.credentials, 'omit')
      return jsonResponse(fixturePayload())
    } })
  assert.equal(result.primary.remainingPercent, 83)
  assert.doesNotMatch(JSON.stringify(result), /access-secret|account-secret/)
})

test('SIWC credentials have no guessed quota endpoint and are never sent to the Codex backend', async () => {
  const state = await fetchCodexUsage({ getCredential: async () => ({ kind: 'siwc', accessToken: 'siwc-secret' }),
    fetchImpl: async () => { throw new Error('must not request') } })
  assert.equal(state.status, 'unavailable')
  assert.equal(state.error, 'AI_USAGE_UNAVAILABLE')
  assert.equal(state.fetchedAt, null)
})

test('quota read retries a 401 only after the shared credential refresh and uses the rotated token', async () => {
  const credentials = [], requests = []
  const state = await fetchCodexUsage({ now: () => now,
    getCredential: async options => { credentials.push(options); return { ...credential, accessToken: options.forceRefresh ? 'rotated-secret' : 'expired-secret' } },
    fetchImpl: async (url, options) => { requests.push(options.headers.Authorization); return requests.length === 1 ? jsonResponse({}, 401) : jsonResponse(fixturePayload()) } })
  assert.deepEqual(requests, ['Bearer expired-secret', 'Bearer rotated-secret'])
  assert.equal(credentials[1].forceRefresh, true)
  assert.equal(credentials[1].rejectedAccessToken, 'expired-secret')
  assert.equal(state.status, 'ready')
})

for (const [status, code] of [[401, 'AI_USAGE_AUTH_FAILED'], [403, 'AI_USAGE_FORBIDDEN'], [429, 'AI_USAGE_RATE_LIMITED'], [500, 'AI_USAGE_REQUEST_FAILED']]) {
  test(`quota HTTP ${status} is a safe error without upstream credentials`, async () => {
    await assert.rejects(fetchCodexUsage({ getCredential: async () => credential, fetchImpl: async () => jsonResponse({ error: 'access-secret account-secret' }, status) }),
      cause => cause.code === code && !/access-secret|account-secret/.test(cause.message))
  })
}

test('invalid, oversized and interrupted quota responses do not become successful empty limits', async () => {
  for (const response of [new Response(Readable.from(['not-json'])), new Response(Readable.from([JSON.stringify({ rate_limit: null })]), { headers: { 'content-length': 300000 } }), new Response(Readable.from(['a'.repeat(300000)]))]) {
    await assert.rejects(fetchCodexUsage({ getCredential: async () => credential, fetchImpl: async () => response }), { code: 'AI_USAGE_INVALID_RESPONSE' })
  }
  const controller = new AbortController()
  const pending = fetchCodexUsage({ signal: controller.signal, getCredential: async () => credential, fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('access-secret')), { once: true })
    controller.abort()
  }) })
  await assert.rejects(pending, { code: 'AI_CANCELLED' })
  await assert.rejects(fetchCodexUsage({ timeoutMs: 5, getCredential: async () => credential, fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('access-secret')), { once: true })
  }) }), { code: 'AI_USAGE_TIMEOUT' })
})

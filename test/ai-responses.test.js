const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')
const { Response } = require('node-fetch')
const { DEFAULT_AI_CONFIG, normalizeAiConfig, resolveAiConfig, createAiService } = require('../modules/ai_service.js')

const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
const config = { enabled: true, provider: 'chatgpt-account', chatgptAccountModel: 'account-model', chatgptJsonModel: 'json-model', baseUrl: 'https://api.deepseek.com/v1', model: 'old-api-model', responseMode: 'json_object' }
const credential = { kind: 'siwc', accessToken: 'private-oauth-token', credentialId: 'fixture-account' }
const event = (type, fields = {}, ending = '\n\n') => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}${ending}`
const completed = (value = { ok: true }, extra = {}) => event('response.completed', { response: {
  status: 'completed', model: 'actual-model', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
  usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 }, ...extra
} })
const response = (body, status = 200, headers = {}) => new Response(typeof body === 'string' ? Readable.from([body]) : body, { status, headers })
const analyze = (service, overrides = {}) => service.analyze({ payload: { books: [{ id: 'A', title: '示例' }] }, systemPrompt: 'Classify this input.', schema, ...overrides })
const codeIs = code => error => error.code === code && !error.message.includes('private')
const fixture = (handler, options = {}) => {
  const requests = []
  const authCalls = []
  const service = createAiService({
    getConfig: () => config,
    getApiKey: () => { throw new Error('must not read the compatible key') },
    getOAuthCredential: async (provider, args) => {
      authCalls.push({ provider, forceRefresh: args.forceRefresh })
      return options.getCredential ? options.getCredential(provider, args) : credential
    },
    fetchImpl: async (url, request) => {
      const record = { url, ...request, body: request.body ? JSON.parse(request.body) : null }
      requests.push(record)
      return handler(record, requests.length)
    }
  })
  return { service, requests, authCalls }
}

test('AI provider configuration preserves each saved model and the existing API endpoint', () => {
  assert.deepEqual(normalizeAiConfig(), DEFAULT_AI_CONFIG)
  assert.equal(normalizeAiConfig({ provider: 'unknown' }).provider, 'compatible')
  const normalized = normalizeAiConfig(config)
  assert.equal(normalized.model, 'old-api-model')
  assert.equal(normalized.baseUrl, 'https://api.deepseek.com/v1')
  assert.equal(normalized.responseMode, 'json_object')
  for (const [provider, model] of [['chatgpt-account', 'account-model'], ['chatgpt-json', 'json-model']]) {
    const current = resolveAiConfig({ ...config, provider })
    assert.equal(current.model, model)
    assert.equal(current.baseUrl, 'https://api.openai.com/v1')
    assert.equal(current.responseMode, 'json_schema')
    assert.equal(normalizeAiConfig(config).model, 'old-api-model')
  }
  assert.equal(resolveAiConfig({ ...config, provider: 'compatible' }).model, 'old-api-model')
})

test('ChatGPT SIWC sends a strict nonstored streamed Responses request and reads usage', async () => {
  const { service, requests, authCalls } = fixture(() => response(completed()))
  assert.deepEqual(await analyze(service), { value: { ok: true }, usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }, model: 'actual-model' })
  assert.equal(requests[0].url, 'https://api.openai.com/v1/responses')
  assert.equal(requests[0].headers.Authorization, 'Bearer private-oauth-token')
  assert.equal(requests[0].headers.Accept, 'text/event-stream')
  assert.equal(requests[0].headers['ChatGPT-Account-ID'], undefined)
  assert.equal(requests[0].redirect, 'error')
  assert.equal(requests[0].body.model, 'account-model')
  assert.equal(requests[0].body.stream, true)
  assert.equal(requests[0].body.store, false)
  assert.equal(requests[0].body.temperature, undefined)
  assert.deepEqual(requests[0].body.reasoning, { effort: 'medium' })
  assert.equal(requests[0].body.text.format.type, 'json_schema')
  assert.equal(requests[0].body.text.format.strict, true)
  assert.deepEqual(requests[0].body.text.format.schema, schema)
  assert.deepEqual(JSON.parse(requests[0].body.input[0].content[0].text), { books: [{ id: 'A', title: '示例' }] })
  assert.deepEqual(authCalls, [{ provider: 'chatgpt-account', forceRefresh: false }])
})

test('ChatGPT Responses accepts a complete markdown JSON fence', async () => {
  const { service } = fixture(() => response(completed({ ok: true }, {
    output: [{ type: 'message', content: [{ type: 'output_text', text: '```json\n{"ok":true}\n```' }] }]
  })))
  assert.deepEqual((await analyze(service)).value, { ok: true })
})

test('ChatGPT Codex JSON uses its own fixed endpoint and account header', async () => {
  const { service, requests } = fixture(() => response(completed()), {
    getCredential: () => ({ kind: 'codex', accessToken: 'private-codex-token', accountId: 'fixture-workspace' })
  })
  await analyze(service, { config: { ...config, provider: 'chatgpt-json', baseUrl: 'https://untrusted.example' }, apiKey: 'private-api-key' })
  assert.equal(requests[0].url, 'https://chatgpt.com/backend-api/codex/responses')
  assert.equal(requests[0].headers.Authorization, 'Bearer private-codex-token')
  assert.equal(requests[0].headers['ChatGPT-Account-ID'], 'fixture-workspace')
  assert.equal(requests[0].headers.originator, 'exhentai_manga_manager')
  assert.match(requests[0].headers['User-Agent'], /^exhentai-manga-manager\//)
  assert.equal(requests[0].body.model, 'json-model')
})

test('ChatGPT JSON can also import SIWC credentials without using the Codex backend', async () => {
  const { service, requests } = fixture(() => response(completed()))
  await analyze(service, { config: { ...config, provider: 'chatgpt-json' } })
  assert.equal(requests[0].url, 'https://api.openai.com/v1/responses')
  assert.equal(requests[0].body.model, 'json-model')
})

test('ChatGPT transmits all six selected reasoning efforts without downgrading and preserves provider preferences', async () => {
  const { service, requests } = fixture(() => response(completed()))
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    for (const provider of ['chatgpt-json', 'chatgpt-account']) {
      const current = { ...config, provider, reasoningEffort: 'low', chatgptJsonReasoningEffort: effort, chatgptAccountReasoningEffort: effort }
      await analyze(service, { config: current })
      assert.equal(requests.at(-1).body.reasoning.effort, effort)
      assert.equal(current.reasoningEffort, 'low')
    }
  }
  const saved = normalizeAiConfig({ ...config, reasoningEffort: 'low', chatgptJsonReasoningEffort: 'max', chatgptAccountReasoningEffort: 'ultra' })
  assert.equal(resolveAiConfig({ ...saved, provider: 'chatgpt-json' }).reasoningEffort, 'max')
  assert.equal(resolveAiConfig({ ...saved, provider: 'chatgpt-account' }).reasoningEffort, 'ultra')
  assert.equal(resolveAiConfig({ ...saved, provider: 'compatible' }).reasoningEffort, 'low')
  assert.equal(normalizeAiConfig({ chatgptJsonReasoningEffort: 'invalid' }).chatgptJsonReasoningEffort, 'medium')
})

test('ChatGPT preserves advertised effort capabilities and rejects an unsupported effort before inference', async () => {
  const { service, requests } = fixture(request => request.method === 'GET' ? response(JSON.stringify({ models: [
    { slug: 'account-model', visibility: 'list', default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'max' }, { effort: 'persistent' }] }
  ] })) : response(completed()))
  const catalog = await service.listModels()
  assert.deepEqual(catalog.modelOptions[0].reasoningEfforts, ['low', 'high', 'max'])
  assert.equal(catalog.modelOptions[0].defaultReasoningEffort, 'high')
  await assert.rejects(analyze(service, { config: { ...config, chatgptAccountReasoningEffort: 'ultra' } }), codeIs('AI_REASONING_UNSUPPORTED'))
  assert.equal(requests.length, 1, 'An unsupported selection does not consume an inference request')
  await analyze(service, { config: { ...config, chatgptAccountReasoningEffort: 'max' } })
  assert.equal(requests.at(-1).body.reasoning.effort, 'max')
})

test('ChatGPT reports rejected reasoning effort safely without retrying or silently lowering it', async () => {
  const { service, requests } = fixture(() => response(JSON.stringify({ error: { param: 'reasoning.effort', message: 'private unsupported effort detail' } }), 400))
  await assert.rejects(analyze(service, { config: { ...config, chatgptAccountReasoningEffort: 'ultra' } }), codeIs('AI_REASONING_UNSUPPORTED'))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].body.reasoning.effort, 'ultra')
})

test('ChatGPT stream decoder handles split UTF-8 characters, CRLF, and complete output', async () => {
  const text = event('response.created', { response: { status: 'in_progress' } }).replace(/\n/g, '\r\n') + completed({ ok: true, title: '月花' }).replace(/\n/g, '\r\n')
  const chunks = [...Buffer.from(text)].map(byte => Buffer.from([byte]))
  const { service } = fixture(() => response(Readable.from(chunks)))
  assert.deepEqual((await analyze(service)).value, { ok: true, title: '月花' })
})

test('ChatGPT stream requires a completed event before accepting collected text', async () => {
  const deltas = event('response.output_text.delta', { delta: '{"ok":true}' })
  const success = fixture(() => response(deltas + event('response.completed', { response: { status: 'completed', model: 'delta-model' } })))
  assert.deepEqual((await analyze(success.service)).value, { ok: true })
  for (const stream of [deltas, deltas + 'data: [DONE]\n\n', event('response.created'), '']) {
    const { service, requests } = fixture(() => response(stream))
    await assert.rejects(analyze(service), codeIs('AI_RESPONSE_TRUNCATED'))
    assert.equal(requests.length, 1)
  }
})

test('ChatGPT never retries a failed or incomplete stream and uses safe error messages', async () => {
  const cases = [
    [event('response.failed', { response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'private-upstream-body' } } }), 'AI_RATE_LIMITED'],
    [event('response.failed', { response: { error: { code: 'subscription_sharing_usage_unavailable' } } }), 'AI_PLAN_UNAVAILABLE'],
    [event('error', { error: { code: 'model_not_found', message: 'private-upstream-body' } }), 'AI_MODEL_UNAVAILABLE'],
    [event('error', { code: 'subscription_sharing_usage_limit_exceeded', message: 'private-upstream-body' }), 'AI_RATE_LIMITED'],
    [event('error', { error: { code: 'token_expired' } }), 'AI_AUTH_FAILED'],
    [event('response.failed', { response: { error: { code: 'private-code', message: 'private-message' } } }), 'AI_RESPONSE_FAILED'],
    [event('response.incomplete', { response: { incomplete_details: { reason: 'max_output_tokens' } } }), 'AI_RESPONSE_TRUNCATED'],
    [event('response.refusal.delta', { delta: 'private-refusal' }), 'AI_REFUSED'],
    [completed({}, { output: [{ content: [{ type: 'refusal', refusal: 'private-refusal' }] }] }), 'AI_REFUSED'],
    ['data: private-invalid-json\n\n', 'AI_INVALID_RESPONSE'],
    [completed([]), 'AI_INVALID_JSON'],
    [completed({}, { output: [] }), 'AI_INVALID_RESPONSE']
  ]
  for (const [stream, code] of cases) {
    const { service, requests, authCalls } = fixture(() => response(stream))
    await assert.rejects(analyze(service), codeIs(code))
    assert.equal(requests.length, 1)
    assert.equal(authCalls.length, 1)
  }
})

test('ChatGPT refreshes credentials once after HTTP 401 before a stream starts', async () => {
  const { service, requests, authCalls } = fixture((record, count) => count === 1
    ? response('{"error":{"message":"private-upstream-body"}}', 401)
    : response(completed()), {
    getCredential: (provider, options) => ({ ...credential, accessToken: options.forceRefresh ? 'refreshed-token' : 'private-oauth-token' })
  })
  await analyze(service)
  assert.equal(requests.length, 2)
  assert.equal(requests[1].headers.Authorization, 'Bearer refreshed-token')
  assert.deepEqual(requests[0].body, requests[1].body)
  assert.deepEqual(authCalls.map(call => call.forceRefresh), [false, true])
  const denied = fixture(() => response('private-upstream-body', 401))
  await assert.rejects(analyze(denied.service), codeIs('AI_AUTH_FAILED'))
  assert.equal(denied.requests.length, 2)
})

test('ChatGPT safely handles nonretryable HTTP errors without replaying inference', async () => {
  for (const [status, code] of [[400, 'AI_HTTP_ERROR'], [403, 'AI_AUTH_FAILED'], [429, 'AI_RATE_LIMITED'], [503, 'AI_HTTP_ERROR']]) {
    const { service, requests } = fixture(() => response('{"error":{"message":"private-oauth-token"}}', status))
    await assert.rejects(analyze(service), error => codeIs(code)(error) && error.status === status)
    assert.equal(requests.length, 1)
  }
})

test('ChatGPT requires a selected model, valid schema, and imported credentials before networking', async () => {
  const { service, requests } = fixture(() => { throw new Error('private-network-error') }, { getCredential: () => null })
  await assert.rejects(analyze(service, { config: { ...config, chatgptAccountModel: '' } }), codeIs('AI_MODEL_REQUIRED'))
  await assert.rejects(analyze(service, { schema: null }), codeIs('AI_SCHEMA_REQUIRED'))
  await assert.rejects(analyze(service), codeIs('AI_AUTH_REQUIRED'))
  assert.equal(requests.length, 0)
  const codex = fixture(() => { throw new Error('unexpected') }, { getCredential: () => ({ kind: 'codex', accessToken: 'private-token' }) })
  await assert.rejects(analyze(codex.service), codeIs('AI_AUTH_REQUIRED'))
  assert.equal(codex.requests.length, 0)
})

test('ChatGPT model catalog preserves server order and uses display labels with unique visible slugs', async () => {
  const catalog = { models: [
    { slug: 'z-model', display_name: 'Z model', visibility: 'list' },
    { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide' },
    { slug: ' a-model ', display_name: ' ', visibility: 'list' },
    { slug: 'z-model', display_name: 'Duplicate', visibility: 'list' },
    { slug: '', visibility: 'list' }, null
  ] }
  const { service, requests } = fixture(() => response(JSON.stringify(catalog)))
  const actual = await service.listModels({ config: { ...config, enabled: false, chatgptAccountModel: '' }, apiKey: 'private-draft-key' })
  assert.deepEqual(actual, { models: ['z-model', 'a-model'], modelOptions: [{ id: 'z-model', label: 'Z model' }, { id: 'a-model', label: 'a-model' }] })
  assert.equal(requests[0].url, 'https://api.openai.com/v1/models')
  assert.equal(requests[0].method, 'GET')
  assert.equal(requests[0].body, null)
  assert.equal(requests[0].headers.Authorization, 'Bearer private-oauth-token')
})

test('ChatGPT Codex model catalog adds the version query and workspace header', async () => {
  const { service, requests } = fixture(() => response('{"models":[]}'), {
    getCredential: () => ({ kind: 'codex', accessToken: 'private-token', accountId: 'workspace' })
  })
  assert.deepEqual(await service.listModels({ config: { ...config, provider: 'chatgpt-json' } }), { models: [], modelOptions: [] })
  const url = new URL(requests[0].url)
  assert.equal(url.origin + url.pathname, 'https://chatgpt.com/backend-api/codex/models')
  assert.equal(url.searchParams.get('client_version'), require('../package.json').version)
  assert.equal(requests[0].headers['ChatGPT-Account-ID'], 'workspace')
})

test('ChatGPT model listing rejects incompatible catalog formats and can recover one HTTP 401', async () => {
  for (const body of ['private-body', '{"data":[]}', '{"models":{}}']) {
    const { service } = fixture(() => response(body))
    await assert.rejects(service.listModels(), codeIs('AI_INVALID_MODEL_LIST'))
  }
  const { service, authCalls } = fixture((record, count) => count === 1 ? response('{}', 401) : response('{"models":[]}'))
  assert.deepEqual(await service.listModels(), { models: [], modelOptions: [] })
  assert.deepEqual(authCalls.map(call => call.forceRefresh), [false, true])
})

test('ChatGPT enforces request and stream size limits without forwarding private input', async () => {
  const small = fixture(() => response(completed()))
  await assert.rejects(analyze(small.service, { payload: { title: '书'.repeat(50000) } }), codeIs('AI_INPUT_TOO_LARGE'))
  assert.equal(small.requests.length, 0)
  for (const largeResponse of [
    () => response('data: ' + 'x'.repeat(32 * 1024 * 1024)),
    () => response(completed(), 200, { 'Content-Length': String(32 * 1024 * 1024 + 1) })
  ]) {
    const { service, requests } = fixture(largeResponse)
    await assert.rejects(analyze(service), codeIs('AI_RESPONSE_TOO_LARGE'))
    assert.equal(requests.length, 1)
  }
})

test('ChatGPT connection test verifies the returned value and works while analysis is disabled', async () => {
  const { service, requests } = fixture(() => response(completed()))
  assert.deepEqual((await service.testConnection({ config: { ...config, enabled: false } })).value, { ok: true })
  assert.deepEqual(JSON.parse(requests[0].body.input[0].content[0].text), { test: 'connection' })
  const invalid = fixture(() => response(completed({ ok: true, extra: true })))
  await assert.rejects(invalid.service.testConnection(), codeIs('AI_INVALID_TEST_RESULT'))
})

test('ChatGPT progressing streams may exceed the idle timeout in total duration', async () => {
  const { service, requests } = fixture(() => response(Readable.from((async function* () {
    for (let i = 0; i < 5; i++) {
      yield ': keepalive\n\n'
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    yield completed()
  })())))
  const startedAt = Date.now()
  assert.deepEqual((await analyze(service, { config: { ...config, timeoutMs: 1000 } })).value, { ok: true })
  assert.ok(Date.now() - startedAt > 1000)
  assert.equal(requests.length, 1)
})

test('ChatGPT idle streams time out without replaying the request', async () => {
  const { service, requests } = fixture(record => {
    const body = new Readable({ read() {} })
    body.push(': keepalive\n\n')
    record.signal.addEventListener('abort', () => body.destroy(new Error('private abort detail')), { once: true })
    return response(body)
  })
  await assert.rejects(analyze(service, { config: { ...config, timeoutMs: 1000 } }), codeIs('AI_TIMEOUT'))
  assert.equal(requests.length, 1)
})

test('ChatGPT cancellation and timeout abort the active request and do not retry', async () => {
  let arrived
  const arrival = new Promise(resolve => { arrived = resolve })
  const { service, requests } = fixture(record => new Promise((resolve, reject) => {
    arrived()
    record.signal.addEventListener('abort', () => reject(new Error('private-abort-error')), { once: true })
  }))
  const controller = new AbortController()
  const pending = analyze(service, { signal: controller.signal })
  await arrival
  controller.abort()
  await assert.rejects(pending, codeIs('AI_CANCELLED'))
  assert.equal(requests.length, 1)
  await assert.rejects(analyze(service, { signal: controller.signal }), codeIs('AI_CANCELLED'))
  assert.equal(requests.length, 1)
  await assert.rejects(analyze(service, { config: { ...config, timeoutMs: 1000 } }), codeIs('AI_TIMEOUT'))
  assert.equal(requests.length, 2)
})

test('ChatGPT masks transport failures and does not retry them', async () => {
  const { service, requests } = fixture(() => { throw new Error('private-oauth-token upstream URL') })
  await assert.rejects(analyze(service), codeIs('AI_NETWORK_ERROR'))
  assert.equal(requests.length, 1)
})

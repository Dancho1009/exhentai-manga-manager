const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { DEFAULT_AI_CONFIG, normalizeAiConfig, createAiService } = require('../modules/ai_service.js')

const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
const completion = (value = { ok: true }, extra = {}) => ({
  model: 'test-model',
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  ...extra
})
const respond = (res, body = completion(), status = 200, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}
const mockService = async (t, handler, overrides = {}) => {
  const requests = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const rawBody = Buffer.concat(chunks).toString()
    const record = { method: req.method, url: req.url, headers: req.headers, body: rawBody ? JSON.parse(rawBody) : null }
    requests.push(record)
    handler(req, res, record, requests.length)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => {
    server.close(resolve)
    server.closeAllConnections()
  }))
  const config = { ...DEFAULT_AI_CONFIG, enabled: true, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'test-model', ...overrides }
  const service = createAiService({ getConfig: () => config, getApiKey: () => 'private-test-key' })
  return { service, config, requests }
}
const analyze = (service, overrides = {}) => service.analyze({ payload: { books: [{ id: 'A', title: 'Example' }] }, systemPrompt: 'Classify the input.', schema, ...overrides })
const codeIs = code => error => error.code === code && !error.message.includes('private-test-key')

test('compatible controls are opt-in, use the selected protocol, and reach connection tests too', async t => {
  const target = await mockService(t, (_req, res) => respond(res))
  await analyze(target.service)
  assert.equal(target.requests[0].body.thinking, undefined)
  assert.equal(target.requests[0].body.reasoning_effort, undefined)
  assert.equal(target.requests[0].body.max_tokens, undefined)
  Object.assign(target.config, { compatibleThinkingMode:'disabled', compatibleMaxOutputTokens:32768 })
  await target.service.testConnection()
  assert.deepEqual(target.requests[1].body.thinking, {type:'disabled'})
  assert.equal(target.requests[1].body.max_tokens, 32768)
  assert.equal(target.requests[1].body.reasoning_effort, undefined)
  Object.assign(target.config, { compatibleThinkingMode:'enabled', compatibleReasoningEffort:'low' })
  await analyze(target.service)
  assert.deepEqual(target.requests[2].body.thinking, {type:'enabled'})
  assert.equal(target.requests[2].body.reasoning_effort, 'low')
  Object.assign(target.config, { compatibleReasoningProtocol:'openai', compatibleThinkingMode:'disabled', compatibleOutputTokenField:'max_completion_tokens' })
  await analyze(target.service)
  assert.equal(target.requests[3].body.reasoning_effort, 'none')
  assert.equal(target.requests[3].body.thinking, undefined)
  assert.equal(target.requests[3].body.max_tokens, undefined)
  assert.equal(target.requests[3].body.max_completion_tokens, 32768)
  Object.assign(target.config, { compatibleThinkingMode:'inherit', compatibleMaxOutputTokens:null })
  await analyze(target.service)
  assert.equal(target.requests[4].body.reasoning_effort, undefined)
  assert.equal(target.requests[4].body.max_completion_tokens, undefined)
})

test('compatible output lengths are user-controlled and unsupported controls are never silently removed', async t => {
  assert.equal(normalizeAiConfig({compatibleMaxOutputTokens:262144}).compatibleMaxOutputTokens, 262144)
  for(const value of [-1,0,1.5,'invalid',Infinity]) assert.throws(()=>normalizeAiConfig({compatibleMaxOutputTokens:value}),codeIs('AI_INVALID_OUTPUT_TOKENS'))
  const target = await mockService(t, (_req,res)=>respond(res,{error:{message:'thinking parameter is unsupported',param:'thinking'}},400),
    {compatibleThinkingMode:'disabled'})
  await assert.rejects(analyze(target.service),error=>error.code==='AI_REQUEST_OPTIONS_UNSUPPORTED'&&error.requestParameter==='thinking')
  assert.equal(target.requests.length,1)
  const streamed = await mockService(t, (_req,res)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: {"error":{"message":"unsupported max_tokens","param":"max_tokens"}}\n\n')}, {stream:true,compatibleMaxOutputTokens:32768})
  await assert.rejects(analyze(streamed.service),error=>error.code==='AI_REQUEST_OPTIONS_UNSUPPORTED'&&error.requestParameter==='max_tokens')
  assert.equal(streamed.requests.length,1)
  assert.deepEqual(target.requests[0].body.thinking,{type:'disabled'})
  Object.assign(target.config,{compatibleThinkingMode:'enabled',compatibleReasoningEffort:'medium'})
  await assert.rejects(analyze(target.service),codeIs('AI_REASONING_UNSUPPORTED'))
  assert.equal(target.requests.length,1)
})

test('stream and JSON length stops carry explicit truncation reasons without transport replay', async t => {
  for(const stream of [false,true]) {
    const target=await mockService(t,(_req,res)=>{
      const body=completion({}, {choices:[{finish_reason:'length',message:{content:'{"books":['}}]})
      if(!stream)return respond(res,body)
      res.writeHead(200,{'Content-Type':'text/event-stream'})
      res.end('data: '+JSON.stringify({choices:[{delta:{content:'{"books":['},finish_reason:'length'}]})+'\n\ndata: [DONE]\n\n')
    },{stream})
    await assert.rejects(analyze(target.service),error=>error.code==='AI_RESPONSE_TRUNCATED'&&error.truncationReason==='length'&&error.finishReason==='length')
    assert.equal(target.requests.length,1)
  }
  const target=await mockService(t,(_req,res)=>{
    res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: {"choices":[{"delta":{"content":"{"}}]}\n\n')
  },{stream:true})
  await assert.rejects(analyze(target.service),error=>error.truncationReason==='stream_incomplete')
})

test('AI config has bounded defaults and does not copy secrets', () => {
  assert.deepEqual(normalizeAiConfig(), DEFAULT_AI_CONFIG)
  assert.equal(normalizeAiConfig({}).stream, false)
  assert.equal(normalizeAiConfig({ stream: true }).stream, true)
  assert.equal(normalizeAiConfig({ stream: 'true' }).stream, false)
  const normalized = normalizeAiConfig({ enabled: true, baseUrl: ' http://localhost:1234/v1 ', model: ' local ', concurrency: 90, maxRequests: -4, timeoutMs: 0, apiKey: 'private-test-key' })
  assert.equal(normalized.baseUrl, 'http://localhost:1234/v1')
  assert.equal(normalized.model, 'local')
  assert.equal(normalized.concurrency, 90)
  assert.equal(normalized.normalizationBatchSize, 8)
  const scheduling = normalizeAiConfig({ normalizationBatchSize: 3, concurrency: 25 })
  assert.equal(scheduling.normalizationBatchSize, 3)
  assert.equal(scheduling.concurrency, 25)
  assert.equal(normalizeAiConfig({ normalizationBatchSize: 0 }).normalizationBatchSize, 1)
  assert.equal(normalizeAiConfig({ normalizationBatchSize: 5000 }).normalizationBatchSize, 1000)
  assert.equal(normalizeAiConfig({ normalizationBatchSize: 'invalid' }).normalizationBatchSize, 8)
  assert.equal(normalizeAiConfig({ concurrency: 5000 }).concurrency, 1000)
  assert.equal('maxRequests' in normalized, false, 'legacy per-run budgets are discarded')
  assert.equal(normalized.timeoutMs, 1000)
  assert.equal('apiKey' in normalized, false)
})

test('AI selects JSON object mode only for exact known provider hosts', () => {
  for (const baseUrl of ['https://api.deepseek.com/', 'https://api.deepseek.com/v1', 'https://api.deepseek.com/v1/chat/completions', ' https://API.DEEPSEEK.COM:443/v1 ']) {
    const config = { baseUrl, responseMode: 'json_schema' }
    assert.equal(normalizeAiConfig(config).responseMode, 'json_object')
    assert.equal(config.responseMode, 'json_schema', 'normalization must not mutate the caller config')
  }
  for (const baseUrl of ['https://api.deepseek.com.example.com/v1', 'https://proxy.api.deepseek.com/v1', 'https://example.com/api.deepseek.com', 'https://example.com/?provider=api.deepseek.com', 'http://localhost:1234/v1', 'not a url', '']) {
    for (const responseMode of ['json_schema', 'json_object']) {
      assert.equal(normalizeAiConfig({ baseUrl, responseMode }).responseMode, responseMode)
    }
  }
})

test('AI DeepSeek connection and analysis use supported JSON mode with the full expected schema', async t => {
  const target = await mockService(t, (req, res, record) => {
    if (record.body.response_format.type !== 'json_object') {
      respond(res, { error: { message: 'This response_format type is unavailable now (request_id:private-request-id)' } }, 400)
    } else respond(res)
  })
  const config = { ...target.config, enabled: false, baseUrl: 'https://api.deepseek.com/', model: 'deepseek-flash', responseMode: 'json_schema' }
  const upstreamUrls = []
  const service = createAiService({ getConfig: () => config, getApiKey: () => 'private-test-key', fetchImpl: (url, options) => {
    upstreamUrls.push(url)
    const localUrl = new URL(target.config.baseUrl)
    localUrl.pathname = new URL(url).pathname
    return require('node-fetch')(localUrl.toString(), options)
  } })
  assert.deepEqual((await service.testConnection()).value, { ok: true })
  assert.deepEqual((await analyze(service, { config: { ...config, enabled: true, baseUrl: 'https://api.deepseek.com/v1/chat/completions' } })).value, { ok: true })
  assert.deepEqual(upstreamUrls, ['https://api.deepseek.com/chat/completions', 'https://api.deepseek.com/v1/chat/completions'])
  assert.equal(target.requests.length, 2)
  assert.ok(target.requests.every(request => request.body.response_format.type === 'json_object'))
  assert.ok(target.requests.every(request => request.body.response_format.json_schema === undefined))
  assert.ok(target.requests.every(request => request.body.temperature === 0))
  assert.match(target.requests[0].body.messages[0].content, /"enum":\[true\]/)
  assert.ok(target.requests[1].body.messages[0].content.includes(JSON.stringify(schema)))
  assert.deepEqual(JSON.parse(target.requests[0].body.messages[1].content), { test: 'connection' })
  assert.equal(config.responseMode, 'json_schema')
})

test('AI sends schema and Bearer key to the normalized endpoint and parses usage', async t => {
  const { service, requests } = await mockService(t, (req, res) => respond(res))
  const result = await analyze(service)
  assert.deepEqual(result, { value: { ok: true }, usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }, finishReason:'stop', model: 'test-model' })
  assert.equal(requests[0].url, '/v1/chat/completions')
  assert.equal(requests[0].headers.authorization, 'Bearer private-test-key')
  assert.equal(requests[0].body.stream, false)
  assert.deepEqual(requests[0].body.response_format.json_schema.schema, schema)
  assert.equal(requests[0].body.response_format.json_schema.strict, true)
  assert.equal(requests[0].body.response_format.json_schema.schema.additionalProperties, false)
  assert.deepEqual(requests[0].body.response_format.json_schema.schema.required, ['ok'])
  assert.deepEqual(JSON.parse(requests[0].body.messages[1].content), { books: [{ id: 'A', title: 'Example' }] })
})

test('AI connection test works while disabled, accepts a full endpoint and sends no private library data', async t => {
  const { service, config, requests } = await mockService(t, (req, res) => respond(res), { enabled: false })
  await service.testConnection({ config: { ...config, baseUrl: `${config.baseUrl}/chat/completions/`, responseMode: 'json_object' }, apiKey: '' })
  assert.equal(requests[0].url, '/v1/chat/completions')
  assert.equal(requests[0].headers.authorization, undefined)
  assert.deepEqual(requests[0].body.response_format, { type: 'json_object' })
  assert.match(requests[0].body.messages[0].content, /"required":\["ok"\]/)
  assert.deepEqual(JSON.parse(requests[0].body.messages[1].content), { test: 'connection' })
  await assert.rejects(analyze(service), codeIs('AI_DISABLED'))
})

test('AI rejects unsupported URLs and missing model/schema before networking', async () => {
  let fetchCount = 0
  const service = createAiService({ fetchImpl: async () => { fetchCount++; throw new Error('unexpected request') } })
  for (const baseUrl of ['file:///local', 'ftp://server', 'https://name:private-test-key@example.com/v1', 'https://example.com/v1#secret', 'not a url']) {
    await assert.rejects(analyze(service, { config: { enabled: true, baseUrl, model: 'test' } }), codeIs('AI_INVALID_URL'))
  }
  await assert.rejects(analyze(service, { config: { enabled: true, baseUrl: 'http://localhost/v1' } }), codeIs('AI_MODEL_REQUIRED'))
  await assert.rejects(analyze(service, { config: { enabled: true, baseUrl: 'http://localhost/v1', model: 'test' }, schema: null }), codeIs('AI_SCHEMA_REQUIRED'))
  assert.equal(fetchCount, 0)
})

test('AI retries one transient status and does not downgrade the response protocol', async t => {
  const { service, requests } = await mockService(t, (req, res, record, count) => {
    respond(res, count === 1 ? { error: 'temporary' } : completion(), count === 1 ? 503 : 200, { 'Retry-After': '0' })
  })
  await analyze(service)
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[0].body, requests[1].body)
})

test('AI stops after one retry on rate limits', async t => {
  const { service, requests } = await mockService(t, (req, res) => respond(res, { error: 'private-test-key' }, 429, { 'Retry-After': '0' }))
  await assert.rejects(analyze(service), codeIs('AI_RATE_LIMITED'))
  assert.equal(requests.length, 2)
})

test('AI never retries authentication or protocol errors, and does not expose the upstream response', async t => {
  for (const status of [401, 403, 400]) {
    const { service, requests } = await mockService(t, (req, res) => respond(res, { error: 'private-test-key and private upstream text' }, status))
    await assert.rejects(analyze(service), error => {
      assert.equal(error.code, status === 400 ? 'AI_HTTP_ERROR' : 'AI_AUTH_FAILED')
      assert.equal(error.status, status)
      assert.doesNotMatch(error.message, /private/)
      return true
    })
    assert.equal(requests.length, 1)
  }
})

test('AI stream assembles fragmented UTF-8 SSE, ignores reasoning text, and captures final usage', async t => {
  const value = { ok: true, title: '月花🌙' }
  const chunks = [
    ': keepalive\r\n\r\n',
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'private reasoning that is not the result' } }] }) + '\r\n\r\n',
    'data: ' + JSON.stringify({ model: 'stream-model', choices: [{ index: 0, delta: { content: JSON.stringify(value).slice(0, 15) } }] }) + '\r\n\r\n',
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify(value).slice(15) }, finish_reason: 'stop' }] }) + '\r\n\r\n',
    'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }) + '\r\n\r\n',
    'data: [DONE]\r\n\r\n'
  ]
  const { service, requests } = await mockService(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const byte of Buffer.from(chunks.join(''))) res.write(Buffer.from([byte]))
    res.end()
  }, { stream: true })
  assert.deepEqual(await analyze(service), { value, usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }, finishReason:'stop', model: 'stream-model' })
  assert.equal(requests[0].body.stream, true)
  assert.deepEqual(requests[0].body.stream_options, { include_usage: true })
  assert.equal(requests[0].headers.accept, 'text/event-stream')
})

test('AI accepts a complete markdown JSON fence from a compatible streamed upstream', async t => {
  const chunks = [
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '```json\n{"ok":' } }] }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [{ delta: { content: 'true}\n```' }, finish_reason: 'stop' }] }) + '\n\n',
    'data: [DONE]\n\n'
  ]
  const { service } = await mockService(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(chunks.join(''))
  }, { stream: true })
  assert.deepEqual((await analyze(service)).value, { ok: true })
})

test('AI stream accepts JSON from services that ignore stream and does not change non-stream requests', async t => {
  const { service, requests, config } = await mockService(t, (_req, res) => respond(res), { stream: true })
  assert.deepEqual((await analyze(service)).value, { ok: true })
  await service.testConnection({ config: { ...config, stream: false } })
  assert.equal(requests[0].body.stream, true)
  assert.equal(requests[1].body.stream, false)
  assert.equal(requests[1].body.stream_options, undefined)
})

test('AI stream accepts a terminal finish chunk without a DONE marker', async t => {
  const { service } = await mockService(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '{"ok":true}' }, finish_reason: 'stop' }] }))
  }, { stream: true })
  assert.deepEqual((await analyze(service)).value, { ok: true })
})

test('AI stream rejects malformed, refused, invalid JSON and incomplete responses without replaying requests', async t => {
  const event = choice => 'data: ' + JSON.stringify({ choices: [choice] }) + '\n\n'
  for (const [body, code] of [
    ['data: invalid-json\n\n', 'AI_INVALID_RESPONSE'],
    [event({ delta: { content: '{"ok":true}' } }), 'AI_RESPONSE_TRUNCATED'],
    [event({ delta: { content: '{"ok":true}' }, finish_reason: 'length' }), 'AI_RESPONSE_TRUNCATED'],
    [event({ delta: { content: '{"ok":true}' }, finish_reason: 'aborted' }), 'AI_RESPONSE_TRUNCATED'],
    [event({ delta: { content: '{"ok":true}' }, finish_reason: 'insufficient_system_resource' }), 'AI_RESPONSE_TRUNCATED'],
    [event({ delta: { refusal: 'private upstream response' }, finish_reason: 'stop' }), 'AI_REFUSED'],
    [event({ delta: {}, finish_reason: 'content_filter' }), 'AI_REFUSED'],
    [event({ delta: { content: 'not-json' }, finish_reason: 'stop' }), 'AI_INVALID_JSON'],
    ['data: ' + JSON.stringify({ error: { message: 'private upstream error' } }) + '\n\n', 'AI_RESPONSE_FAILED']
  ]) {
    const { service, requests } = await mockService(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(body) }, { stream: true })
    await assert.rejects(analyze(service), error => error.code === code && !error.message.includes('private'))
    assert.equal(requests.length, 1)
  }
})

test('AI stream enforces declared and streamed response size limits', async t => {
  for (const declaredLength of [true, false]) {
    const { service } = await mockService(t, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', ...(declaredLength ? { 'Content-Length': String(32 * 1024 * 1024 + 1) } : {}) })
      res.end('x'.repeat(32 * 1024 * 1024 + 1))
    }, { stream: true })
    await assert.rejects(analyze(service), codeIs('AI_RESPONSE_TOO_LARGE'))
  }
})

test('AI streamed requests remain alive while data arrives beyond the configured timeout', async t => {
  for (const jsonFallback of [false, true]) {
    const { service, requests } = await mockService(t, (_req, res) => {
      res.writeHead(200, { 'Content-Type': jsonFallback ? 'application/json' : 'text/event-stream' })
      let index = 0
      const parts = jsonFallback ? JSON.stringify(completion()).match(/.{1,40}/g) : ['{', '"ok"', ':', 'true', '}']
      const sendPart = () => {
        if (index < parts.length) {
          const part = parts[index++]
          res.write(jsonFallback ? part : 'data: ' + JSON.stringify({ choices: [{ delta: { content: part } }] }) + '\n\n')
        } else {
          res.end(jsonFallback ? '' : 'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
        }
      }
      sendPart()
      const interval = setInterval(sendPart, 300)
      res.once('close', () => clearInterval(interval))
    }, { stream: true, timeoutMs: 1000 })
    const startedAt = Date.now()
    assert.deepEqual((await analyze(service)).value, { ok: true })
    assert.ok(Date.now() - startedAt > 1000, 'A progressing response may exceed the idle timeout in total duration')
    assert.equal(requests.length, 1)
  }
})

test('AI non-streamed requests retain a total deadline even when response data arrives', async t => {
  const { service, requests } = await mockService(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.write(' ')
    const interval = setInterval(() => res.write(' '), 200)
    res.once('close', () => clearInterval(interval))
  }, { stream: false, timeoutMs: 1000 })
  await assert.rejects(analyze(service), codeIs('AI_TIMEOUT'))
  assert.equal(requests.length, 1)
})

test('AI streamed requests time out while waiting for the initial response', async t => {
  const { service, requests } = await mockService(t, () => {}, { stream: true, timeoutMs: 1000 })
  await assert.rejects(analyze(service), codeIs('AI_TIMEOUT'))
  assert.equal(requests.length, 1)
})

test('AI stream cancellation and timeout close an unfinished response without retrying', async t => {
  for (const cancel of [true, false]) {
    let arrived
    const arrival = new Promise(resolve => { arrived = resolve })
    const { service, requests } = await mockService(t, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '{"ok":' } }] }) + '\n\n')
      arrived()
    }, { stream: true, timeoutMs: 1000 })
    const controller = new AbortController()
    const pending = analyze(service, { signal: controller.signal })
    await arrival
    if (cancel) controller.abort()
    await assert.rejects(pending, codeIs(cancel ? 'AI_CANCELLED' : 'AI_TIMEOUT'))
    assert.equal(requests.length, 1)
  }
})

test('AI stream retries HTTP 429 before receiving a successful stream', async t => {
  const { service, requests } = await mockService(t, (_req, res, _record, count) => {
    if (count === 1) return respond(res, { error: 'temporary' }, 429, { 'Retry-After': '0' })
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '{"ok":true}' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
  }, { stream: true })
  assert.deepEqual((await analyze(service)).value, { ok: true })
  assert.equal(requests.length, 2)
})

test('AI identifies unsupported response formats without exposing upstream details or retrying', async t => {
  const cases = [
    [400, { message: 'This response_format type is unavailable now (request_id:private-request-id private-test-key)' }],
    [422, { message: 'Unsupported response_format: private-test-key' }],
    [400, { message: 'This parameter is not supported for private-test-key', param: 'response_format.type' }],
    [422, { message: 'response_format is not available for private-test-key' }]
  ]
  for (const [status, errorBody] of cases) {
    const { service, requests } = await mockService(t, (req, res) => respond(res, { error: errorBody }, status))
    await assert.rejects(service.testConnection(), error => {
      assert.equal(error.code, 'AI_RESPONSE_FORMAT_UNSUPPORTED')
      assert.equal(error.status, status)
      assert.equal(error.message, 'AI 服务不支持当前输出格式，请在设置中选择 JSON 对象模式后重试。')
      assert.doesNotMatch(JSON.stringify(error), /private-test-key|private-request-id/)
      return true
    })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].body.response_format.type, 'json_schema', 'unknown providers must retain the requested mode')
  }
})

test('AI does not misclassify other HTTP errors as unsupported response formats', async t => {
  const cases = [
    [400, { error: { message: 'Unsupported temperature', param: 'temperature' } }],
    [422, { error: { message: 'Invalid response_format JSON schema' } }],
    [400, { error: { message: 'The model is unavailable', param: 'model' } }],
    [500, { error: { message: 'This response_format type is unavailable now' } }],
    [400, '<html>response_format unavailable private-test-key</html>'],
    [422, '{"error":{"message":"response_format unsupported"']
  ]
  for (const [status, body] of cases) {
    const { service, requests } = await mockService(t, (req, res) => respond(res, body, status))
    await assert.rejects(analyze(service), error => {
      assert.equal(error.code, 'AI_HTTP_ERROR')
      assert.equal(error.status, status)
      assert.equal(error.message, `AI 服务请求失败（HTTP ${status}）。`)
      return true
    })
    assert.equal(requests.length, 1)
  }
})

test('AI rejects malformed, non-object, refused, and truncated responses', async t => {
  const cases = [
    ['not JSON', 'AI_INVALID_RESPONSE'],
    [completion([], {}), 'AI_INVALID_JSON'],
    [completion(null), 'AI_INVALID_JSON'],
    [completion({}, { choices: [{ message: { content: '{"ok":' } }] }), 'AI_INVALID_JSON'],
    [completion({}, { choices: [{ message: { refusal: 'private upstream text' } }] }), 'AI_REFUSED'],
    [completion({}, { choices: [{ finish_reason: 'length', message: { content: '{}' } }] }), 'AI_RESPONSE_TRUNCATED']
  ]
  for (const [response, code] of cases) {
    const { service } = await mockService(t, (req, res) => respond(res, response))
    await assert.rejects(analyze(service), codeIs(code))
  }
})

test('AI connection test rejects a valid JSON response with the wrong shape', async t => {
  const { service } = await mockService(t, (req, res) => respond(res, completion({ ok: true, unexpected: true })))
  await assert.rejects(service.testConnection(), codeIs('AI_INVALID_TEST_RESULT'))
})

test('AI rejects oversized responses both with content length and chunked encoding', async t => {
  for (const declaredLength of [true, false]) {
    const { service } = await mockService(t, (req, res) => {
      res.writeHead(200, declaredLength ? { 'Content-Length': String(32 * 1024 * 1024 + 1) } : {})
      res.end('x'.repeat(32 * 1024 * 1024 + 1))
    })
    await assert.rejects(analyze(service), codeIs('AI_RESPONSE_TOO_LARGE'))
  }
})

test('AI cancels an active request and does not retry it', async t => {
  let arrived
  const arrival = new Promise(resolve => { arrived = resolve })
  const { service, requests } = await mockService(t, () => arrived())
  const controller = new AbortController()
  const pending = analyze(service, { signal: controller.signal })
  await arrival
  controller.abort()
  await assert.rejects(pending, codeIs('AI_CANCELLED'))
  assert.equal(requests.length, 1)
  await assert.rejects(analyze(service, { signal: controller.signal }), codeIs('AI_CANCELLED'))
  assert.equal(requests.length, 1)
})

test('AI timeout covers an active request and retry waiting', async t => {
  const { service, config, requests } = await mockService(t, () => {})
  await assert.rejects(analyze(service, { config: { ...config, timeoutMs: 1000 } }), codeIs('AI_TIMEOUT'))
  assert.equal(requests.length, 1)
  const limited = await mockService(t, (req, res) => respond(res, {}, 429, { 'Retry-After': '30' }))
  await assert.rejects(analyze(limited.service, { config: { ...limited.config, timeoutMs: 1000 } }), codeIs('AI_TIMEOUT'))
  assert.equal(limited.requests.length, 1)
})

test('AI sanitizes network errors without retrying or forwarding credentials', async t => {
  const { config } = await mockService(t, (req, res) => respond(res))
  let calls = 0
  const service = createAiService({ getConfig: () => config, fetchImpl: async () => { calls++; throw new Error('private-test-key') } })
  await assert.rejects(analyze(service), codeIs('AI_NETWORK_ERROR'))
  assert.equal(calls, 1)
})

test('AI does not forward credentials through a provider redirect', async t => {
  const destination = await mockService(t, (req, res) => respond(res))
  const source = await mockService(t, (req, res) => respond(res, {}, 307, { Location: `${destination.config.baseUrl}/chat/completions` }))
  await assert.rejects(analyze(source.service), codeIs('AI_NETWORK_ERROR'))
  assert.equal(source.requests.length, 1)
  assert.equal(destination.requests.length, 0)
})

test('AI JSON object mode supplies the complete expected schema to the model', async t => {
  const { service, config, requests } = await mockService(t, (req, res) => respond(res))
  await analyze(service, { config: { ...config, responseMode: 'json_object' } })
  const prompt = requests[0].body.messages[0].content
  assert.ok(prompt.includes(JSON.stringify(schema)))
  assert.equal(requests[0].body.response_format.type, 'json_object')
  assert.equal(requests[0].body.response_format.json_schema, undefined)
  await assert.rejects(analyze(service, { config: { ...config, responseMode: 'json_object' }, schema: undefined }), codeIs('AI_SCHEMA_REQUIRED'))
  assert.equal(requests.length, 1)
})

test('AI rejects requests exceeding 128 KiB in UTF-8 before sending private input', async t => {
  const { service, requests } = await mockService(t, (req, res) => respond(res))
  const title = '书'.repeat(50000)
  assert.ok(title.length < 128 * 1024)
  assert.ok(Buffer.byteLength(title, 'utf8') > 128 * 1024)
  await assert.rejects(analyze(service, { payload: { books: [{ id: 'A', title }] } }), codeIs('AI_INPUT_TOO_LARGE'))
  assert.equal(requests.length, 0)
  await analyze(service, { payload: { books: [{ id: 'A', title: '书'.repeat(30000) }] } })
  assert.equal(requests.length, 1)
})

test('AI model listing uses the draft endpoint and key without requiring enabled or model', async t => {
  const { service, config, requests } = await mockService(t, (req, res) => respond(res, {
    data: [{ id: ' z-model ' }, { id: 'a-model' }, { id: 'z-model' }, { id: '' }, { id: 123 }, null]
  }), { enabled: false, model: '' })
  const result = await service.listModels({ config, apiKey: ' draft-key ' })
  assert.deepEqual(result, { models: ['a-model', 'z-model'] })
  assert.equal(requests[0].method, 'GET')
  assert.equal(requests[0].url, '/v1/models')
  assert.equal(requests[0].headers.authorization, 'Bearer draft-key')
  assert.equal(requests[0].body, null, 'model discovery must not send library data')
  await service.listModels({ config: { ...config, baseUrl: config.baseUrl.replace('/v1', '/gateway/v1/chat/completions/') + '?tenant=fixture' } })
  assert.equal(requests[1].url, '/gateway/v1/models?tenant=fixture')
})

test('AI model listing reuses a saved key when the draft key is blank and supports keyless local services', async t => {
  const { service, config, requests } = await mockService(t, (req, res) => respond(res, { data: [] }))
  assert.deepEqual(await service.listModels({ apiKey: '   ' }), { models: [] })
  assert.equal(requests[0].headers.authorization, 'Bearer private-test-key')
  assert.deepEqual(await service.listModels({ apiKey: '' }), { models: [] })
  assert.equal(requests[1].headers.authorization, 'Bearer private-test-key')
  const keyless = createAiService({ getConfig: () => config, getApiKey: () => '' })
  assert.deepEqual(await keyless.listModels(), { models: [] })
  assert.equal(requests[2].headers.authorization, undefined)
})

test('AI model listing rejects malformed response bodies with a safe model-list error', async t => {
  for (const body of ['private-test-key: invalid response', {}, { data: {} }, null]) {
    const { service } = await mockService(t, (req, res) => respond(res, body))
    await assert.rejects(service.listModels(), codeIs('AI_INVALID_MODEL_LIST'))
  }
})

test('AI model listing preserves HTTP error handling and retries one transient failure', async t => {
  for (const status of [401, 403, 404]) {
    const { service, requests } = await mockService(t, (req, res) => respond(res, { error: 'private-test-key' }, status))
    await assert.rejects(service.listModels(), codeIs(status === 404 ? 'AI_HTTP_ERROR' : 'AI_AUTH_FAILED'))
    assert.equal(requests.length, 1)
  }
  const transient = await mockService(t, (req, res, record, count) => {
    respond(res, count === 1 ? {} : { data: [{ id: 'recovered-model' }] }, count === 1 ? 503 : 200, { 'Retry-After': '0' })
  })
  assert.deepEqual(await transient.service.listModels(), { models: ['recovered-model'] })
  assert.equal(transient.requests.length, 2)
  assert.ok(transient.requests.every(request => request.method === 'GET' && request.body === null))
})

test('AI model listing times out and cancels without retrying', async t => {
  const timed = await mockService(t, () => {}, { timeoutMs: 1000 })
  await assert.rejects(timed.service.listModels(), codeIs('AI_TIMEOUT'))
  assert.equal(timed.requests.length, 1)
  let arrived
  const arrival = new Promise(resolve => { arrived = resolve })
  const cancelled = await mockService(t, () => arrived())
  const controller = new AbortController()
  const pending = cancelled.service.listModels({ signal: controller.signal })
  await arrival
  controller.abort()
  await assert.rejects(pending, codeIs('AI_CANCELLED'))
  assert.equal(cancelled.requests.length, 1)
  await assert.rejects(cancelled.service.listModels({ signal: controller.signal }), codeIs('AI_CANCELLED'))
  assert.equal(cancelled.requests.length, 1)
})

test('AI model listing enforces the response size limit and rejects unsafe service URLs', async t => {
  const { service, requests } = await mockService(t, (req, res) => respond(res, { data: [{ id: 'x'.repeat(1024 * 1024) }] }))
  await assert.rejects(service.listModels(), codeIs('AI_RESPONSE_TOO_LARGE'))
  for (const baseUrl of ['file:///private', 'https://name:private-test-key@example.com/v1', 'https://example.com/v1#secret']) {
    await assert.rejects(service.listModels({ config: { baseUrl } }), codeIs('AI_INVALID_URL'))
  }
  assert.equal(requests.length, 1)
})

test('AI model listing uses the injected transport and never follows credential-bearing redirects', async t => {
  const target = await mockService(t, (req, res) => respond(res, { data: [{ id: 'local-model' }] }))
  let transportCalls = 0
  const service = createAiService({ getConfig: () => target.config, getApiKey: () => 'private-test-key', fetchImpl: (url, options) => {
    transportCalls++
    return require('node-fetch')(url, options)
  } })
  assert.deepEqual(await service.listModels(), { models: ['local-model'] })
  assert.equal(transportCalls, 1)
  const source = await mockService(t, (req, res) => respond(res, {}, 307, { Location: `${target.config.baseUrl}/models` }))
  await assert.rejects(source.service.listModels(), codeIs('AI_NETWORK_ERROR'))
  assert.equal(target.requests.length, 1)
  assert.equal(source.requests.length, 1)
})

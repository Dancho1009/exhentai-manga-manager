const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')
const { Response } = require('node-fetch')
const { createAiLogger, safeAiLog } = require('../modules/ai_logger.js')
const { createAiService } = require('../modules/ai_service.js')

const response = (value, status = 200, headers = {}) => new Response(Readable.from([typeof value === 'string' ? value : JSON.stringify(value)]), { status, headers })
const completion = (value = { ok: true }) => ({ model: 'upstream-model-private', choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })
const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
const config = { enabled: true, provider: 'compatible', model: 'example-model', baseUrl: 'https://service.invalid/private-path?api_key=private-query', timeoutMs: 1000 }
const options = { payload: { task: 'dedupe', books: [{ id: 'A', title: 'private-book-title' }, { id: 'B', title: 'other-private-title' }], pairs: [{ leftId: 'A', rightId: 'B' }] },
  systemPrompt: 'private-system-prompt', schema, apiKey: 'private-api-key' }
const collector = () => {
  const lines = [], records = []
  const logger = createAiLogger({ write: line => { lines.push(line); const match = /^\[AI\] ([^ ]+) (.*)$/.exec(line); records.push({ event: match[1], ...JSON.parse(match[2]) }) }, now: () => 1800000000000 })
  return { logger, lines, records }
}
const streamed = (value = { ok: true }) => `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', model: 'private-upstream-model',
  output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }], usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 } } })}\n\n`

test('AI logger emits only fixed fields and never expands arbitrary objects or terminal controls', () => {
  const c = collector()
  c.logger('result:invalid', { provider: 'chatgpt-json', model: 'gpt-6.1-sol', task: 'dedupe', status: 'failed', bookCount: 3, pairCount: 2, totalCount: 4,
    errorCode: 'AI_RESULT_INVALID', validationReason: 'INVALID_VALUE', fieldPath: 'books[0].publication', warningCount: 2,
    apiKey: 'private-key', token: 'private-token', headers: { Authorization: 'private-auth' }, baseUrl: 'https://private-url',
    prompt: 'private-prompt', response: { content: 'private-response' }, path: 'D:\\private-path', bookId: 'private-book-id', groupId: 'private-group-id' })
  assert.deepEqual(c.records[0], { event: 'result:invalid', at: '2027-01-15T16:00:00.000+08:00', bookCount: 3, pairCount: 2, totalCount: 4,
    provider: 'chatgpt-json', task: 'dedupe', status: 'failed', validationReason: 'INVALID_VALUE', model: 'gpt-6.1-sol', errorCode: 'AI_RESULT_INVALID', fieldPath: 'books[0].publication', warningCount: 2 })
  assert.doesNotMatch(c.lines.join('\n'), /private-/)
  for (const model of ['D:/private-path', '/private-path', 'https://private-host/path', 'sk-private-key', 'Bearer private-token', 'gpt\n\u001b[31mprivate-token']) {
    c.logger.log('request:start', { model, requestId: -1, bookCount: NaN, pairCount: Infinity, errorCode: 'private-error', fieldPath: '../private-path', phase: 'private-phase', validationReason: 'PRIVATE_REASON' })
  }
  for (const entry of c.records.slice(1)) assert.deepEqual(entry, { event: 'request:start', at: '2027-01-15T16:00:00.000+08:00' })
  const previous = c.lines.length
  c.logger('private-event', { model: 'private-model' })
  assert.equal(c.lines.length, previous)
})

test('injected loggers receive the same safe fields, and sync or async logger failures never escape', async () => {
  let captured
  safeAiLog((event, details) => { captured = { event, details } }, 'request:finish', { model: 'valid-model', token: 'private-token', prompt: 'private-prompt', bookCount: 2 })
  assert.deepEqual(captured, { event: 'request:finish', details: { model: 'valid-model', bookCount: 2 } })
  const fail = () => { throw new Error('private-logging-error') }
  const loggers = [fail, { log: fail }, async () => { throw new Error('private-async-error') },
    createAiLogger({ write: fail }), createAiLogger({ now: fail }), createAiLogger({ write: async () => { throw new Error('private-async-error') } })]
  for (const logger of loggers) safeAiLog(logger, 'request:start', { bookCount: 1 })
  await new Promise(resolve => setImmediate(resolve))
})

test('TPS logging preserves fractional values and real zero but omits missing or invalid speeds', () => {
  const c=collector()
  for(const outputTps of [16.67,0,null,NaN,Infinity,-1,'12.5']) c.logger('request:finish',{outputTps,tpsDurationMs:3000})
  assert.equal(c.records[0].outputTps,16.67)
  assert.equal(c.records[1].outputTps,0)
  assert.ok(c.records.slice(2).every(record=>!Object.hasOwn(record,'outputTps')))
})

test('compatible requests log one start/finish, task counts, elapsed time, HTTP status and usage without payload data', async () => {
  const c = collector()
  let clock = 1000
  const service = createAiService({ getConfig: () => config, logger: c.logger, now: () => clock,
    fetchImpl: async () => { clock += 42; return response(completion({ ok: true, private: 'private-output-text' })) } })
  const result = await service.analyze(options)
  assert.equal(result.value.private, 'private-output-text')
  assert.deepEqual(c.records.map(item => item.event), ['request:start', 'request:finish'])
  const [start, finish] = c.records
  assert.equal(start.requestId, finish.requestId)
  assert.equal(start.task, 'dedupe')
  assert.equal(start.provider, 'compatible')
  assert.equal(start.model, 'example-model')
  assert.equal(start.timeoutMs, 1000)
  assert.equal(start.timeoutMode, 'request_total')
  assert.equal(start.bookCount, 2)
  assert.equal(start.pairCount, 1)
  assert.equal(finish.status, 'completed')
  assert.equal(finish.durationMs, 42)
  assert.equal(finish.httpStatus, 200)
  assert.equal(finish.inputTokens, 5)
  assert.equal(finish.outputTokens, 3)
  assert.equal(finish.totalTokens, 8)
  assert.equal(finish.outputTps, 71.43)
  assert.doesNotMatch(c.lines.join('\n'), /private-|upstream-model|Authorization|apiKey|baseUrl|prompt|response|title|leftId|rightId/)
})

test('TPS without diagnostic storage still measures the successful HTTP attempt separately from retries', async () => {
  const c=collector()
  let clock=1000,calls=0
  const service=createAiService({getConfig:()=>config,logger:c.logger,now:()=>clock,fetchImpl:async()=>{
    if(++calls===1){clock+=8000;return response({error:'busy'},503,{'retry-after':'0'})}
    clock+=1000;return response(completion())
  }})
  await service.analyze(options)
  const finish=c.records.find(record=>record.event==='request:finish')
  assert.equal(finish.outputTps,3)
  assert.equal(finish.tpsDurationMs,1000)
  assert.equal(finish.durationMs,9000)
})

test('service facade logs connection, models and normalization as distinct tasks without duplicating connection requests', async () => {
  const c = collector()
  const service = createAiService({ getConfig: () => config, logger: c.logger, fetchImpl: async (_url, args) => args.method === 'GET' ? response({ data: [{ id: 'model-a' }, { id: 'model-b' }] }) : response(completion()) })
  await service.testConnection()
  await service.listModels()
  await service.analyze({ ...options, payload: { ...options.payload, task: 'normalize', pairs: [] } })
  assert.deepEqual(c.records.map(item => [item.event, item.task, item.requestId]), [
    ['request:start', 'connection', 1], ['request:finish', 'connection', 1], ['request:start', 'models', 2], ['request:finish', 'models', 2],
    ['request:start', 'normalize', 3], ['request:finish', 'normalize', 3]
  ])
  assert.equal(c.records[3].modelCount, 2)
  assert.equal(c.records[0].bookCount, 0)
})

test('transient compatible errors emit one retry and still finish a single logical request', async () => {
  const c = collector()
  let count = 0
  const service = createAiService({ getConfig: () => config, logger: c.logger, fetchImpl: async () => ++count === 1 ? response({ error: 'private-upstream-error' }, 503, { 'retry-after': '0' }) : response(completion()) })
  await service.analyze(options)
  assert.deepEqual(c.records.map(item => item.event), ['request:start', 'request:retry', 'request:finish'])
  assert.equal(c.records[1].attempt, 2)
  assert.equal(c.records[1].httpStatus, 503)
  assert.equal(c.records[1].errorCode, 'AI_HTTP_ERROR')
  assert.equal(c.records[2].httpStatus, 200)
  assert.ok(c.records.every(item => item.requestId === 1))
  assert.doesNotMatch(c.lines.join('\n'), /private-/)
})

test('ChatGPT credential retry and streamed usage share the facade log and omit credentials and stream text', async () => {
  const c = collector()
  let count = 0
  const service = createAiService({ getConfig: () => ({ ...config, provider: 'chatgpt-json', chatgptJsonModel: 'gpt-6.1-sol', chatgptJsonReasoningEffort: 'high' }), logger: c.logger,
    getOAuthCredential: async () => ({ kind: 'codex', accountId: 'private-account-id', accessToken: 'private-access-token' }),
    fetchImpl: async () => ++count === 1 ? response({ error: { message: 'private-upstream-body' } }, 401) : response(streamed({ ok: true, private: 'private-stream-output' })) })
  await service.analyze({ ...options, payload: { ...options.payload, task: 'series' } })
  assert.deepEqual(c.records.map(item => item.event), ['request:start', 'request:retry', 'request:finish'])
  assert.equal(c.records[0].task, 'series')
  assert.equal(c.records[0].provider, 'chatgpt-json')
  assert.equal(c.records[0].reasoningEffort, 'high')
  assert.equal(c.records[0].timeoutMode, 'stream_idle')
  assert.equal(c.records[1].httpStatus, 401)
  assert.equal(c.records[1].errorCode, 'AI_AUTH_FAILED')
  assert.equal(c.records[2].inputTokens, 9)
  assert.equal(c.records[2].outputTokens, 4)
  assert.equal(c.records[2].totalTokens, 13)
  assert.doesNotMatch(c.lines.join('\n'), /private-|backend-api|Authorization|accessToken|accountId/)
})

test('HTTP, parse, connection validation and cancellation failures always finish once with a controlled code', async () => {
  for (const [handler, invoke, expected, httpStatus] of [
    [async () => response({ error: { message: 'private-upstream-error' } }, 400), service => service.analyze(options), 'AI_HTTP_ERROR', 400],
    [async () => response(completion([])), service => service.analyze(options), 'AI_INVALID_JSON', 200],
    [async () => response(completion({ ok: true, extra: 'private-extra' })), service => service.testConnection(), 'AI_INVALID_TEST_RESULT', 200],
    [async () => { throw new Error('private-network-message') }, service => service.analyze(options), 'AI_NETWORK_ERROR', undefined],
    [async () => { throw new Error('must-not-request') }, service => { const controller = new AbortController(); controller.abort(); return service.analyze({ ...options, signal: controller.signal }) }, 'AI_CANCELLED', undefined]
  ]) {
    const c = collector()
    const service = createAiService({ getConfig: () => config, logger: c.logger, fetchImpl: handler })
    await assert.rejects(invoke(service), { code: expected })
    assert.deepEqual(c.records.map(item => item.event), ['request:start', 'request:finish'])
    assert.equal(c.records[1].status, expected === 'AI_CANCELLED' ? 'cancelled' : 'failed')
    assert.equal(c.records[1].errorCode, expected)
    assert.equal(c.records[1].httpStatus, httpStatus)
    assert.doesNotMatch(c.lines.join('\n'), /private-|must-not-request/)
  }
})

test('an injected throwing logger cannot alter successful requests or replace their original errors', async () => {
  const logger = () => { throw new Error('logger failed') }
  const service = createAiService({ getConfig: () => config, logger, fetchImpl: async () => response(completion()) })
  assert.deepEqual((await service.analyze(options)).value, { ok: true })
  const failed = createAiService({ getConfig: () => config, logger, fetchImpl: async () => response({}, 401) })
  await assert.rejects(failed.analyze(options), { code: 'AI_AUTH_FAILED' })
})

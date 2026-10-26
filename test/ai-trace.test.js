const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { Readable } = require('node:stream')
const { Response } = require('node-fetch')
const { AiTraceStore } = require('../modules/ai_trace_store.js')
const { createAiService } = require('../modules/ai_service.js')
const { attemptThroughput } = require('../modules/ai_tps.js')
const { MAX_STREAM_BYTES, MAX_CONTENT_BYTES } = require('../modules/ai_response_limits.js')

const config = { enabled:true, baseUrl:'https://fixture.invalid/v1?api_key=private-query', model:'fixture', stream:true, timeoutMs:1000 }
const schema = {type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false}
const options = { payload:{task:'normalize',books:[{id:'a',title:'书籍甲'}],pairs:[]}, schema, systemPrompt:'Parse supplied books.',
  traceContext:{runId:'fixture-run',batchId:'normalize-1',phase:'normalizing',batchIndex:1,batchTotal:1,managed:true,bookCount:1,pairCount:0,members:[{id:'a',title:'书籍甲'}]} }
const response = (text, status=200, headers={}) => new Response(Readable.from([Buffer.from(text)]), {status,headers})
const frame = delta => `data: ${JSON.stringify({id:'fixture-response',model:'fixture',choices:[{delta}]})}\n\n`
const complete = 'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}})+'\n\ndata: [DONE]\n\n'
const fixture = async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(),'emm-trace-'))
  const lines = []
  const store = new AiTraceStore({storePath:folder,write:line=>lines.push(line)})
  await store.ready
  t.after(async()=>{await store.close(); assert.equal(path.dirname(folder),os.tmpdir()); await fs.rm(folder,{recursive:true,force:true})})
  return {folder,store,lines}
}

test('TPS uses per-attempt output usage including reasoning, excludes local validation and survives history reload', async t => {
  const { folder, store, lines } = await fixture(t)
  let clock = Date.parse('2026-10-17T00:00:00Z')
  store.now = () => clock
  const observer = store.createRequest(options.traceContext, 1)
  await observer.startAttempt(1, {url:'https://fixture.invalid/v1/chat/completions',method:'POST',body:'{}'})
  clock += 1000 // Waiting for the first byte counts in end-to-end TPS.
  await observer.raw(Buffer.from('data: fixture\n\n'))
  await observer.text('reasoning', '思考内容')
  observer.usage({prompt_tokens:500,completion_tokens:120,total_tokens:620,completion_tokens_details:{reasoning_tokens:100}})
  assert.equal(observer.stats().outputTps, undefined, 'A running attempt does not estimate speed from bytes')
  clock += 2000
  observer.received()
  clock += 6000 // JSON validation/diagnostic flushing is outside response time.
  await observer.finish({usage:{prompt_tokens:500,completion_tokens:120,total_tokens:620,completion_tokens_details:{reasoning_tokens:100}},finishReason:'stop'})
  assert.equal(observer.stats().outputTps, 40, 'Input tokens are excluded and reasoning is not counted twice')
  assert.equal(observer.stats().tpsDurationMs, 3000)
  await observer.startAttempt(2, {url:'https://fixture.invalid/v1/chat/completions',method:'POST',body:'{}'})
  clock += 3000
  await observer.raw(Buffer.from('data: partial\n\n'))
  observer.usage({completion_tokens:50})
  observer.received()
  await observer.finish(null, Object.assign(new Error('length'),{code:'AI_RESPONSE_TRUNCATED',finishReason:'length'}))
  assert.equal(observer.stats().outputTps, 16.67, 'The second attempt does not include the first attempt duration or tokens')
  let snapshot = await store.snapshot({runId:'fixture-run'})
  assert.equal(snapshot.batches[0].attempts[0].outputTps, 40)
  assert.equal(snapshot.batches[0].attempts[1].outputTps, 16.67)
  assert.equal(snapshot.batches[0].attempts[1].status, 'failed', 'A measured TPS does not turn a failure into a success')
  assert.ok(lines.some(line=>line.includes('平均TPS40.00 tokens/s')))
  await store.close()
  const restored = new AiTraceStore({storePath:folder,write:()=>{}})
  snapshot = await restored.snapshot({runId:'fixture-run'})
  assert.equal(snapshot.batches[0].attempts[0].outputTps, 40)
  await restored.close()
})

test('TPS treats unknown usage, invalid timing and cache as unavailable while preserving real zero output', async t => {
  const startedAt='2026-10-17T00:00:00Z',completedAt='2026-10-17T00:00:02Z'
  assert.equal(attemptThroughput({startedAt,completedAt,usage:{completion_tokens:0}}).outputTps,0)
  for(const attempt of [{startedAt,completedAt}, {startedAt,usage:{completion_tokens:12}},
    {startedAt,completedAt:startedAt,usage:{completion_tokens:12}}, {startedAt:completedAt,completedAt:startedAt,usage:{completion_tokens:12}},
    {startedAt,completedAt,usage:{completion_tokens:-1}}, {startedAt,completedAt,usage:{completion_tokens:'12'}}]) {
    assert.equal(attemptThroughput(attempt).outputTps,null)
  }
  const {store}=await fixture(t)
  store.batch(options.traceContext,{status:'cached',savedCount:1})
  const snapshot=await store.snapshot({runId:'fixture-run'})
  assert.equal(snapshot.batches[0].attempts,undefined)
})

test('recovered batches retain original diagnostics across restart and print final recovery totals', async t => {
  const { folder, store, lines } = await fixture(t)
  store.run('fixture-run', { status: 'running', phase: 'normalizing', totalBooks: 3, cachedBooks: 0,
    savedBooks: 3, normalizationFirstPassSaved: 2, normalizationRetrySaved: 1, normalizationRetryPending: 0,
    normalizationSubmitted: 3 })
  store.batch(options.traceContext, { status: 'recovered', bookCount: 3, savedCount: 2, returnedCount: 3,
    recoverySavedCount: 1, effectiveSavedCount: 3, unresolvedCount: 0, failedCount: 1, errorCode: 'AI_RESULT_INVALID' })
  store.run('fixture-run', { status: 'completed' })
  await store.close()
  const restored = new AiTraceStore({ storePath: folder, write: () => {} })
  const snapshot = await restored.snapshot({ runId: 'fixture-run' })
  assert.equal(snapshot.batches[0].status, 'recovered')
  assert.equal(snapshot.batches[0].errorCode, 'AI_RESULT_INVALID')
  assert.equal(snapshot.batches[0].effectiveSavedCount, 3)
  assert.ok(lines.some(line => /已恢复.*补试保存1 仍未解决0.*首次错误 AI_RESULT_INVALID/.test(line)))
  assert.ok(lines.some(line => /首次保存2 补试保存1 待补试0.*尚未请求0/.test(line)))
  await restored.close()
})

test('length truncation retains raw content, trailing usage and requested controls for both response modes', async t => {
  for(const stream of [true,false]){
    const {store,lines}=await fixture(t)
    const usage={prompt_tokens:3875,completion_tokens:16383,total_tokens:20258,completion_tokens_details:{reasoning_tokens:14721}}
    const raw=stream ? frame({reasoning_content:'公开字段'})+frame({content:'{"books":['})+
      'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'length'}]})+'\n\n'+
      'data: '+JSON.stringify({choices:[],usage})+'\n\ndata: [DONE]\n\n'
      : JSON.stringify({choices:[{finish_reason:'length',message:{content:'{"books":[',reasoning_content:'公开字段'}}],usage})
    const service=createAiService({getConfig:()=>({...config,stream,compatibleThinkingMode:'disabled',compatibleMaxOutputTokens:32768}),traceStore:store,logger:()=>{},
      fetchImpl:async()=>response(raw,200,{'content-type':stream?'text/event-stream':'application/json'})})
    await assert.rejects(service.analyze(options),error=>error.truncationReason==='length')
    const snapshot=await store.snapshot({runId:'fixture-run'}),batch=snapshot.batches[0],attempt=batch.attempts[0]
    assert.equal(attempt.finishReason,'length')
    assert.equal(attempt.truncationReason,'length')
    assert.equal(attempt.usage.completion_tokens_details.reasoning_tokens,14721)
    assert.equal(batch.thinkingMode,'disabled')
    assert.equal(batch.maxOutputTokens,32768)
    assert.equal(attempt.thinkingControlMismatch,true)
    assert.equal((await store.readText({...options.traceContext,requestId:1,attempt:1,kind:'content'})).text,'{"books":[')
    assert.ok(lines.some(line=>line.includes('思考tokens14721')&&line.includes('finish_reason=length')))
    assert.ok(lines.some(line=>line.includes('请求关闭思考但上游仍返回思考')))
  }
})

test('trace stores each HTTP attempt, real messages, partial stream and validation separately, then restores history', async t => {
  const {folder,store,lines}=await fixture(t)
  let calls=0
  const service=createAiService({getConfig:()=>config,getApiKey:()=> 'private-credential',traceStore:store,logger:()=>{},fetchImpl:async()=>++calls===1
    ? response('{"error":"busy"}',503,{'retry-after':'0'})
    : response(frame({reasoning_content:'公开字段'})+frame({content:'{"ok":true}'})+complete,200,{'content-type':'text/event-stream'})})
  store.batch(options.traceContext,{status:'queued'})
  const result=await service.analyze(options)
  assert.deepEqual(result.value,{ok:true})
  await store.validation(result.traceContext,{status:'validated',value:result.value})
  store.batch(options.traceContext,{status:'completed',returnedCount:1,validatedCount:1,savedCount:1})
  store.run('fixture-run',{status:'completed',savedBooks:1})
  const snapshot=await store.snapshot({runId:'fixture-run'})
  const batch=snapshot.batches[0]
  assert.equal(batch.requestId,1)
  assert.equal(batch.status,'completed')
  assert.deepEqual(batch.attempts.map(item=>item.status),['failed','completed'])
  assert.equal(batch.attempts[0].errorCode,'AI_HTTP_ERROR')
  assert.equal(batch.attempts[1].contentBytes,11)
  assert.equal(batch.attempts[1].usage.total_tokens,5)
  assert.ok(batch.attempts[1].firstByteAt.endsWith('+08:00'))
  const req={...options.traceContext,requestId:1,attempt:2}
  const messages=(await store.readText({...req,kind:'messages'})).text
  assert.match(messages,/Parse supplied books/)
  assert.doesNotMatch(messages,/private-credential|private-query|Authorization/)
  assert.equal((await store.readText({...req,kind:'content'})).text,'{"ok":true}')
  assert.equal((await store.readText({...req,kind:'reasoning'})).text,'公开字段')
  assert.match((await store.readText({...req,kind:'sse'})).text,/data: \[DONE\]/)
  assert.equal(JSON.parse((await store.readText({...req,kind:'validation'})).text).status,'validated')
  assert.ok(lines.some(line=>line.includes('保存1')))
  await store.close()
  const restored=new AiTraceStore({storePath:folder,write:()=>{}})
  const again=await restored.snapshot({runId:'fixture-run'})
  assert.equal(again.batches[0].savedCount,1)
  assert.equal(again.batches[0].attempts.length,2)
  await restored.close()
})

test('wire envelopes greater than 1MiB do not reject a small final JSON, for both protocols',async t=>{
  for(const provider of ['compatible','chatgpt-json']) {
    const {store}=await fixture(t)
    const bodyText=JSON.stringify({text:'甲'.repeat(12000)})
    const chunks=provider==='compatible' ? [...bodyText].map(char=>frame({content:char})).join('')+complete
      : [...bodyText].map(char=>`event: response.output_text.delta\ndata: ${JSON.stringify({type:'response.output_text.delta',delta:char,item_id:'fixture-item-with-protocol-metadata',response_id:'fixture-response-with-metadata'})}\n\n`).join('')+
        `data: ${JSON.stringify({type:'response.completed',response:{status:'completed',output:[{content:[{type:'output_text',text:bodyText}]}]}})}\n\n`
    assert.ok(Buffer.byteLength(chunks)>MAX_CONTENT_BYTES)
    const service=createAiService({getConfig:()=>({...config,provider,chatgptJsonModel:'fixture'}),traceStore:store,logger:()=>{},getOAuthCredential:async()=>({kind:'codex',accessToken:'private-access',accountId:'private-account'}),
      fetchImpl:async()=>response(chunks,200,{'content-type':'text/event-stream'})})
    const result=await service.analyze(options)
    assert.equal(result.value.text.length,12000)
    const batch=(await store.snapshot({runId:'fixture-run'})).batches[0]
    assert.equal(batch.attempts[0].contentBytes,Buffer.byteLength(bodyText),'completed event does not double count deltas')
    assert.ok(batch.attempts[0].streamBytes>MAX_CONTENT_BYTES)
  }
})

test('real output limits identify stream/content and retain failed raw data without replay',async t=>{
  for(const provider of ['compatible','chatgpt-json']) for(const limitKind of ['stream','content']) {
    const {store}=await fixture(t)
    const content='x'.repeat(MAX_CONTENT_BYTES+1)
    const chunks=limitKind==='stream' ? ':'+' '.repeat(MAX_STREAM_BYTES)+'\n\n' : provider==='compatible' ? frame({content}) : `data: ${JSON.stringify({type:'response.output_text.delta',delta:content})}\n\n`
    let calls=0
    const service=createAiService({getConfig:()=>({...config,provider,chatgptJsonModel:'fixture'}),traceStore:store,logger:()=>{},getOAuthCredential:async()=>({kind:'codex',accessToken:'private-access',accountId:'private-account'}),fetchImpl:async()=>{calls++;return response(chunks,200,{'content-type':'text/event-stream'})}})
    await assert.rejects(service.analyze(options),error=>error.code==='AI_RESPONSE_TOO_LARGE'&&error.limitKind===limitKind)
    assert.equal(calls,1)
    const batch=(await store.snapshot({runId:'fixture-run'})).batches[0]
    assert.equal(batch.status,'failed')
    assert.equal(batch.attempts[0].complete,false)
    assert.equal(batch.attempts[0].limitKind,limitKind)
    assert.ok((await store.readText({...options.traceContext,requestId:1,kind:'sse'})).totalBytes>0)
  }
})

test('failed JSON and cancellation retain the received text; unknown usage remains null',async t=>{
  const {store}=await fixture(t)
  const service=createAiService({getConfig:()=>config,traceStore:store,logger:()=>{},fetchImpl:async()=>response(frame({content:'{broken'})+'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',200,{'content-type':'text/event-stream'})})
  await assert.rejects(service.analyze(options),{code:'AI_INVALID_JSON'})
  const batch=(await store.snapshot({runId:'fixture-run'})).batches[0]
  assert.equal(batch.attempts[0].usage,null)
  assert.equal((await store.readText({...options.traceContext,requestId:1,kind:'content'})).text,'{broken')
  await assert.rejects(store.readText({runId:'../',batchId:'normalize-1',requestId:1,kind:'sse'}),/AI_TRACE_INVALID_ID/)
  await assert.rejects(store.readText({...options.traceContext,requestId:1,kind:'../../setting'}),/AI_TRACE_INVALID_ID/)
})

test('paged UTF-8 text reads preserve characters and report preview continuation',async t=>{
  const {store}=await fixture(t)
  const request=store.createRequest(options.traceContext,1)
  await request.startAttempt(1,{url:'https://example.invalid',method:'POST',body:'{}'})
  await request.text('content','汉字🙂末尾')
  await request.finish({value:{}})
  let offset=0,text=''
  for(let i=0;i<10;i++) {
    const part=await store.readText({...options.traceContext,requestId:1,kind:'content',offset,limit:4})
    text+=part.text;offset=part.nextOffset
    if(!part.hasMore)break
  }
  assert.equal(text,'汉字🙂末尾')
})

test('cancellation records partial raw data and never turns a received fragment into a parsed result',async t=>{
  const {store}=await fixture(t)
  const controller=new AbortController()
  let calls=0
  const service=createAiService({getConfig:()=>config,traceStore:store,logger:()=>{},fetchImpl:async()=>{
    calls++
    return new Response(Readable.from((async function*(){yield Buffer.from(frame({content:'{"ok":'}));await new Promise(resolve=>setTimeout(resolve,30));controller.abort();yield Buffer.from(frame({content:'true}'}))})()),{headers:{'content-type':'text/event-stream'}})
  }})
  await assert.rejects(service.analyze({...options,signal:controller.signal}),{code:'AI_CANCELLED'})
  const batch=(await store.snapshot({runId:'fixture-run'})).batches[0]
  assert.equal(batch.status,'cancelled')
  assert.equal(batch.attempts[0].complete,false)
  assert.equal(calls,1)
  assert.equal((await store.readText({...options.traceContext,requestId:1,kind:'content'})).text,'{"ok":')
  assert.equal((await store.readText({...options.traceContext,requestId:1,kind:'parsed'})).text,'')
})

test('diagnostic artifact failures are visible without replacing a successful AI result',async t=>{
  const {store}=await fixture(t)
  const original=fs.writeFile
  t.mock.method(fs,'writeFile',async(filename,...args)=>{
    if(String(filename).endsWith('messages.txt')||String(filename).endsWith('parsed.txt')) throw Object.assign(new Error('fixture trace permission'),{code:'EACCES'})
    return original(filename,...args)
  })
  const service=createAiService({getConfig:()=>config,traceStore:store,logger:()=>{},fetchImpl:async()=>response(frame({content:'{"ok":true}'})+complete,200,{'content-type':'text/event-stream'})})
  assert.deepEqual((await service.analyze(options)).value,{ok:true})
  assert.equal((await store.snapshot({runId:'fixture-run'})).storageError,'EACCES')
})

test('reported usage is retained in terminal diagnostics when the final model JSON is invalid',async t=>{
  const {store}=await fixture(t)
  const events=[]
  const service=createAiService({getConfig:()=>config,traceStore:store,logger:(event,detail)=>events.push({event,...detail}),fetchImpl:async()=>response(frame({content:'{broken'})+complete,200,{'content-type':'text/event-stream'})})
  await assert.rejects(service.analyze(options),{code:'AI_INVALID_JSON'})
  const finish=events.find(item=>item.event==='request:finish')
  assert.equal(finish.status,'failed')
  assert.equal(finish.totalTokens,5)
  const batch=(await store.snapshot({runId:'fixture-run'})).batches[0]
  assert.equal(batch.attempts[0].usage.total_tokens,5)
  assert.equal(batch.attempts[0].complete,true)
})

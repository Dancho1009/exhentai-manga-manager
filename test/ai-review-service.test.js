const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { getEventListeners, getMaxListeners } = require('node:events')
const { Readable } = require('node:stream')
const { Response } = require('node-fetch')
const { createFixture } = require('./fixtures/dedupe-fixture.cjs')
const { AiReviewService } = require('../modules/audit/ai_review_service.js')
const { loadAiBooks, bookSnapshotKey, legacyBookSnapshotKey } = require('../modules/audit/ai_snapshot.js')
const { LibraryTaskCoordinator } = require('../modules/audit/task_coordinator.js')
const { DEFAULT_AI_CONFIG, createAiService } = require('../modules/ai_service.js')
const { AI_PROMPT_VERSION } = require('../modules/audit/ai_relation_contract.js')
const { DEDUPE_RULES_VERSION } = require('../modules/audit/dedupe_title.js')
const { createAiLogger } = require('../modules/ai_logger.js')
const { AiTraceStore } = require('../modules/ai_trace_store.js')
const { AuditCache } = require('../modules/audit/cache.js')
const { stableId } = require('../modules/audit/utils.js')

const clone = value => JSON.parse(JSON.stringify(value))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const responseFor = (payload, relation = 'same_work_same_part') => {
  const books = payload.books.map(book => ({
      id: book.id, workTitle: 'Fixture edition', seriesTitle: null, authors: book.authors,
      titleAliases: [], chapter: null, volume: null, publication: null, uncertainties: [],
      evidenceRefs: [{ bookId: book.id, field: 'title', quote: book.title }]
    }))
  const relations = payload.pairs.map(pair => ({ leftId: pair.leftId, rightId: pair.rightId, relation, reason: 'Fixture semantic relationship.' }))
  return { value: payload.task === 'normalize' ? { books, relations: [] } : { relations },
  model: 'test-model', usage: { total_tokens: 4 }
  }
}

const fixtureFor = async (t, { count = 3, analyze, config = {}, logger, titles = [], tracing = false } = {}) => {
  const fixture = await createFixture(Array.from({ length: count }, (_, index) => ({
    id: index < 26 ? String.fromCharCode(97 + index) : `book-${index}`, title: titles[index] || 'Fixture edition', url: '', entries: { '001.jpg': 'page ' + index }
  })))
  const loadBooks = () => loadAiBooks(fixture)
  const books = await loadBooks()
  const items = await Promise.all(books.map(async book => ({ ...book, mtimeMs: (await fs.stat(book.filepath)).mtimeMs })))
  const report = { reportId: 'fixture-report', groups: [{ id: 'fixture-group', evidenceRevision: 'revision-1', items }] }
  const coordinator = new LibraryTaskCoordinator()
  const currentConfig = { ...DEFAULT_AI_CONFIG, enabled: true, baseUrl: 'http://localhost/v1', model: 'test-model', maxRequests: 20, ...config }
  const calls = []
  const aiService = { analyze: async options => { calls.push(options); return analyze ? analyze(options, calls.length) : responseFor(options.payload) } }
  const traceStore = tracing ? new AiTraceStore({ storePath: fixture.root, write: () => {} }) : undefined
  const options = { storePath: fixture.root, coordinator, aiService, getConfig: () => currentConfig, loadBooks, getDedupeReport: async () => clone(report), ...(logger ? { logger } : {}), traceStore }
  const service = new AiReviewService(options)
  await service.initialize()
  t.after(async () => {
    await service.interruptForExit()
    await traceStore?.close()
    await fixture.cleanup()
  })
  return { ...fixture, service, report, options, config: currentConfig, coordinator, calls, loadBooks, traceStore }
}
const run = async (service, request = { task: 'dedupe', reportId: 'fixture-report' }) => {
  await service.start(request)
  await service.activePromise
  return service.getState()
}

test('AI snapshot uses effective database metadata and changes its key with semantic input', async t => {
  const fixture = await fixtureFor(t, { count: 2 })
  const first = (await fixture.loadBooks())[0]
  await fixture.Metadata.update({ title: 'Updated effective title' }, { where: { hash: first.hash } })
  const updated = (await fixture.loadBooks())[0]
  assert.equal(updated.title, 'Updated effective title')
  assert.notEqual(bookSnapshotKey(first), bookSnapshotKey(updated))
  assert.equal(updated.mtimeMs, null, 'metadata discovery does not walk archive files')
})

test('full-library AI sends contained chapters to coverage results rather than duplicate pairs', async t => {
  const fixture = await fixtureFor(t, { count: 2, titles: ['Title Ch.1-3', 'Title Ch.2'] })
  const state = await run(fixture.service, { task: 'discovery' })
  assert.equal(state.status, 'completed')
  assert.equal(state.relationCounts.same_work_left_contains_right, 1)
  assert.deepEqual(await fixture.service.getValidCandidatePairs({ runId: state.runId }), [])
  assert.deepEqual(await fixture.service.getValidCoveragePairs({ runId: state.runId }),
    [{ leftId: 'a', rightId: 'b', relation: 'same_work_left_contains_right' }])
})

test('starting after terminal state waits for the previous run final save instead of reporting already running', async t => {
  const fixture=await fixtureFor(t,{count:2})
  const entered=deferred(),release=deferred()
  const original=fixture.service.persist.bind(fixture.service)
  let held=false
  fixture.service.persist=async()=>{
    if(fixture.service.finishing&&!held){held=true;entered.resolve();await release.promise}
    return original()
  }
  await fixture.service.start({task:'discovery'})
  await entered.promise
  const starting=fixture.service.start({task:'discovery'})
  release.resolve()
  const next=await starting
  assert.equal(next.status,'running')
  await fixture.service.waitForIdle()
  assert.equal(fixture.service.getState().status,'completed')
})

test('batch telemetry counts actual returned and missing books before fallback and reuses only successful item cache', async t => {
  let omit = true
  const fixture = await fixtureFor(t, { count: 3, tracing: true, analyze: ({payload}) => {
    const response = responseFor(payload)
    if (payload.task === 'normalize' && omit) response.value.books = response.value.books.filter(book => book.id !== 'c')
    return response
  } })
  const first = await run(fixture.service, {task:'discovery'})
  const snapshot = await fixture.traceStore.snapshot({runId:first.runId})
  const batch = snapshot.batches.find(batch => batch.phase === 'normalizing')
  assert.equal(batch.bookCount,3)
  assert.equal(batch.returnedCount,2)
  assert.equal(batch.validatedCount,2)
  assert.equal(batch.savedCount,2)
  assert.equal(batch.missingCount,1)
  assert.equal(batch.status,'partial')
  assert.equal(first.normalizationSaved,2)
  assert.equal(first.normalizationMissing,1)
  assert.equal(first.partial,true)
  omit = false
  const boundary=fixture.calls.length
  const second = await run(fixture.service,{task:'discovery'})
  assert.equal(second.normalizationCached,2)
  assert.deepEqual(fixture.calls.slice(boundary).filter(call=>call.payload.task==='normalize').map(call=>call.payload.books.length),[1])
})

test('batch evidence rejection and size failures report affected book counts and stop further size-limited dispatch', async t => {
  for (const sizeError of [false,true]) {
    const fixture=await fixtureFor(t,{count:6,tracing:true,config:{normalizationBatchSize:3,concurrency:1},analyze:({payload})=>{
      if(payload.task==='normalize') {
        if(sizeError) throw Object.assign(new Error('limit'),{code:'AI_RESPONSE_TOO_LARGE'})
        const response=responseFor(payload)
        response.value.books[0].evidenceRefs[0].quote='not present in the supplied metadata'
        return response
      }
      return responseFor(payload)
    }})
    const state=await run(fixture.service,{task:'discovery'})
    const {batches}=await fixture.traceStore.snapshot({runId:state.runId})
    const batch=batches.find(batch=>batch.batchId==='normalize-1')
     assert.equal(batch.status, sizeError ? 'failed' : 'partial')
    if(sizeError) {
       assert.equal(batch.savedCount,0)
       assert.equal(batch.failedCount,3)
      assert.equal(state.status,'failed')
      assert.equal(state.normalizationSubmitted,3)
      assert.equal(state.normalizationFailedBooks,3)
      assert.equal(fixture.calls.length,1)
      assert.equal(batches.find(batch=>batch.batchId==='normalize-2').status,'not_requested')
    } else {
      assert.equal(state.normalizationFailedBooks,2)
      assert.equal(state.normalizationSaved,4, 'Valid members are cached even when another book has invalid evidence')
      assert.equal(batches.filter(item=>item.recoveryOf).reduce((sum,item)=>sum+(item.failedCount||0),0),2)
      assert.equal(fixture.calls.filter(call=>call.payload.task==='dedupe').length,0, 'Unparsed books cannot enter candidate classification')
      assert.equal(batch.errorDetail.path,'books[0].evidenceRefs[0].quote')
    }
  }
})

test('malformed normalization batches split into recoverable child requests', async t => {
  const fixture = await fixtureFor(t, { count: 4, tracing: true, config: { normalizationBatchSize: 4, concurrency: 1 },
    analyze: ({ payload }) => {
      if (payload.task === 'normalize' && payload.books.length > 1) throw Object.assign(new Error('bad JSON'), { code: 'AI_INVALID_JSON' })
      return responseFor(payload)
    } })
  const state = await run(fixture.service, { task: 'discovery' })
  const normalizeCalls = fixture.calls.filter(call => call.payload.task === 'normalize').map(call => call.payload.books.length)
  assert.equal(normalizeCalls[0], 4)
  assert.deepEqual(normalizeCalls.slice(1).sort((left, right) => right - left), [2, 2, 1, 1, 1, 1])
  assert.equal(state.normalizationSaved, 4)
  assert.equal(state.normalizationFailedBooks, 0)
  const { batches } = await fixture.traceStore.snapshot({ runId: state.runId })
  assert.equal(batches.find(batch => batch.batchId === 'normalize-1').status, 'recovered')
  assert.equal(batches.filter(batch => batch.recoveryOf === 'normalize-1').length, 2)
  assert.equal(batches.filter(batch => batch.status === 'completed' && batch.recoveryOf).length, 4)
})

test('one bad quote saves valid books and retries only the affected member within concurrency', async t => {
  let active = 0, peak = 0
  const fixture = await fixtureFor(t, { count: 3, tracing: true, config: { concurrency: 1, maxRequests: 1 },
    analyze: async ({ payload }) => {
      active++; peak = Math.max(peak, active)
      try {
        await delay(2)
        const response = responseFor(payload)
        if (payload.task === 'normalize' && payload.books.length > 1) {
          response.value.books.find(book => book.id === 'b').evidenceRefs[0].quote = 'rewritten unsupported evidence'
        }
        return response
      } finally { active-- }
    } })
  const state = await run(fixture.service, { task: 'discovery' })
  const normalization = fixture.calls.filter(call => call.payload.task === 'normalize')
  assert.deepEqual(normalization.map(call => call.payload.books.map(book => book.id)), [['a', 'b', 'c'], ['b']])
  assert.match(normalization[1].systemPrompt, /Evidence repair/)
  assert.equal(state.normalizationSaved, 3)
  assert.equal(state.normalizationFirstPassSaved, 2)
  assert.equal(state.normalizationRetrySaved, 1)
  assert.equal(state.normalizationRetryPending, 0)
  assert.equal(state.normalizationSubmitted, 3, 'Retries do not inflate unique submitted books')
  assert.equal(state.normalizationMissing, 0)
  assert.equal(state.normalizationFailedBooks, 0)
  assert.equal(state.partial, false)
  assert.equal(peak, 1)
  const { batches } = await fixture.traceStore.snapshot({ runId: state.runId })
  const parent = batches.find(batch => batch.batchId === 'normalize-1')
  assert.equal(parent.savedCount, 2)
  assert.equal(parent.validatedCount, 2)
  assert.equal(parent.recoveryParts, 1)
  assert.equal(parent.status, 'recovered')
  assert.equal(parent.recoverySavedCount, 1)
  assert.equal(parent.effectiveSavedCount, 3)
  assert.equal(parent.unresolvedCount, 0)
  assert.equal(parent.errorCode, 'AI_RESULT_INVALID', 'The original request diagnostic remains available')
  const boundary = fixture.calls.length
  const next = await run(fixture.service, { task: 'discovery' })
  assert.equal(next.normalizationCached, 3)
  assert.equal(fixture.calls.length, boundary)
})

test('evidence validation failures split batches and use the repair prompt', async t => {
  const fixture = await fixtureFor(t, { count: 4, tracing: true, config: { normalizationBatchSize: 4, concurrency: 1 },
    analyze: ({ payload }) => {
      if (payload.task === 'normalize' && payload.books.length > 1) {
        throw Object.assign(new Error('evidence mismatch'), {
          code: 'AI_RESULT_INVALID', validation: { reason: 'EVIDENCE_MISMATCH', path: 'books[0].evidenceRefs[0].quote', bookId: payload.books[0].id }
        })
      }
      return responseFor(payload)
    } })
  const state = await run(fixture.service, { task: 'discovery' })
  const normalizeCalls = fixture.calls.filter(call => call.payload.task === 'normalize')
  assert.deepEqual(normalizeCalls.map(call => call.payload.books.length).slice(0, 7), [4, 2, 1, 1, 2, 1, 1])
  assert.ok(normalizeCalls.slice(1).every(call => call.systemPrompt.includes('Evidence repair')))
  assert.equal(state.normalizationSaved, 4)
  assert.equal(state.normalizationFailedBooks, 0)
  const { batches } = await fixture.traceStore.snapshot({ runId: state.runId })
  assert.equal(batches.find(batch => batch.batchId === 'normalize-1').recoveryReason, 'EVIDENCE_MISMATCH')
  assert.equal(batches.filter(batch => batch.status === 'completed' && batch.recoveryOf).length, 4)
})

test('length truncation splits down to individual books without exceeding concurrency or discarding cached work', async t => {
  let active=0,peak=0
  const fixture=await fixtureFor(t,{count:10,tracing:true,config:{normalizationBatchSize:10,concurrency:1,
    compatibleThinkingMode:'disabled',compatibleMaxOutputTokens:32768},analyze:async({payload})=>{
    active++;peak=Math.max(peak,active)
    try{
      await delay(1)
      if(payload.task==='normalize'&&payload.books.length>1)throw Object.assign(new Error('length'),{code:'AI_RESPONSE_TRUNCATED',truncationReason:'length',finishReason:'length'})
      return responseFor(payload)
    }finally{active--}
  }})
  const state=await run(fixture.service,{task:'discovery'})
  const calls=fixture.calls.filter(call=>call.payload.task==='normalize')
  assert.equal(calls.length,19)
  assert.deepEqual(calls.slice(0,5).map(call=>call.payload.books.length),[10,5,3,2,1])
  assert.ok(calls.every(call=>call.config.concurrency===1&&call.config.normalizationBatchSize===10&&call.config.compatibleMaxOutputTokens===32768))
  assert.equal(peak,1)
  assert.equal(state.normalizationSaved,10)
  assert.equal(state.normalizationRetrySaved,10)
  assert.equal(state.normalizationRetryPending,0)
  assert.equal(state.partial,false)
  const {batches}=await fixture.traceStore.snapshot({runId:state.runId})
  const parent=batches.find(batch=>batch.batchId==='normalize-1')
  assert.equal(parent.status,'recovered')
  assert.deepEqual(parent.recoverySizes,[5,5])
  assert.equal(parent.effectiveSavedCount,10)
  assert.ok(batches.some(batch=>batch.recoveryDepth===4))
  const boundary=fixture.calls.length
  Object.assign(fixture.config,{compatibleThinkingMode:'enabled',compatibleReasoningEffort:'high',compatibleMaxOutputTokens:65536})
  const next=await run(fixture.service,{task:'discovery'})
  assert.equal(next.normalizationCached,10)
  assert.equal(fixture.calls.length,boundary,'Reasoning and output settings do not invalidate valid cached results')
})

test('single-book length failures stay unresolved and a later run uses the successful neighbors cache', async t => {
  let broken=true
  const fixture=await fixtureFor(t,{count:3,config:{normalizationBatchSize:3,concurrency:1},analyze:({payload})=>{
    if(broken&&payload.task==='normalize'&&payload.books.some(book=>book.id==='b'))throw Object.assign(new Error('length'),{code:'AI_RESPONSE_TRUNCATED',truncationReason:'length',finishReason:'length'})
    return responseFor(payload)
  }})
  const first=await run(fixture.service,{task:'discovery'})
  assert.equal(first.normalizationSaved,2)
  assert.equal(first.normalizationFailedBooks,1)
  assert.equal(first.normalizationRetryPending,0)
  assert.equal(first.error,'AI_SINGLE_BOOK_TRUNCATED')
  assert.equal(first.partial,true)
  assert.equal(first.classificationSucceeded,0)
  const boundary=fixture.calls.length
  broken=false
  const next=await run(fixture.service,{task:'discovery'})
  assert.equal(next.normalizationCached,2)
  assert.deepEqual(fixture.calls.slice(boundary).filter(call=>call.payload.task==='normalize').map(call=>call.payload.books.map(book=>book.id)),[['b']])
})

test('incomplete streams are not length-split and cancellation stops pending recovery children', async t => {
  const incomplete=await fixtureFor(t,{count:3,analyze:()=>{throw Object.assign(new Error('stream ended'),{code:'AI_RESPONSE_TRUNCATED',truncationReason:'stream_incomplete'})}})
  await run(incomplete.service,{task:'discovery'})
  assert.equal(incomplete.calls.length,1)
  const started=deferred()
  const fixture=await fixtureFor(t,{count:10,config:{normalizationBatchSize:10,concurrency:1},analyze:({payload,signal})=>{
    if(payload.books.length===10)throw Object.assign(new Error('length'),{code:'AI_RESPONSE_TRUNCATED',truncationReason:'length'})
    started.resolve()
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{code:'AI_CANCELLED'})),{once:true}))
  }})
  await fixture.service.start({task:'discovery'})
  await started.promise
  fixture.service.cancel()
  await fixture.service.activePromise
  assert.equal(fixture.calls.length,2)
  assert.equal(fixture.service.getState().status,'cancelled')
})

test('a rejected reasoning or output parameter stops dispatch instead of repeating an invalid configuration', async t => {
  const fixture=await fixtureFor(t,{count:3,config:{normalizationBatchSize:1,concurrency:1},analyze:()=>{
    throw Object.assign(new Error('thinking rejected'),{code:'AI_REQUEST_OPTIONS_UNSUPPORTED',requestParameter:'thinking'})
  }})
  const state=await run(fixture.service,{task:'discovery'})
  assert.equal(state.status,'failed')
  assert.equal(state.error,'AI_REQUEST_OPTIONS_UNSUPPORTED')
  assert.equal(fixture.calls.length,1)
})

test('a malformed member field does not discard valid neighbors or retry their books', async t => {
  const fixture = await fixtureFor(t, { count: 3, tracing: true, analyze: ({ payload }) => {
    const response = responseFor(payload)
    if (payload.task === 'normalize' && payload.books.length > 1) response.value.books[1].chapter = { start: 'three', end: null }
    return response
  } })
  const state = await run(fixture.service, { task: 'discovery' })
  assert.deepEqual(fixture.calls.filter(call => call.payload.task === 'normalize').map(call => call.payload.books.map(book => book.id)), [['a', 'b', 'c'], ['b']])
  assert.equal(state.normalizationFirstPassSaved, 2)
  assert.equal(state.normalizationRetrySaved, 1)
  assert.equal(state.partial, false)
  const { batches } = await fixture.traceStore.snapshot({ runId: state.runId })
  assert.equal(batches.find(batch => batch.batchId === 'normalize-1').status, 'recovered')
})

test('batch cache-write failures retain actual saved members and report a storage failure', async t => {
  const original=AuditCache.prototype.putAiResult
  t.mock.method(AuditCache.prototype,'putAiResult',async function(key,value){
    if((value.value || value).id==='b') throw Object.assign(new Error('fixture write failure'),{code:'SQLITE_FULL'})
    return original.call(this,key,value)
  })
  const fixture=await fixtureFor(t,{count:3,tracing:true})
  const state=await run(fixture.service,{task:'discovery'})
  const {batches}=await fixture.traceStore.snapshot({runId:state.runId})
  const batch=batches.find(batch=>batch.phase==='normalizing')
  assert.equal(batch.returnedCount,3)
  assert.equal(batch.validatedCount,3)
  assert.equal(batch.savedCount,1)
  assert.equal(batch.failedCount,2)
  assert.equal(batch.errorCode,'AI_SAVE_FAILED')
  assert.equal(state.normalizationSaved,1)
  assert.equal(state.normalizationFailedBooks,2)
})

test('an omitted pair is counted as missing and never cached as a successful AI conclusion', async t => {
  let omit=true
  const fixture=await fixtureFor(t,{count:2,tracing:true,analyze:({payload})=>{
    const response=responseFor(payload)
    if(payload.task!=='normalize'&&omit)response.value.relations=[]
    return response
  }})
  const first=await run(fixture.service,{task:'discovery'})
  assert.equal(first.classificationSucceeded,0)
  assert.equal(first.classificationMissing,1)
  assert.equal(first.partial,true)
  const snapshot=await fixture.traceStore.snapshot({runId:first.runId})
  const batch=snapshot.batches.find(batch=>batch.phase==='classifying')
  assert.equal(batch.returnedCount,0)
  assert.equal(batch.validatedCount,0)
  assert.equal(batch.savedCount,0)
  assert.equal(batch.missingCount,1)
  assert.equal(batch.status,'partial')
  const boundary=fixture.calls.length
  omit=false
  const second=await run(fixture.service,{task:'discovery'})
  assert.equal(second.classificationSucceeded,1)
  assert.equal(fixture.calls.length-boundary,1)
})

test('AI discovery reuses each unchanged book semantic cache and reprocesses only a changed book', async t => {
  const fixture = await fixtureFor(t, { count: 3 })
  await run(fixture.service, { task: 'discovery' })
  const boundary = fixture.calls.length
  const first = (await fixture.loadBooks())[0]
  await fixture.Metadata.update({ title: 'Changed fixture title' }, { where: { hash: first.hash } })
  const state = await run(fixture.service, { task: 'discovery' })
  assert.equal(state.status, 'completed')
  const normalizationCalls = fixture.calls.slice(boundary).filter(call => call.payload.task === 'normalize')
  assert.equal(normalizationCalls.length, 1)
  assert.deepEqual(normalizationCalls[0].payload.books.map(book => book.id), [first.id])
})

test('AI discovery reuses unchanged single-book semantics across providers and models', async t => {
  const fixture = await fixtureFor(t, { count: 2, config: {
    chatgptJsonModel: 'json-model', chatgptAccountModel: 'account-model'
  } })
  await run(fixture.service, { task: 'discovery' })
  const boundary = fixture.calls.length
  fixture.config.provider = 'chatgpt-json'
  fixture.config.chatgptJsonModel = 'another-json-model'
  fixture.config.chatgptJsonReasoningEffort = 'max'
  const second = await run(fixture.service, { task: 'discovery' })
  const newCalls = fixture.calls.slice(boundary)
  assert.equal(second.normalizationCached, 2)
  assert.equal(newCalls.filter(call => call.payload.task === 'normalize').length, 0)
  assert.equal(newCalls.filter(call => call.payload.task === 'dedupe').length, 1,
    'Pair conclusions remain transport-specific while single-book semantics are reused')
  assert.equal(second.normalizationMigrated, 0)
})

test('AI discovery migrates legacy model-bound single-book cache entries', async t => {
  const fixture = await fixtureFor(t, { count: 2 })
  await run(fixture.service, { task: 'discovery' })
  const books = await fixture.loadBooks()
  const manifestFiles = await fs.readdir(path.join(fixture.root, 'audit', 'ai', 'runs'))
  const manifest = JSON.parse(await fs.readFile(path.join(fixture.root, 'audit', 'ai', 'runs', manifestFiles[0]), 'utf8'))
  const canonicalKey = stableId('ai-semantic-v4', bookSnapshotKey(books[0]), AI_PROMPT_VERSION)
  const legacyKey = stableId('ai-semantic-v2', manifest.profile, bookSnapshotKey(books[0]), AI_PROMPT_VERSION)
  const cache = await AuditCache.open(path.join(fixture.root, 'audit'))
  const canonical = await cache.getAiResult(canonicalKey)
  await cache.db.run('DELETE FROM ai_results WHERE fingerprint = ?', canonicalKey)
  await cache.putAiResult(legacyKey, canonical.value)
  await cache.db?.close?.()
  fixture.config.provider = 'chatgpt-json'
  fixture.config.chatgptJsonModel = 'migrated-model'
  const boundary = fixture.calls.length
  const state = await run(fixture.service, { task: 'discovery' })
  assert.equal(state.normalizationMigrated, 1)
  const normalizeCalls = fixture.calls.slice(boundary).filter(call => call.payload.task === 'normalize')
  assert.equal(normalizeCalls.length, 0)
})

test('unchanged books reuse old single-book caches after the local coverage parser changes', async t => {
  const fixture = await fixtureFor(t, { count: 2 })
  await run(fixture.service, { task: 'discovery' })
  const books = await fixture.loadBooks()
  const canonicalKey = stableId('ai-semantic-v4', bookSnapshotKey(books[0]), AI_PROMPT_VERSION)
  const previousKey = stableId('ai-semantic-v3', legacyBookSnapshotKey(books[0]), AI_PROMPT_VERSION, 3)
  const cache = await AuditCache.open(path.join(fixture.root, 'audit'))
  const saved = await cache.getAiResult(canonicalKey)
  assert.ok(saved)
  await cache.putAiResult(previousKey, saved)
  await cache.db.run('DELETE FROM ai_results WHERE fingerprint = ?', canonicalKey)
  await cache.db.close()
  const boundary = fixture.calls.length
  const state = await run(fixture.service, { task: 'discovery' })
  assert.equal(state.normalizationMigrated, 1)
  assert.equal(fixture.calls.slice(boundary).filter(call => call.payload.task === 'normalize').length, 0)
})

test('AI discovery state exposes cache, candidate and relationship counts for audit progress', async t => {
  const fixture = await fixtureFor(t, { count: 3 })
  const first = await run(fixture.service, { task: 'discovery' })
  const normalizeCall = fixture.calls.find(call => call.payload.task === 'normalize')
  const classifyCall = fixture.calls.find(call => call.payload.task === 'dedupe')
  assert.ok(normalizeCall.systemPrompt.includes('TASK normalize'))
  assert.ok(classifyCall.systemPrompt.includes('TASK dedupe or series'))
  assert.notEqual(normalizeCall.systemPrompt, classifyCall.systemPrompt)
  assert.equal(first.normalizationCached, 0)
  assert.equal(first.normalizationSucceeded, 3)
  assert.equal(first.candidateCount, 3)
  assert.equal(first.classificationSucceeded, 3)
  assert.equal(first.classificationCached, 0)
  assert.equal(first.relationCounts.same_work_same_part, 3)
  assert.equal(first.relationCounts.same_series_different_part, 0)

  const second = await run(fixture.service, { task: 'discovery' })
  assert.equal(second.normalizationCached, 3)
  assert.equal(second.classificationCached, 3)
  assert.equal(second.candidateCount, 3)
  assert.equal(second.relationCounts.same_work_same_part, 3)
})

test('library discovery joins supported work aliases across normalization batches and reuses both caches', async t => {
  const titles = ['[Creator] 潮影 第3話', ...Array.from({ length: 7 }, (_, index) => `独立作品${String.fromCharCode(65 + index)}`),
    '[Creator] Tide Shadow Ch.3 | 潮影 第3话']
  const fixture = await fixtureFor(t, { count: 9, titles, analyze: ({ payload }) => {
    const response = responseFor(payload)
    if (payload.task === 'normalize') {
      for (const item of response.value.books) {
        const input = payload.books.find(book => book.id === item.id)
        Object.assign(item, { workTitle: ['a', 'i'].includes(item.id) ? '潮影' : input.title,
          titleAliases: ['a', 'i'].includes(item.id) ? ['潮影'] : [input.title], chapter: input.chapter })
      }
    }
    return response
  } })
  const first = await run(fixture.service, { task: 'discovery' })
  const normalization = fixture.calls.filter(call => call.payload.task === 'normalize')
  assert.deepEqual(normalization.map(call => call.payload.books.length), [8, 1])
  assert.ok(normalization.every(call => !call.systemPrompt.includes('TASK dedupe or series')))
  const classification = fixture.calls.filter(call => call.payload.task === 'dedupe')
  assert.equal(classification.length, 1)
  assert.deepEqual(classification[0].payload.pairs.map(({ leftId, rightId }) => [leftId, rightId]), [['a', 'i']])
  assert.ok(!classification[0].systemPrompt.includes('TASK normalize'))
  assert.equal(first.normalizationSucceeded, 9)
  assert.deepEqual(await fixture.service.getValidCandidatePairs({ runId: first.runId }), [{ leftId: 'a', rightId: 'i' }])

  const callCount = fixture.calls.length
  const second = await run(fixture.service, { task: 'discovery' })
  assert.equal(fixture.calls.length, callCount, 'Unchanged books and pair do not call the upstream again')
  assert.equal(second.normalizationCached, 9)
  assert.equal(second.classificationCached, 1)
})

test('AI dedupe persists pair advice, reuses cached requests, and restores it after restart', async t => {
  const fixture = await fixtureFor(t)
  const first = await run(fixture.service)
  assert.equal(first.status, 'completed')
  assert.equal(first.partial, false)
  assert.equal(fixture.calls.length, 3)
  let results = await fixture.service.getResults({ task: 'dedupe', reportId: fixture.report.reportId })
  assert.equal(results.length, 3)
  assert.ok(results.every(result => !result.stale && result.status === 'completed'))
  assert.deepEqual(results.map(result => result.relations.length), [1, 1, 1])
  const second = await run(fixture.service)
  assert.equal(second.cached, 3)
  assert.equal(second.requests, 0)
  assert.equal(second.partial, false)
  assert.equal(fixture.calls.length, 3)
  const reopened = new AiReviewService(fixture.options)
  await reopened.initialize()
  results = await reopened.getResults({ task: 'dedupe' })
  assert.equal(results.length, 3)
  assert.ok(results.every(result => result.fromCache && !result.stale))
  assert.equal(fixture.coordinator.getState().auditRunning, false)
})

test('AI dedupe advice is bound to report, evidence revision, metadata, and current files', async t => {
  const fixture = await fixtureFor(t, { count: 2 })
  await run(fixture.service)
  const isStale = async () => (await fixture.service.getResults({ task: 'dedupe' }))[0].stale
  assert.equal(await isStale(), false)
  fixture.report.groups[0].evidenceRevision = 'revision-2'
  assert.equal(await isStale(), true)
  fixture.report.groups[0].evidenceRevision = 'revision-1'
  fixture.report.reportId = 'another-report'
  assert.equal(await isStale(), true)
  fixture.report.reportId = 'fixture-report'
  fixture.report.stale = true
  assert.equal(await isStale(), true)
  fixture.report.stale = false
  const book = (await fixture.loadBooks())[0]
  await fixture.Metadata.update({ title: 'Changed title' }, { where: { hash: book.hash } })
  assert.equal(await isStale(), true)
  await fixture.Metadata.update({ title: book.title }, { where: { hash: book.hash } })
  assert.equal(await isStale(), false)
  await fs.appendFile(book.filepath, 'changed bytes')
  assert.equal(await isStale(), true)
})

test('AI cache separates service types and selected ChatGPT models while preserving the API model', async t => {
  const fixture = await fixtureFor(t, { count: 2, config: {
    chatgptJsonModel: 'json-model', chatgptAccountModel: 'account-model'
  } })
  assert.equal((await run(fixture.service)).requests, 1)
  assert.equal((await run(fixture.service)).cached, 1)
  fixture.config.provider = 'chatgpt-json'
  assert.equal((await run(fixture.service)).requests, 1, 'A different transport does not reuse compatible-API results')
  assert.equal((await run(fixture.service)).cached, 1)
  fixture.config.chatgptJsonModel = 'another-json-model'
  assert.equal((await run(fixture.service)).requests, 1, 'The selected JSON model participates in the cache profile')
  fixture.config.chatgptJsonReasoningEffort = 'max'
  assert.equal((await run(fixture.service)).requests, 1, 'Changing reasoning effort requests a fresh analysis')
  assert.equal((await run(fixture.service)).cached, 1)
  fixture.config.chatgptJsonReasoningEffort = 'medium'
  assert.equal((await run(fixture.service)).cached, 1, 'Returning to the original effort reuses its matching result')
  fixture.config.provider = 'chatgpt-account'
  assert.equal((await run(fixture.service)).requests, 1)
  fixture.config.chatgptAccountModel = 'another-account-model'
  assert.equal((await run(fixture.service)).requests, 1, 'The selected account model participates in the cache profile')
  assert.equal(fixture.config.model, 'test-model', 'Resolving ChatGPT must preserve the saved compatible-API model')
  fixture.config.provider = 'compatible'
  assert.equal((await run(fixture.service)).cached, 1, 'Returning to the original API reuses its matching result')
})

test('AI analysis captures its selected provider and models for the entire run', async t => {
  const started = deferred(), release = deferred()
  const fixture = await fixtureFor(t, { config: { provider: 'chatgpt-json', chatgptJsonModel: 'captured-model', concurrency: 1 },
    analyze: async (options, count) => {
      if (count === 1) { started.resolve(); await release.promise }
      return responseFor(options.payload)
    } })
  await fixture.service.start({ task: 'dedupe', reportId: fixture.report.reportId })
  await started.promise
  fixture.config.provider = 'chatgpt-account'
  fixture.config.chatgptJsonModel = 'changed-model'
  fixture.config.chatgptAccountModel = 'new-account-model'
  release.resolve()
  await fixture.service.activePromise
  assert.equal(fixture.service.getState().status, 'completed')
  assert.equal(fixture.calls.length, 3)
  assert.ok(fixture.calls.every(call => call.config.provider === 'chatgpt-json' && call.config.chatgptJsonModel === 'captured-model'))
})

test('AI refuses a stale report before sending any upstream request', async t => {
  const fixture = await fixtureFor(t, { count: 2 })
  await fixture.Metadata.update({ title: 'Changed before analysis' }, { where: { hash: 'sample-a' } })
  const state = await run(fixture.service)
  assert.equal(state.status, 'failed')
  assert.equal(state.error, 'AI_REPORT_STALE')
  assert.equal(fixture.calls.length, 0)
  assert.deepEqual(await fixture.service.getResults(), [])
})

test('legacy request budgets do not truncate classification and completed pairs stay cached', async t => {
  const fixture = await fixtureFor(t, { config: { maxRequests: 1, concurrency: 3 } })
  const first = await run(fixture.service)
  assert.equal(first.requests, 3)
  assert.equal(first.completed, 3)
  assert.equal(first.limited, false)
  assert.equal(first.partial, false)
  const second = await run(fixture.service)
  assert.equal(second.requests, 0)
  assert.equal(second.cached, 3)
  assert.equal(second.completed, 3)
  assert.equal(second.partial, false)
  const third = await run(fixture.service)
  assert.equal(third.requests, 0)
  assert.equal(third.cached, 3)
  assert.equal(third.completed, 3)
  assert.equal(third.partial, false)
  const fourth = await run(fixture.service)
  assert.equal(fourth.requests, 0)
  assert.equal(fourth.cached, 3)
  assert.equal(fourth.partial, false)
  assert.equal((await fixture.service.getResults()).length, 3)
  assert.equal(fixture.calls.length, 3)
})

test('AI failed results are visible and are retried rather than cached as success', async t => {
  let shouldFail = true
  const fixture = await fixtureFor(t, { count: 2, analyze: options => {
    if (shouldFail) throw Object.assign(new Error('private upstream body'), { code: 'AI_NETWORK_ERROR' })
    return responseFor(options.payload)
  } })
  const failed = await run(fixture.service)
  assert.equal(failed.failed, 1)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.partial, false)
  const [result] = await fixture.service.getResults()
  assert.equal(result.status, 'failed')
  assert.equal(result.error, 'AI_NETWORK_ERROR')
  assert.equal(result.relations.length, 0)
  shouldFail = false
  const recovered = await run(fixture.service)
  assert.equal(recovered.requests, 1)
  assert.equal(recovered.cached, 0)
  assert.equal((await fixture.service.getResults())[0].status, 'completed')
})

test('classification validation reasons persist across restart and clear after a successful retry', async t => {
  let shouldFail = true
  const fixture = await fixtureFor(t, { count: 2, analyze: ({ payload }) => {
    const response = responseFor(payload)
    if (shouldFail) {
      response.value.relations[0].relation = 'private-relation'
    }
    return response
  } })
  const failed = await run(fixture.service)
  const [record] = await fixture.service.getResults()
  const detail = { reason: 'INVALID_VALUE', path: 'relations[0].relation' }
  assert.equal(record.error, 'AI_RESULT_INVALID')
  assert.deepEqual(record.errorDetail, detail)
  assert.deepEqual(failed.errorDetail, detail)
  assert.equal(failed.classificationSucceeded, 0)
  assert.equal(failed.failed, 1)
  const saved = await fs.readFile(path.join(fixture.root, 'audit', 'ai', 'results.json'), 'utf8')
  assert.ok(!saved.includes('private-relation'))
  const reopened = new AiReviewService(fixture.options)
  await reopened.initialize()
  assert.deepEqual((await reopened.getResults())[0].errorDetail, detail)
  assert.deepEqual(reopened.getState().errorDetail, detail)
  await run(fixture.service)
  assert.equal(fixture.calls.length, 2, 'Failed validation does not populate the success cache')
  shouldFail = false
  const recovered = await run(fixture.service)
  assert.equal(recovered.requests, 1)
  assert.equal(recovered.errorDetail, null)
  assert.equal((await fixture.service.getResults())[0].errorDetail, undefined)
  assert.equal((await run(fixture.service)).cached, 1)
})

test('failure diagnostics publish only controlled reasons, field paths and known members', async t => {
  const fixture = await fixtureFor(t, { count: 2, analyze: () => {
    throw Object.assign(new Error('private upstream response'), { code: 'AI_RESULT_INVALID',
      validation: { reason: 'INVALID_VALUE', path: 'private/path/token', bookId: 'private-token', raw: 'private-upstream' } })
  } })
  const state = await run(fixture.service)
  assert.deepEqual(state.errorDetail, { reason: 'INVALID_VALUE' })
  const [record] = await fixture.service.getResults()
  assert.deepEqual(record.errorDetail, { reason: 'INVALID_VALUE' })
  assert.ok(!JSON.stringify(record).includes('private'))
})

test('AI cancellation retains the library lock until all concurrent calls settle', async t => {
  const bothStarted = deferred(), delayedCall = deferred()
  let activeCalls = 0
  const fixture = await fixtureFor(t, { config: { concurrency: 2 }, analyze: async (options, count) => {
    activeCalls++
    if (activeCalls === 2) bothStarted.resolve()
    try {
      if (count === 1) {
        await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'AI_CANCELLED' })), { once: true }))
      } else await delayedCall.promise
      return responseFor(options.payload)
    } finally { activeCalls-- }
  } })
  await fixture.service.start({ task: 'dedupe', reportId: 'fixture-report' })
  const job = fixture.service.activePromise
  await bothStarted.promise
  fixture.service.cancel()
  const earlyOutcome = await Promise.race([job.then(() => 'completed'), delay(40).then(() => 'waiting')])
  const retainedLock = fixture.coordinator.getState().auditRunning
  delayedCall.resolve()
  await job
  await delay(10)
  assert.equal(earlyOutcome, 'waiting', 'a cancelled job must not finish while another call is still active')
  assert.equal(retainedLock, true)
  assert.equal(activeCalls, 0)
  assert.equal(fixture.service.getState().status, 'cancelled')
  assert.equal(fixture.coordinator.getState().auditRunning, false)
})

test('AI discovery exports only fresh same-work advice from all six relationship types', async t => {
  const relationTypes = { ab: 'unknown', ac: 'same_series_different_part', ad: 'same_publication_different_issue',
    bc: 'same_work_same_part', bd: 'same_work_different_edition', cd: 'unrelated' }
  const fixture = await fixtureFor(t, { count: 4, analyze: options => {
    const key = options.payload.pairs.map(pair => [pair.leftId, pair.rightId].sort().join('')).join()
    return responseFor(options.payload, relationTypes[key] || 'unknown')
  } })
  const state = await run(fixture.service, { task: 'discovery' })
  const results = await fixture.service.getResults({ task: 'discovery' })
  assert.equal(results.length, 6)
  const byRelation = new Map(results.map(result => [result.relations[0].relation, result]))
  for (const type of ['unknown', 'same_series_different_part', 'same_publication_different_issue', 'unrelated']) {
    await assert.rejects(fixture.service.getCandidatePairs([byRelation.get(type).id]), /AI_CANDIDATES_MISSING/)
  }
  assert.deepEqual(await fixture.service.getValidCandidatePairs({ runId: state.runId }), [
    { leftId: 'b', rightId: 'c' }, { leftId: 'b', rightId: 'd' }
  ])
  const sameWork = byRelation.get('same_work_same_part')
  assert.deepEqual(await fixture.service.getCandidatePairs([sameWork.id]), [{ leftId: 'b', rightId: 'c' }])
  await fixture.Metadata.update({ title: 'Evidence changed after discovery' }, { where: { hash: 'sample-b' } })
  await assert.rejects(fixture.service.getCandidatePairs([sameWork.id]), /AI_RESULT_STALE/)
  await assert.rejects(fixture.service.getCandidatePairs(['nonexistent']), /AI_RESULT_STALE/)
})

test('AI does not submit series report results into duplicate discovery', async t => {
  const fixture = await fixtureFor(t, { count: 2, analyze: options => responseFor(options.payload, 'same_series_different_part') })
  await run(fixture.service, { task: 'series' })
  const results = await fixture.service.getResults({ task: 'series' })
  assert.equal(results.length, 1)
  assert.equal(results[0].series.groups.length, 1)
  await assert.rejects(fixture.service.getCandidatePairs([results[0].id]), /AI_RESULT_STALE/)
})

test('series reports consume the final classification semantics rather than earlier normalization hints', async t => {
  const fixture = await fixtureFor(t, { count: 2, analyze: ({ payload }) => {
    const response = responseFor(payload, 'same_series_different_part')
    if (payload.task === 'normalize') for (const book of response.value.books) Object.assign(book, {
      seriesTitle: '潮影', chapter: { start: book.id === 'a' ? 5 : 4, end: null }
    })
    return response
  } })
  assert.equal((await run(fixture.service, { task: 'series' })).status, 'completed')
  const [result] = await fixture.service.getResults({ task: 'series' })
  assert.equal(result.series.groups[0].title, '潮影')
  assert.deepEqual(result.series.groups[0].members.map(book => book.id), ['b', 'a'])
  assert.deepEqual(result.series.groups[0].members.map(book => book.aiSemantic.chapter.start), [4, 5])
})

test('book parsing batch size and concurrency are independent and preserve per-book caches', async t => {
  const firstWave = deferred(), release = deferred()
  let active = 0, peak = 0, taskSignal
  const events = []
  const warnings = []
  const onWarning = warning => { if (warning.name === 'MaxListenersExceededWarning' && warning.target === taskSignal) warnings.push(warning) }
  process.on('warning', onWarning)
  t.after(() => process.removeListener('warning', onWarning))
  const transport = createAiService({ logger: () => {}, fetchImpl: async (_url, { body }) => {
    const payload = JSON.parse(JSON.parse(body).messages.at(-1).content)
    assert.equal(payload.task, 'normalize')
    active++; peak = Math.max(peak, active)
    if (active === 25) firstWave.resolve()
    try {
      await release.promise
      const result = responseFor(payload)
      for (const book of result.value.books) book.workTitle = payload.books.find(input => input.id === book.id).title
      return new Response(Readable.from([JSON.stringify({ choices: [{ message: { content: JSON.stringify(result.value) } }] })]), { status: 200 })
    } finally { active-- }
  } })
  const fixture = await fixtureFor(t, { count: 51, titles: Array.from({ length: 51 }, (_, index) => `Distinct work token${index.toString(36)}ending`),
    config: { normalizationBatchSize: 2, concurrency: 25, maxRequests: 100 }, logger: (event, details) => events.push({ event, ...details }),
    analyze: options => { taskSignal = options.signal; return transport.analyze(options) } })
  await fixture.service.start({ task: 'discovery' })
  let timer
  try {
    await Promise.race([firstWave.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Parsing did not reach 25 concurrent requests')), 5000) })])
    assert.equal(active, 25)
    assert.equal(getMaxListeners(taskSignal), 25)
    assert.equal(getEventListeners(taskSignal, 'abort').length, 25)
    assert.equal(fixture.calls.length, 25)
    assert.ok(fixture.calls.every(call => call.payload.books.length === 2))
    fixture.config.normalizationBatchSize = 3
    fixture.config.concurrency = 2
    fixture.config.stream = true
  } finally { clearTimeout(timer); release.resolve() }
  await fixture.service.activePromise
  const state = fixture.service.getState()
  assert.equal(state.status, 'completed', JSON.stringify({ state, events: events.slice(-5) }))
  assert.equal(state.normalizationSucceeded, 51)
  assert.equal(peak, 25)
  assert.equal(active, 0)
  assert.equal(getEventListeners(taskSignal, 'abort').length, 0, 'Completed requests remove their cancellation listeners')
  assert.deepEqual(warnings, [])
  assert.deepEqual(fixture.calls.map(call => call.payload.books.length).sort((a, b) => a - b), [1, ...Array(25).fill(2)])
  const start = events.find(record => record.event === 'task:start')
  assert.equal(start.normalizationBatchSize, 2)
  assert.equal(start.concurrency, 25)
  const boundary = fixture.calls.length
  const cached = await run(fixture.service, { task: 'discovery' })
  assert.equal(cached.normalizationCached, 51)
  assert.equal(fixture.calls.length, boundary, 'Changing scheduling must reuse unchanged book semantics')
})

test('full-library parsing and classification finish even with a legacy five-request setting', async t => {
  const fixture = await fixtureFor(t, { count: 10, config: { normalizationBatchSize: 1, concurrency: 25, maxRequests: 5 } })
  const state = await run(fixture.service, { task: 'discovery' })
  assert.equal(fixture.calls.filter(call => call.payload.task === 'normalize').length, 10)
  assert.equal(fixture.calls.filter(call => call.payload.task === 'dedupe').length, 45)
  assert.equal(state.requests, 55)
  assert.equal(state.normalizationSucceeded, 10)
  assert.equal(state.classificationSucceeded, 45)
  assert.equal(state.limited, false)
  assert.equal(state.partial, false)
})

test('cancelling parallel book parsing settles every in-flight request before finishing', async t => {
  const started = deferred()
  let active = 0, taskSignal
  const transport = createAiService({ logger: () => {}, fetchImpl: (_url, { signal }) => new Promise((_, reject) => {
    active++
    if (active === 25) started.resolve()
    signal.addEventListener('abort', () => { active--; reject(Object.assign(new Error('cancelled'), { code: 'AI_CANCELLED' })) }, { once: true })
  }) })
  const fixture = await fixtureFor(t, { count: 26, config: { normalizationBatchSize: 1, concurrency: 25, maxRequests: 100 },
    analyze: options => { taskSignal = options.signal; return transport.analyze(options) } })
  await fixture.service.start({ task: 'discovery' })
  await started.promise
  assert.equal(getEventListeners(taskSignal, 'abort').length, 25)
  fixture.service.cancel()
  await fixture.service.activePromise
  assert.equal(active, 0)
  assert.equal(fixture.calls.length, 25)
  assert.equal(getEventListeners(taskSignal, 'abort').length, 0, 'Cancelled requests remove their cancellation listeners')
  assert.equal(fixture.service.getState().status, 'cancelled')
  assert.equal(fixture.service.running, false)
})

test('parallel parsing stops new requests on authentication failure and waits for active requests', async t => {
  const started = deferred(), release = deferred(), fail = deferred()
  let active = 0
  const fixture = await fixtureFor(t, { count: 10, config: { normalizationBatchSize: 1, concurrency: 3 }, analyze: async ({ payload }, count) => {
    active++
    if (active === 3) started.resolve()
    try {
      await (count === 1 ? fail.promise : release.promise)
      if (count === 1) throw Object.assign(new Error('credentials rejected'), { code: 'AI_AUTH_FAILED' })
      return responseFor(payload)
    } finally { active-- }
  } })
  await fixture.service.start({ task: 'discovery' })
  try {
    await started.promise
    fail.resolve()
    await delay(10)
    assert.equal(fixture.service.running, true)
    assert.equal(active, 2)
  } finally { fail.resolve(); release.resolve() }
  await fixture.service.activePromise
  assert.equal(active, 0)
  assert.equal(fixture.calls.length, 3)
  assert.equal(fixture.service.getState().status, 'failed')
  assert.equal(fixture.service.getState().error, 'AI_AUTH_FAILED')
})

test('AI stops normalization on authentication failure without consuming the full budget', async t => {
  const fixture = await fixtureFor(t, { count: 10, config: { maxRequests: 10, concurrency: 1 }, analyze: () => {
    throw Object.assign(new Error('credentials rejected'), { code: 'AI_AUTH_FAILED' })
  } })
  const state = await run(fixture.service, { task: 'discovery' })
  assert.equal(fixture.calls.length, 1)
  assert.equal(state.status, 'failed')
  assert.equal(state.error, 'AI_AUTH_FAILED')
})

for (const code of ['AI_OAUTH_EXPIRED', 'AI_OAUTH_SCOPE_REQUIRED', 'AI_OAUTH_RELOGIN_REQUIRED', 'AI_REASONING_UNSUPPORTED', 'AI_PLAN_UNAVAILABLE', 'AI_RATE_LIMITED']) {
  test(`AI stops a ChatGPT batch on ${code} and preserves the safe failure`, async t => {
    const fixture = await fixtureFor(t, { count: 10, config: { maxRequests: 10, concurrency: 1 }, analyze: () => {
      throw Object.assign(new Error('private account details'), { code })
    } })
    for (const task of ['discovery', 'dedupe']) {
      const before = fixture.calls.length
      const state = await run(fixture.service, { task, ...(task === 'dedupe' ? { reportId: fixture.report.reportId } : {}) })
      assert.equal(fixture.calls.length - before, 1)
      assert.equal(state.status, 'failed')
      assert.equal(state.error, code)
      assert.ok(!JSON.stringify(state).includes('private account details'))
    }
  })
}

test('AI prepares all dedupe pairs beyond ten thousand and can cancel before dispatch', async t => {
  const fixture = await fixtureFor(t, { count: 145, config: { maxRequests: 1 } })
  let preparingResult
  fixture.service.on('state', state => {
    if (state.phase !== 'classifying' || preparingResult) return
    preparingResult = state
    fixture.service.cancel()
  })
  await run(fixture.service)
  assert.equal(preparingResult.total, 10440)
  assert.equal(preparingResult.candidateLimit, false)
  assert.equal(fixture.calls.length, 0)
})

test('AI full-library discovery classifies every candidate beyond the former ten-thousand limit', async t => {
  const fixture = await fixtureFor(t, { count: 145, config: { concurrency: 25, maxRequests: 5 }, logger: () => {} })
  // Exercise dispatch and result accounting without writing 10k fixture
  // snapshots. Persistence and cache replay have separate integration tests.
  t.mock.method(AuditCache.prototype, 'getAiResult', async () => null)
  t.mock.method(AuditCache.prototype, 'putAiResult', async () => {})
  t.mock.method(fixture.service, 'persist', async () => {})
  t.mock.method(fixture.service, 'persistRunManifest', async () => {})
  const state = await run(fixture.service, { task: 'discovery' })
  const classifications = fixture.calls.filter(call => call.payload.task === 'dedupe')
  assert.equal(state.status, 'completed')
  assert.equal(state.partial, false)
  assert.equal(state.classificationSucceeded, 10440)
  assert.equal(state.normalizationSucceeded, 145)
  assert.equal(state.requests, 10440 + 19)
  assert.equal(classifications.length, 10440)
  assert.equal(new Set(classifications.map(call => JSON.stringify(call.payload.pairs[0]))).size, 10440)
})

test('a malformed single-book request receives one repair attempt and reports recovery', async t => {
  let broken = true
  const fixture = await fixtureFor(t, { count: 1, tracing: true, analyze: ({ payload }) => {
    if (broken) { broken = false; throw Object.assign(new Error('bad JSON'), { code: 'AI_INVALID_JSON' }) }
    return responseFor(payload)
  } })
  const state = await run(fixture.service, { task: 'discovery' })
  assert.equal(fixture.calls.length, 2)
  assert.equal(state.normalizationRetrySaved, 1)
  assert.equal(state.normalizationRetryPending, 0)
  assert.equal(state.partial, false)
  const { batches } = await fixture.traceStore.snapshot({ runId: state.runId })
  assert.equal(batches.find(batch => !batch.recoveryOf).status, 'recovered')
})

test('explicit unknown semantics count as a valid book result and remain cached', async t => {
  const fixture = await fixtureFor(t, { count: 2, analyze: ({ payload }) => {
    const response = responseFor(payload, 'unknown')
    if (payload.task === 'normalize') for (const book of response.value.books) Object.assign(book, {
      workTitle: null, authors: [], titleAliases: [], evidenceRefs: [], uncertainties: ['原始资料不足，无法确定作品信息。']
    })
    return response
  } })
  const first = await run(fixture.service, { task: 'discovery' })
  assert.equal(first.normalizationSucceeded, 2)
  assert.equal(first.normalizationSaved, 2)
  assert.equal(first.partial, false)
  const boundary = fixture.calls.length
  const next = await run(fixture.service, { task: 'discovery' })
  assert.equal(next.normalizationCached, 2)
  assert.equal(next.requests, 0)
  assert.equal(fixture.calls.length, boundary)
})

test('unresolved book analysis remains incomplete and continuation only requests missing semantics', async t => {
  let broken = true
  const fixture = await fixtureFor(t, { count: 3, tracing: true, analyze: ({ payload }) => {
    const response = responseFor(payload)
    if (payload.task === 'normalize' && broken) response.value.books = response.value.books.filter(book => book.id !== 'b')
    return response
  } })
  const first = await run(fixture.service, { task: 'discovery' })
  assert.equal(first.partial, true)
  assert.equal(first.phase, 'normalizing')
  assert.equal(first.normalizationSaved, 2)
  assert.equal(first.normalizationMissing, 1)
  assert.equal(first.normalizationRetryPending, 0)
  assert.equal(first.classificationSucceeded, 0)
  const manifest = JSON.parse(await fs.readFile(path.join(fixture.root, 'audit', 'ai', 'runs', first.runId + '.json'), 'utf8'))
  assert.equal(manifest.status, 'partial')
  const boundary = fixture.calls.length
  broken = false
  const next = await run(fixture.service, { task: 'discovery' })
  assert.equal(next.normalizationCached, 2)
  assert.deepEqual(fixture.calls.slice(boundary).filter(call => call.payload.task === 'normalize').map(call => call.payload.books.map(book => book.id)), [['b']])
  assert.equal(next.partial, false)
})

test('AI discovery rejects persisted advice from older rules or prompts', async t => {
  const fixture = await fixtureFor(t, { count: 2 })
  await run(fixture.service, { task: 'discovery' })
  const filename = path.join(fixture.root, 'audit', 'ai', 'results.json')
  const original = JSON.parse(await fs.readFile(filename, 'utf8'))
  assert.equal(original.length, 1)
  for (const field of ['promptVersion', 'rulesVersion']) {
    const outdated = clone(original)
    outdated[0][field] = 0
    await fs.writeFile(filename, JSON.stringify(outdated))
    const reopened = new AiReviewService(fixture.options)
    await reopened.initialize()
    assert.equal((await reopened.getResults({ task: 'discovery' }))[0].stale, true)
    await assert.rejects(reopened.getCandidatePairs([outdated[0].id]), /AI_RESULT_STALE/)
  }
})

test('full-library analysis stops before candidates when book parsing fails', async t => {
  const fixture = await fixtureFor(t, { count: 2, analyze: options => {
    if (options.payload.task === 'normalize') throw Object.assign(new Error('temporarily unavailable'), { code: 'AI_NETWORK_ERROR' })
    return responseFor(options.payload)
  } })
  const state = await run(fixture.service, { task: 'discovery' })
  assert.equal(state.failed, 1)
  assert.equal(state.completed, 2)
  assert.equal(state.status, 'failed')
  assert.equal(state.phase, 'normalizing')
  assert.equal(fixture.calls.filter(call => call.payload.task === 'dedupe').length, 0)
  assert.deepEqual(await fixture.service.getResults({ task: 'discovery' }), [])
})

test('unfamiliar AI semantics survive normalization, candidate recall, classification and cache replay', async t => {
  const lines = []
  const titles = ['[作家] Tide 第三幕（蒼風季刊・春の別冊）', '[作家] 潮影 第三幕（蒼風季刊・春の別冊）']
  const publication = { kind: 'embedded', name: '蒼風季刊', issue: '春の別冊', date: null }
  const fixture = await fixtureFor(t, { count: 2, titles,
    logger: createAiLogger({ write: line => lines.push(line) }), analyze: ({ payload }) => {
      if (payload.task === 'dedupe') {
        assert.deepEqual(payload.books.map(book => book.aiHints.chapter), [{ start: 3, end: null }, { start: 3, end: null }])
        assert.ok(payload.books.every(book => JSON.stringify(book.aiHints.publication) === JSON.stringify(publication)))
        assert.deepEqual(payload.books.map(book => book.title), titles)
        assert.ok(payload.books.every(book => book.chapter === null), 'Original local fields remain distinct from AI interpretation')
      }
      const response = responseFor(payload)
      if (payload.task === 'normalize') for (const book of response.value.books) Object.assign(book, {
        workTitle: '潮影', chapter: { start: 3, end: null }, publication
      })
      return response
    } })
  const first = await run(fixture.service, { task: 'discovery' })
  assert.equal(first.status, 'completed')
  assert.equal(first.failed, 0)
  assert.equal(fixture.calls.length, 2)
  assert.deepEqual(fixture.calls.filter(call => call.payload.task === 'normalize').map(call => call.schema.required), [['books', 'relations']])
  assert.deepEqual(fixture.calls.filter(call => call.payload.task === 'dedupe').map(call => call.schema.required), [['relations']])
  const [result] = await fixture.service.getResults({ task: 'discovery' })
  assert.equal(result.status, 'completed')
  assert.ok(result.books.every(book => book.aiSemantic.chapter.start === 3))
  assert.deepEqual(result.books[0].aiSemantic.publication, publication)
  assert.deepEqual(await fixture.service.getCandidatePairs([result.id]), [{ leftId: 'a', rightId: 'b' }])
  const second = await run(fixture.service, { task: 'discovery' })
  assert.equal(second.requests, 0)
  assert.equal(second.cached, 3)
  assert.equal(fixture.calls.length, 2)
  const events = lines.map(line => ({ event: line.split(' ')[1], ...JSON.parse(line.slice(line.indexOf('{'))) }))
  for (const event of ['task:start', 'task:progress', 'cache:miss', 'cache:hit', 'result:validated', 'candidates:start', 'candidates:finish', 'task:finish']) {
    assert.ok(events.some(record => record.event === event), event)
  }
  assert.ok(events.some(record => record.event === 'task:progress' && record.phase === 'normalizing'))
  assert.ok(events.some(record => record.event === 'task:progress' && record.phase === 'classifying'))
  assert.ok(events.some(record => record.event === 'task:finish' && record.status === 'completed' && record.requestCount === 2))
  assert.ok(!lines.join('\n').includes(fixture.root))
  assert.ok(!lines.join('\n').includes('蒼風季刊'))
  assert.ok(!lines.join('\n').includes('潮影'))
})

test('review terminal diagnostics identify invalid fields without printing raw model content', async t => {
  const lines = []
  const fixture = await fixtureFor(t, { count: 2, logger: createAiLogger({ write: line => lines.push(line) }), analyze: ({ payload }) => {
    const response = responseFor(payload)
    response.value.relations[0].relation = 'private-relation'
    return response
  } })
  const state = await run(fixture.service)
  assert.equal(state.status, 'failed')
  const invalid = lines.find(line => line.startsWith('[AI] result:invalid '))
  assert.ok(invalid)
  const fields = JSON.parse(invalid.slice(invalid.indexOf('{')))
  assert.equal(fields.errorCode, 'AI_RESULT_INVALID')
  assert.equal(fields.validationReason, 'INVALID_VALUE')
  assert.equal(fields.fieldPath, 'relations[0].relation')
  assert.ok(lines.some(line => line.startsWith('[AI] task:finish ') && JSON.parse(line.slice(line.indexOf('{'))).failedCount === 1))
  assert.ok(!lines.join('\n').includes('private-relation'))
  assert.ok(!lines.join('\n').includes(fixture.root))
})

test('AI mixed classification outcomes are marked partial without discarding successful advice', async t => {
  const fixture = await fixtureFor(t, { analyze: (options, count) => {
    if (count === 1) throw Object.assign(new Error('one failed comparison'), { code: 'AI_NETWORK_ERROR' })
    return responseFor(options.payload)
  } })
  const state = await run(fixture.service)
  assert.equal(state.status, 'completed')
  assert.equal(state.partial, true)
  assert.equal(state.failed, 1)
  const results = await fixture.service.getResults({ task: 'dedupe' })
  assert.equal(results.filter(result => result.status === 'completed').length, 2)
  assert.equal(results.filter(result => result.status === 'failed').length, 1)
})

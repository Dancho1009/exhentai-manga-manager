const test = require('node:test')
const assert = require('node:assert/strict')
const { discoverAndQueue } = require('../modules/audit/ai_auto_queue.js')

const run = async ({ finalState = { status: 'completed', partial: false }, pairs = [{ leftId: 'a', rightId: 'b' }] } = {}) => {
  const calls = { start: [], wait: 0, pairArgs: [], dedupe: [] }
  const result = await discoverAndQueue({
    force: true,
    startDiscovery: async options => { calls.start.push(options); return { runId: 'discovery-run-1', status: 'running' } },
    waitForIdle: async () => { calls.wait++ },
    getState: async () => finalState,
    getValidCandidatePairs: async options => { calls.pairArgs.push(options); return pairs },
    startDedupe: async options => { calls.dedupe.push(options); return { status: 'running', activeTask: { type: 'dedupe' } } }
  })
  return { result, calls }
}

test('AI discovery submits only the current run and starts a full local queue build', async () => {
  const { result, calls } = await run()
  assert.deepEqual(calls.start, [{ task: 'discovery', force: true }])
  assert.equal(calls.wait, 1)
  assert.deepEqual(calls.pairArgs, [{ runId: 'discovery-run-1' }])
  assert.deepEqual(calls.dedupe, [{ scanMode: 'full', forceRecompute: true, semanticPairs: [{ leftId: 'a', rightId: 'b' }], coveragePairs: [], aiRunId: 'discovery-run-1', aiSource: 'ai-discovery', aiPartial: false }])
  assert.equal(result.pairCount, 1)
})

test('incomplete AI coverage never starts local verification or replaces the report', async () => {
  for (const incomplete of [{ partial: true }, { limited: true }, { normalizationSucceeded: 9, totalBooks: 10 },
    { classificationSucceeded: 1, candidateCount: 2 }, { normalizationMissing: 1 }, { classificationFailed: 1 }]) {
    let startedLocal = false
    await assert.rejects(discoverAndQueue({
      startDiscovery: async () => ({ runId: 'run' }), waitForIdle: async () => {},
      getState: async () => ({ status: 'completed', ...incomplete }),
      getValidCandidatePairs: async () => { throw new Error('Should not collect partial pairs') },
      startDedupe: async () => { startedLocal = true }
    }), { code: 'AI_ANALYSIS_INCOMPLETE' })
    assert.equal(startedLocal, false)
  }
})

test('failed or cancelled AI discovery never replaces the existing review report', async () => {
  for (const status of ['failed', 'cancelled', 'interrupted']) {
    const calls = { dedupe: 0 }
    await assert.rejects(() => discoverAndQueue({
      startDiscovery: async () => ({ runId: 'run' }),
      waitForIdle: async () => {},
      getState: async () => ({ status, error: 'AI_FAILED' }),
      getValidCandidatePairs: async () => [{ leftId: 'a', rightId: 'b' }],
      startDedupe: async () => { calls.dedupe++ }
    }), error => error.code === 'AI_FAILED')
    assert.equal(calls.dedupe, 0)
  }
})

test('a completed run with no AI relations still runs full local verification', async () => {
  const { calls, result } = await run({ pairs: [] })
  assert.equal(result.pairCount, 0)
  assert.deepEqual(calls.dedupe[0].semanticPairs, [])
})

test('AI containment relations reach local verification without becoming duplicate pairs', async () => {
  const calls = []
  const result = await discoverAndQueue({
    startDiscovery: async () => ({ runId: 'run' }), waitForIdle: async () => {},
    getState: async () => ({ status: 'completed', partial: false }),
    getValidCandidatePairs: async () => [],
    getValidCoveragePairs: async () => [{ leftId: 'a', rightId: 'b', relation: 'same_work_left_contains_right' }],
    startDedupe: async options => { calls.push(options); return { status: 'running' } }
  })
  assert.equal(result.pairCount, 0)
  assert.equal(result.coveragePairCount, 1)
  assert.deepEqual(calls[0].semanticPairs, [])
  assert.deepEqual(calls[0].coveragePairs, [{ leftId: 'a', rightId: 'b', relation: 'same_work_left_contains_right' }])
})

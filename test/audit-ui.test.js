const test = require('node:test')
const assert = require('node:assert/strict')

test('targeted .ehviewer verification rechecks existing actions and report-only anomalies', async () => {
  const { collectOnlineSourceBookIds, summarizeOnlineSourceDecisions } = await import('../src/audit/anomalyOnlineSelection.mjs')
  const ids = collectOnlineSourceBookIds([
    { type: 'ehviewer-source-recoverable', bookId: 'recoverable', action: { type: 'repair-url' } },
    { type: 'ehviewer-url-conflict', bookId: 'conflict', action: null },
    { type: 'ehviewer-invalid', bookId: 'invalid', action: { type: 'repair-ehviewer' } },
    { type: 'ehviewer-source-recoverable', bookId: 'recoverable', action: null },
    { type: 'scan-page-count-stale', bookId: 'local-only', action: null },
    { type: 'ehviewer-url-conflict', bookId: null, action: null }
  ])

  assert.deepEqual(ids, ['recoverable', 'conflict', 'invalid'])

  assert.deepEqual(summarizeOnlineSourceDecisions([
    { type: 'ehviewer-url-conflict-online', recommendedAction: 'manual-review', action: null },
    { type: 'ehviewer-url-conflict-online', recommendedAction: 'no-action', action: null },
    { type: 'ehviewer-url-conflict-online', recommendedAction: 'repair-url-after-approval', action: { type: 'repair-url' } },
    { type: 'ehviewer-url-conflict', recommendedAction: 'online-source-check', action: null }
  ]), { total: 3, actionable: 1, manualReview: 1, inconclusive: 1 })
})

test('anomaly detail navigation follows the filtered order and stops at both ends', async () => {
  const { getAnomalyNavigation } = await import('../src/audit/anomalyNavigation.mjs')
  const items = [{ id: 'first' }, { id: 'middle' }, { id: 'last' }]
  assert.deepEqual(getAnomalyNavigation(items, 'first'), {
    index: 0,
    current: items[0],
    previous: null,
    next: items[1],
    position: { current: 1, total: 3 }
  })
  assert.deepEqual(getAnomalyNavigation(items, 'middle'), {
    index: 1,
    current: items[1],
    previous: items[0],
    next: items[2],
    position: { current: 2, total: 3 }
  })
  assert.deepEqual(getAnomalyNavigation(items, 'last'), {
    index: 2,
    current: items[2],
    previous: items[1],
    next: null,
    position: { current: 3, total: 3 }
  })
  assert.equal(getAnomalyNavigation(items, 'missing').position, null)
})

test('page recovery selection updates one row without losing previous rows', async () => {
  const { mergePageRecoveryPageSelection, togglePageRecoverySelection } = await import('../src/audit/pageRecoverySelection.mjs')
  assert.deepEqual(togglePageRecoverySelection([], 'book:1', true), ['book:1'])
  assert.deepEqual(togglePageRecoverySelection(['book:1'], 'book:2', true), ['book:1', 'book:2'])
  assert.deepEqual(togglePageRecoverySelection(['book:1', 'book:2'], 'book:1', false), ['book:2'])
  assert.deepEqual(mergePageRecoveryPageSelection(['book:1', 'book:3'], ['book:1', 'book:2'], ['book:2']), ['book:3', 'book:2'])
  assert.deepEqual(mergePageRecoveryPageSelection(['book:1', 'book:2'], ['book:1', 'book:2'], []), [])
})

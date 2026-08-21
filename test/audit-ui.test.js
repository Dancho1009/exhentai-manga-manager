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

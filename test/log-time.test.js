const test = require('node:test')
const assert = require('node:assert/strict')
const { beijingLogTimestamp } = require('../modules/log_time.js')
const { AuditWorkspaceManager } = require('../modules/audit/job_manager.js')

test('Beijing log timestamps preserve the instant across day, leap-day and year boundaries', () => {
  for (const [input, expected] of [
    ['2026-10-16T23:03:34.861Z', '2026-10-17T07:03:34.861+08:00'],
    ['2024-02-28T18:00:00.000Z', '2024-02-29T02:00:00.000+08:00'],
    ['2026-12-31T16:00:00.000Z', '2027-01-01T00:00:00.000+08:00'],
    ['2026-10-17T07:03:34.861+08:00', '2026-10-17T07:03:34.861+08:00']
  ]) {
    assert.equal(beijingLogTimestamp(input), expected)
    assert.equal(Date.parse(beijingLogTimestamp(input)), Date.parse(input))
  }
})

test('Audit logs persist explicit Beijing timestamps and order legacy UTC records by actual time', async () => {
  const manager = new AuditWorkspaceManager({ storePath: '.', coordinator: {} })
  const entries = []
  manager.repository = { appendJobLog: async (_taskType, _jobId, entry) => entries.push(entry),
    getJobLogs: async () => [
      { at: '2026-10-16T23:03:34.861Z', message: 'later UTC record' },
      { at: '2026-10-17T07:03:33.861+08:00', message: 'earlier Beijing record' }
    ] }
  const before = Date.now()
  await manager.appendLog('dedupe', 'fixture', 'timestamp fixture')
  assert.match(entries[0].at, /\+08:00$/)
  assert.ok(Date.parse(entries[0].at) >= before && Date.parse(entries[0].at) <= Date.now())
  manager.states.dedupe.latestJobId = 'fixture'
  assert.deepEqual((await manager.getLogs()).map(entry => entry.message), ['earlier Beijing record', 'later UTC record'])
})

test('Audit UI displays Beijing time and orders mixed timezone records consistently', async () => {
  const { formatBeijingLogTime, compareLogTimes } = await import('../src/audit/logTime.mjs')
  assert.equal(formatBeijingLogTime('2026-10-16T23:03:34.861Z'), '2026-10-17 07:03:34')
  assert.equal(formatBeijingLogTime('2026-10-17T07:03:34.861+08:00'), '2026-10-17 07:03:34')
  assert.equal(formatBeijingLogTime('2026-12-31T16:00:00Z'), '2027-01-01 00:00:00')
  const entries = [{ at: '2026-10-16T23:03:34Z' }, { at: '2026-10-17T07:03:33+08:00' }]
  assert.equal(entries.sort(compareLogTimes)[0].at, '2026-10-17T07:03:33+08:00')
})

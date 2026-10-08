const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  confirmationKey, buildSourceConfirmation, matchesSourceConfirmation,
  loadSourceConfirmations, saveSourceConfirmations, restoreSourceConfirmations
} = require('../modules/audit/source_confirmation.js')
const { atomicWriteJson } = require('../modules/audit/utils.js')
const { clearAuditCacheDatabase } = require('../modules/audit/cache.js')
const { checkRepairCandidate, describeAvailabilityFailure } = require('../modules/audit/repair_availability.js')

const url = 'https://exhentai.org/g/3379429/156e2a74f0/'
const context = {
  executionId: 'execution',
  book: { id: 'book', hash: 'hash', filepath: path.join(os.tmpdir(), '3371152-book.zip'), url },
  stat: { size: 123, mtimeMs: 1000 },
  ehviewer: { status: 'absent' }
}
const availability = (eh, ex) => ({
  sites: { ehentai: { status: eh, httpStatus: 404 }, exhentai: { status: ex, httpStatus: ex === 'available' ? 200 : null } }
})

test('source confirmations bind file and marker identity, not the EH domain', () => {
  const record = buildSourceConfirmation({ ...context, executionId: 'execution' })
  assert.equal(matchesSourceConfirmation(record, context), true)
  assert.equal(matchesSourceConfirmation(record, { ...context, book: { ...context.book, url: url.replace('exhentai', 'e-hentai') } }), true)
  for (const changed of [
    { book: { ...context.book, id: 'other' } },
    { book: { ...context.book, filepath: context.book.filepath.replace('3371152', '3379429') } },
    { book: { ...context.book, hash: 'changed' } },
    { book: { ...context.book, url: 'https://exhentai.org/g/3379429/abcdef1234/' } },
    { book: { ...context.book, url: 'https://exhentai.org/g/3371152/156e2a74f0/' } },
    { book: { ...context.book, url: 'https://nhentai.net/g/3379429/' } },
    { stat: { ...context.stat, size: 124 } },
    { stat: { ...context.stat, mtimeMs: 1002 } },
    { ehviewer: { status: 'parsed', gid: '3371152', token: 'abcdef1234' } }
  ]) assert.equal(matchesSourceConfirmation(record, { ...context, ...changed }), false)
  assert.equal(buildSourceConfirmation({ ...context, book: { ...context.book, url: 'invalid' } }), null)
})

test('source confirmations survive store reopening and inspection cache cleanup', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'audit-source-store-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const record = buildSourceConfirmation(context)
  await saveSourceConfirmations(root, [record])
  await clearAuditCacheDatabase(root)
  assert.deepEqual((await loadSourceConfirmations(root)).get(confirmationKey(context.book)), record)
  await fs.promises.writeFile(path.join(root, 'source-confirmations.json'), '{broken')
  await assert.rejects(loadSourceConfirmations(root), SyntaxError)
})

test('only verified manual execution logs restore legacy confirmations, excluding skipped items', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'audit-source-restore-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const report = { reportId: 'anomaly:report', anomalies: [
    { id: 'success', type: 'filename-url-id-conflict', bookId: 'book', filepath: context.book.filepath, action: null },
    { id: 'automatic', type: 'filename-url-id-conflict', bookId: 'automatic', filepath: context.book.filepath, action: { type: 'repair-url' } }
  ] }
  const state = { latestJobId: 'execution', status: 'completed', options: { reportId: report.reportId, sourceTaskType: 'anomaly' } }
  const prepared = { status: 'prepared', type: 'repair-url', anomalyId: 'success', bookId: 'book', oldUrl: url, newUrl: url, at: new Date(2000).toISOString() }
  const verified = { status: 'verified', taskType: 'anomaly', repairedCount: 1 }
  const args = { storePath: root,
    books: ['book', 'automatic', 'skipped'].map(id => ({ raw: { ...context.book, id }, effective: { url }, actual: context.stat })),
    healthById: new Map(['book', 'automatic', 'skipped'].map(id => [id, { ehviewer: context.ehviewer }])) }
  await atomicWriteJson(path.join(root, 'channels', 'execution-state.json'), state)
  await atomicWriteJson(path.join(root, 'jobs', 'anomaly', 'report', 'report.json'), report)
  const logPath = path.join(root, 'executions', 'execution', 'action-audit.jsonl')
  await fs.promises.mkdir(path.dirname(logPath), { recursive: true })
  const writeLog = entries => fs.promises.writeFile(logPath, entries.map(item => JSON.stringify(item)).join('\n'))
  await writeLog([prepared, { status: 'skipped', bookId: 'skipped' }, verified])
  const confirmations = new Map()
  assert.equal(await restoreSourceConfirmations({ ...args, confirmations, persist: false }), 1)
  assert.equal(confirmations.size, 1)
  assert.equal(fs.existsSync(path.join(root, 'source-confirmations.json')), false)
  assert.equal(await restoreSourceConfirmations({ ...args, confirmations: new Map() }), 1)
  assert.equal((await loadSourceConfirmations(root)).size, 1)
  for (const entries of [
    [prepared], [prepared, verified, { status: 'failed' }], [prepared, { ...verified, repairedCount: 2 }],
    [{ ...prepared, anomalyId: 'automatic', bookId: 'automatic' }, verified],
    [{ ...prepared, newUrl: url.replace('3379429', '3371152') }, verified]
  ]) {
    await writeLog(entries)
    assert.equal(await restoreSourceConfirmations({ ...args, confirmations: new Map(), persist: false }), 0)
  }
  await writeLog([prepared, verified])
  assert.equal(await restoreSourceConfirmations({ ...args, books: [{ ...args.books[0], actual: { ...context.stat, mtimeMs: 3000 } }], confirmations: new Map(), persist: false }), 0)
  await atomicWriteJson(path.join(root, 'channels', 'execution-state.json'), { ...state, status: 'failed' })
  assert.equal(await restoreSourceConfirmations({ ...args, confirmations: new Map(), persist: false }), 0)
})

test('new execution logs restore their exact source snapshot instead of rebinding changed files', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'audit-source-new-log-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  await atomicWriteJson(path.join(root, 'channels', 'execution-state.json'), {
    latestJobId: 'execution', status: 'completed', options: { reportId: 'anomaly:report', sourceTaskType: 'anomaly' }
  })
  await atomicWriteJson(path.join(root, 'jobs', 'anomaly', 'report', 'report.json'), { reportId: 'anomaly:report', anomalies: [] })
  const sourceConfirmation = buildSourceConfirmation(context)
  const logPath = path.join(root, 'executions', 'execution', 'action-audit.jsonl')
  await fs.promises.mkdir(path.dirname(logPath), { recursive: true })
  await fs.promises.writeFile(logPath, [
    { status: 'prepared', bookId: 'book', sourceConfirmation },
    { status: 'verified', taskType: 'anomaly', repairedCount: 1 }
  ].map(item => JSON.stringify(item)).join('\n'))
  const args = { storePath: root, books: [{ raw: context.book, effective: { url }, actual: context.stat }],
    healthById: new Map([['book', { ehviewer: context.ehviewer }]]), persist: false }
  const confirmations = new Map()
  assert.equal(await restoreSourceConfirmations({ ...args, confirmations }), 1)
  assert.deepEqual([...confirmations.values()], [sourceConfirmation])
  assert.equal(await restoreSourceConfirmations({ ...args, books: [{ ...args.books[0], actual: { ...context.stat, size: 124 } }], confirmations: new Map() }), 0)
})

test('approval accepts either accessible site, retrying transient failure only once', async () => {
  let calls = 0
  const waits = []
  const requests = []
  const result = await checkRepairCandidate({ url, setting: { requireGap: 1500 }, wait: async ms => waits.push(ms), checkSites: async request => {
    requests.push(request)
    return ++calls === 1 ? availability('generic-unavailable', 'network-error') : availability('generic-unavailable', 'available')
  } })
  assert.equal(result.valid, true)
  assert.equal(result.candidate.sites.ehentai.status, 'generic-unavailable')
  assert.equal(calls, 2)
  assert.deepEqual(waits, [1000])
  assert.equal(requests.every(value => value.force && value.strategy === 'both' && value.setting.requireGap === 1500), true)
  calls = 0
  const fallback = await checkRepairCandidate({ url, checkSites: async () => { calls++; return availability('available', 'network-error') } })
  assert.equal(fallback.valid, true)
  assert.equal(calls, 1)
})

test('approval failure preserves both site evidence and does not equate access failures with copyright', async () => {
  for (const [status, code, count] of [
    ['network-error', 'REPAIR_CANDIDATE_NETWORK_ERROR', 2],
    ['service-unavailable', 'REPAIR_CANDIDATE_SERVICE_UNAVAILABLE', 2],
    ['unknown', 'REPAIR_CANDIDATE_STATUS_UNKNOWN', 2],
    ['auth-required', 'REPAIR_CANDIDATE_AUTH_REQUIRED', 1],
    ['ip-banned', 'REPAIR_CANDIDATE_IP_BANNED', 1],
    ['copyright', 'REPAIR_CANDIDATE_COPYRIGHT', 1],
    ['geo-blocked', 'REPAIR_CANDIDATE_GEO_BLOCKED', 1],
    ['gallery-not-found', 'REPAIR_CANDIDATE_NOT_FOUND', 1]
  ]) {
    let calls = 0
    const result = await checkRepairCandidate({ url, wait: async () => {}, checkSites: async () => {
      calls++
      return { sites: { ehentai: { status, httpStatus: 404, claimant: 'A.B. Comics', html: 'secret html', headers: { cookie: 'secret-cookie' } },
        exhentai: { status, error: 'socket hang up' } } }
    } })
    assert.equal(result.valid, false)
    assert.equal(result.error, code)
    assert.equal(calls, count)
    assert.equal(result.detail.sites.ehentai.httpStatus, 404)
    assert.equal(result.detail.sites.exhentai.error, 'socket hang up')
    assert.equal(JSON.stringify(result).includes('secret'), false)
  }
  assert.equal(describeAvailabilityFailure(availability('copyright', 'unknown')).error, 'REPAIR_CANDIDATE_STATUS_UNKNOWN')
  assert.equal((await checkRepairCandidate({ url: 'invalid' })).error, 'INVALID_REPAIR_CANDIDATE_URL')
})

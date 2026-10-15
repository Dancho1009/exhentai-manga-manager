const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')
const { randomBytes } = require('crypto')
const { execFile } = require('child_process')
const { promisify } = require('util')
const { Worker } = require('worker_threads')
const { createFixture, scan, marker, archive } = require('./fixtures/dedupe-fixture.cjs')
const { resolveBookIdentity } = require('../modules/audit/dedupe_identity.js')
const { enumerateBookEntries } = require('../modules/audit/dedupe_manifest.js')
const { inspectBookContent } = require('../modules/audit/archive_inspector.js')
const { compareBookEvidence } = require('../modules/audit/dedupe_comparison.js')
const { normalizeDedupeReview, buildExecutionPreview } = require('../modules/audit/review_validator.js')
const { AuditReportRepository } = require('../modules/audit/report_repository.js')
const { AuditWorkspaceManager } = require('../modules/audit/job_manager.js')
const { LibraryTaskCoordinator } = require('../modules/audit/task_coordinator.js')
const { executeApprovedDuplicates } = require('../modules/audit/dedupe_action_executor.js')
const { snapshotMetadataRows, restoreMetadataRows } = require('../modules/audit/execution_common.js')

const fixtureFor = async (t, descriptors) => { const fixture = await createFixture(descriptors); t.after(fixture.cleanup); return fixture }
const decisionFor = (group, mapping, manual = false) => ({ disposition: 'duplicate', evidenceRevision: group.evidenceRevision,
  keepIds: group.items.filter(item => !mapping[item.id]).map(item => item.id), quarantineToKeep: mapping,
  reason: manual ? 'Compared all differences and retained the selected edition' : '', confirmedConflictCodes: manual ? ['manual-differences'] : [] })
const evidenceFor = async (fixture, item) => await new AuditReportRepository(fixture.root).getDedupeEvidence(item)
const waitForDedupe = manager => new Promise((resolve, reject) => {
  const listener = state => {
    if (state.activeTask || !['completed', 'failed'].includes(state.channels.dedupe.status)) return
    manager.off('state', listener)
    clearTimeout(timer)
    state.channels.dedupe.status === 'completed' ? resolve() : reject(new Error(state.channels.dedupe.error))
  }
  const timer = setTimeout(() => { manager.off('state', listener); reject(new Error('Dedupe fixture timeout')) }, 10000)
  manager.on('state', listener)
  listener(manager.getState())
})

test('dedupe identities unify EH domains and marker provenance without dropping missing or invalid members', () => {
  const wrapped = { raw: { url: 'https://e-hentai.org/g/123456/abcdef1234/' }, effective: { url: 'https://exhentai.org/g/123456/abcdef1234/' } }
  assert.equal(resolveBookIdentity(wrapped, { status: 'parsed', gid: '123456', token: 'ABCDEF1234' }).status, 'known')
  assert.equal(resolveBookIdentity({ raw: {}, effective: {} }, { status: 'absent' }).status, 'missing')
  assert.equal(resolveBookIdentity(wrapped, { status: 'parsed', gid: '123456', token: 'bad?' }).status, 'invalid')
  assert.equal(resolveBookIdentity(wrapped, { status: 'ambiguous', gid: '123456', token: 'abcdef1234' }).status, 'ambiguous')
  const nh = { raw: { url: 'https://nhentai.net/g/123456/' }, effective: { url: 'https://nhentai.net/g/123456/' } }
  assert.equal(resolveBookIdentity(nh, { status: 'parsed', gid: '123456', token: 'abcdef1234' }).status, 'conflict')
})

test('actual manifests discover repacked, renamed copies with missing sampled hashes and declared page counts', async t => {
  const fixture = await fixtureFor(t, [
    { id: 'a', title: 'One', hash: null, entries: { '001.jpg': 'p1', '002.jpg': 'p2', '.ehviewer': marker } },
    { id: 'b', title: 'Other', hash: null, comment: 'different container', entries: { 'renamed/a.jpg': 'p1', 'renamed/b.jpg': 'p2', '.ehviewer': marker } }
  ])
  const report = await scan(fixture)
  assert.equal(report.groups.length, 1)
  assert.equal(report.groups[0].kind, 'strict-content')
  assert.equal(report.groups[0].eligible, true)
  assert.deepEqual(report.groups[0].items.map(item => item.actualPageCount), [2, 2])
  assert.ok(report.groups[0].items.every(item => item.evidenceRef && item.contentProof))
  assert.ok(report.groups[0].reasons.some(reason => reason.code === 'manifest-order'))
})

test('large compressed entry streams close without closing the shared ZIP handle', async t => {
  const payload = randomBytes(300000)
  const fixture = await fixtureFor(t, [{ id: 'large', entries: { '01.jpg': payload, '.ehviewer': marker } }])
  const book = (await fixture.Manga.findByPk('large')).toJSON()
  const inspection = await inspectBookContent(book)
  assert.equal(inspection.images[0].size, payload.length)
  assert.equal(inspection.ehviewer.gid, '123456')
  const { readBookEntry } = require('../modules/audit/dedupe_preview_worker.js')
  assert.deepEqual(await readBookEntry(book, inspection.images[0], {}), payload)
})

test('page containment and same-source editions remain manual candidates, not automatic quarantine equivalents', async t => {
  const fixture = await fixtureFor(t, [
    { id: 'short', title: 'Short', entries: { '01.jpg': 'one', '02.jpg': 'two', '.ehviewer': marker } },
    { id: 'long', title: 'Compilation', entries: { '01.jpg': 'one', '02.jpg': 'two', '03.jpg': 'three', '.ehviewer': marker } }
  ])
  const report = await scan(fixture, { scanMode: 'full' })
  assert.equal(report.groups[0].kind, 'coverage-review')
  assert.equal(report.groups[0].eligible, false)
  assert.equal(report.groups[0].equivalenceClasses.length, 0)
})

test('daily scans leave a sampled-hash-only candidate unverified until explicit full verification', async t => {
  const fixture = await fixtureFor(t, [
    { id: 'a', url: '', tags: {}, entries: { '01.jpg': 'long-first-page' } },
    { id: 'b', url: '', tags: {}, entries: { '01.jpg': 'other', '02.jpg': 'pages', '03.jpg': 'three' } }
  ])
  await fixture.Manga.update({ hash: 'sample-a' }, { where: { id: 'b' } })
  const daily = await scan(fixture)
  assert.equal(daily.groups[0].kind, 'shared-hash-review')
  assert.equal(daily.groups[0].verification.status, 'unverified')
  assert.equal(daily.performance.contentHashBytes, 0)
  const full = await scan(fixture, { scanMode: 'full' })
  assert.equal(full.groups[0].verification.status, 'verified')
  assert.ok(full.performance.contentHashBytes > 0)
})

test('7z manifests, streaming page proofs and selected-entry extraction preserve literal entry paths', async t => {
  const sevenZipPath = path.join(__dirname, '../resources/extraResources/7z.exe')
  const fixture = await fixtureFor(t, [{ id: 'a', filename: 'a.7z', type: '7z' }])
  const contents = path.join(fixture.root, 'pack-source')
  await fs.promises.mkdir(contents)
  const image = await sharp({ create: { width: 20, height: 32, channels: 3, background: '#554466' } }).png().toBuffer()
  await Promise.all([fs.promises.writeFile(path.join(contents, '01.png'), image), fs.promises.writeFile(path.join(contents, '.ehviewer'), marker), fs.promises.writeFile(path.join(contents, 'note[1].txt'), 'literal notes')])
  const book = (await fixture.Manga.findByPk('a')).toJSON()
  await fs.promises.unlink(book.filepath)
  await promisify(execFile)(sevenZipPath, ['a', '-t7z', book.filepath, '01.png', '.ehviewer', 'note[1].txt'], { cwd: contents, windowsHide: true })
  const manifest = await enumerateBookEntries(book, { sevenZipPath })
  assert.equal(manifest.pageCount, 1)
  const inspection = await inspectBookContent(book, { sevenZipPath, manifest })
  assert.equal(inspection.images[0].size, image.length)
  const { readBookEntry } = require('../modules/audit/dedupe_preview_worker.js')
  assert.equal((await readBookEntry(book, inspection.ancillary.find(entry => entry.path === 'note[1].txt'), { sevenZipPath })).toString(), 'literal notes')
})

test('same pages with changed sidecars or one unknown source cannot become strict-content', async t => {
  const fixture = await fixtureFor(t, [
    { id: 'a', entries: { '01.jpg': 'one', '02.jpg': 'two' } },
    { id: 'b', url: '', entries: { '01.jpg': 'one', '02.jpg': 'two', 'note.txt': 'unique notes' } }
  ])
  const report = await scan(fixture)
  const group = report.groups[0]
  assert.equal(group.kind, 'content-review')
  assert.equal(group.eligible, false)
  assert.equal(group.items.find(item => item.id === 'b').sourceEvidence.status, 'missing')
  const repository = new AuditReportRepository(fixture.root)
  const details = await Promise.all(group.items.map(item => repository.getDedupeEvidence(item)))
  assert.ok(compareBookEvidence(details[0].inspection, details[1].inspection).ancillary.some(entry => entry.status !== 'same' && entry.path === 'note.txt'))
})

test('unreadable identical containers and duplicate database paths never receive a batch suggestion', async t => {
  const fixture = await fixtureFor(t, [{ id: 'a', buffer: Buffer.from('corrupt') }, { id: 'b', buffer: Buffer.from('corrupt') }])
  const report = await scan(fixture)
  assert.equal(report.summary.excludedItems, 2)
  assert.equal(report.groups[0].eligible, false)
  const original = (await fixture.Manga.findByPk('a')).toJSON()
  await fixture.Manga.create({ ...original, id: 'same-path', hash: 'different-sample' })
  const pathReport = await scan(fixture)
  assert.equal(pathReport.groups[0].kind, 'duplicate-database-path')
  assert.equal(pathReport.groups[0].actionable, false)
})

test('content evidence is reused on warm scans and recomputed independently of full-scan scope', async t => {
  const fixture = await fixtureFor(t, [{ id: 'a' }, { id: 'b', comment: 'repack' }])
  const first = await scan(fixture)
  const warm = await scan(fixture)
  assert.equal(warm.groups[0].evidenceRevision, first.groups[0].evidenceRevision)
  assert.ok(warm.groups[0].items.every(item => item.contentFromCache))
  const forced = await scan(fixture, { scanMode: 'full', forceRecompute: true })
  assert.ok(forced.groups[0].items.every(item => !item.contentFromCache))
})

test('negative decisions survive reopening, reset when evidence changes, and remain undone on subsequent scans', async t => {
  const fixture = await fixtureFor(t, [{ id: 'a' }, { id: 'b', comment: 'repack' }])
  const report = await scan(fixture, {}, 'history-first')
  const repository = new AuditReportRepository(fixture.root)
  const state = { latestCompletedJobId: report.jobId, latestReportId: report.reportId, latestReportPath: path.join(fixture.auditStorePath, 'jobs', 'dedupe', report.jobId, 'report.json') }
  const group = report.groups[0]
  await repository.saveReview('dedupe', state, { decisions: { [group.id]: { disposition: 'not-duplicate', evidenceRevision: group.evidenceRevision, reason: 'Keep both' } } })
  const next = await scan(fixture, {}, 'history-second')
  const nextState = { latestCompletedJobId: next.jobId, latestReportId: next.reportId, latestReportPath: path.join(fixture.auditStorePath, 'jobs', 'dedupe', next.jobId, 'report.json') }
  assert.equal((await new AuditReportRepository(fixture.root).getReview('dedupe', nextState)).decisions[group.id].disposition, 'not-duplicate')
  await repository.saveReview('dedupe', nextState, { decisions: {} })
  const final = await scan(fixture, {}, 'history-third')
  assert.deepEqual((await repository.getReview('dedupe', { latestCompletedJobId: final.jobId, latestReportId: final.reportId, latestReportPath: path.join(fixture.auditStorePath, 'jobs', 'dedupe', final.jobId, 'report.json') })).decisions, {})
  await fs.promises.writeFile((await fixture.Manga.findByPk('b')).filepath, archive({ '01.jpg': 'changed', '.ehviewer': marker }))
  const changed = await scan(fixture, {}, 'history-changed')
  assert.notEqual(changed.groups[0].evidenceRevision, group.evidenceRevision)
})

test('scoped group verification keeps other groups and their lazy evidence references intact', async t => {
  const fixture = await fixtureFor(t, [{ id: 'a', title: 'A', tags: {} }, { id: 'b', title: 'B', tags: {} },
    { id: 'c', title: 'C', tags: {}, url: 'https://exhentai.org/g/654321/abcdef1234/', entries: { '01.jpg': 'other1', '02.jpg': 'other2', '.ehviewer': marker.replace('123456', '654321') } },
    { id: 'd', title: 'D', tags: {}, url: 'https://exhentai.org/g/654321/abcdef1234/', entries: { '01.jpg': 'other1', '02.jpg': 'other2', '.ehviewer': marker.replace('123456', '654321') } }])
  const manager = new AuditWorkspaceManager({ storePath: fixture.root, coordinator: new LibraryTaskCoordinator() })
  await manager.initialize()
  await manager.startDedupe({ ...fixture, Manga: undefined, Metadata: undefined, cleanup: undefined, scanMode: 'full' })
  await waitForDedupe(manager)
  const before = await manager.getReport('dedupe')
  assert.equal(before.groups.length, 2)
  const changed = before.groups[0], unchanged = before.groups[1]
  await manager.startDedupe({ library: fixture.library, databasePath: fixture.databasePath, metadataPath: fixture.metadataPath, auditStorePath: fixture.auditStorePath, reportId: before.reportId, groupIds: [changed.id] })
  await waitForDedupe(manager)
  const after = await manager.getReport('dedupe')
  assert.equal(after.options.scope, 'groups')
  assert.deepEqual(after.groups.map(group => group.id), before.groups.map(group => group.id))
  assert.deepEqual(after.groups.find(group => group.id === unchanged.id), unchanged)
  assert.ok(await manager.repository.getDedupeEvidence(unchanged.items[0]))
  await fixture.Manga.destroy({ where: { id: changed.items[1].id } })
  await manager.startDedupe({ library: fixture.library, databasePath: fixture.databasePath, metadataPath: fixture.metadataPath, auditStorePath: fixture.auditStorePath, reportId: after.reportId, groupIds: [changed.id] })
  await waitForDedupe(manager)
  assert.deepEqual((await manager.getReport('dedupe')).groups, [unchanged])
})

test('dedupe workers cancel during manifest enumeration without publishing a completed report', async t => {
  const fixture = await fixtureFor(t, Array.from({ length: 8 }, (_, index) => ({ id: String(index) })))
  const jobDir = path.join(fixture.auditStorePath, 'jobs', 'dedupe', 'cancelled')
  await fs.promises.mkdir(jobDir, { recursive: true })
  const result = await new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, '../modules/audit/dedupe_worker.js'), { workerData: { jobId: 'cancelled', jobDir,
      options: { library: fixture.library, databasePath: fixture.databasePath, metadataPath: fixture.metadataPath, auditStorePath: fixture.auditStorePath } } })
    let terminal
    worker.on('message', message => {
      if (message.phase === 'enumerating-manifests') worker.postMessage({ type: 'cancel' })
      if (['cancelled', 'completed', 'failed'].includes(message.type)) terminal = message
    })
    worker.on('error', reject)
    worker.on('exit', () => resolve(terminal))
  })
  assert.equal(result.type, 'cancelled')
  assert.equal(fs.existsSync(path.join(jobDir, 'report.json')), false)
  assert.equal(await fixture.Manga.count(), 8)
})

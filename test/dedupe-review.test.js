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
const { DedupeReviewService } = require('../modules/audit/dedupe_review_service.js')
const { executeApprovedDuplicates } = require('../modules/audit/dedupe_action_executor.js')
const { verifyDedupeItem } = require('../modules/audit/dedupe_verification.js')
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

test('full content scans bypass weak filters and distinguish repeated, reordered, inserted and missing pages', async t => {
  const fixture = await fixtureFor(t, [
    { id: 'a', title: 'Unrelated A', hash: null, tags: {}, url: '', entries: { '01.jpg': 'one', '02.jpg': 'repeat', '03.jpg': 'repeat', '04.jpg': 'last' } },
    { id: 'b', title: 'Unrelated B', hash: null, tags: {}, url: '', entries: { '01.jpg': 'last', '02.jpg': 'repeat', '03.jpg': 'one', '04.jpg': 'repeat' } },
    { id: 'c', title: 'Unrelated C', hash: null, tags: {}, url: '', entries: { '01.jpg': 'one', '02.jpg': 'repeat', '03.jpg': 'insert' } }
  ])
  const report = await scan(fixture, { scanMode: 'full' })
  const items = report.groups[0].items
  const [a, b] = await Promise.all(['a', 'b'].map(id => evidenceFor(fixture, items.find(item => item.id === id))))
  const comparison = compareBookEvidence(a.inspection, b.inspection)
  assert.equal(comparison.multisetEqual, true)
  assert.equal(comparison.orderedEqual, false)
  assert.equal(comparison.matchedCount, 4)
  const cBook = await fixture.Manga.findByPk('c', { raw: true })
  const c = await inspectBookContent(cBook)
  const differences = compareBookEvidence(a.inspection, c)
  assert.equal(differences.matchedCount, 2)
  assert.equal(differences.onlyLeft.length, 2)
  assert.equal(differences.onlyRight.length, 1)
  assert.equal(differences.coverage.left, 0.5)
  assert.equal(differences.coverage.right, 2 / 3)
  const { pagePairs } = await import('../src/audit/dedupeReview.mjs')
  assert.equal(pagePairs({ left: a.inspection, right: b.inspection, comparison }, 'hash').length, 4)
  assert.equal(pagePairs({ left: a.inspection, right: b.inspection, comparison }, 'hash', true).length, 0)
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

test('registered nested books invalidate the parent decision and prevent parent-folder isolation', async t => {
  const entries = { '01.jpg': 'one', '02.jpg': 'two', 'nested/01.jpg': 'child', '.ehviewer': marker }
  const fixture = await fixtureFor(t, [{ id: 'a', type: 'folder', entries }, { id: 'b', type: 'folder', entries }])
  const before = await scan(fixture)
  await fixture.Manga.create({ id: 'child', hash: null, filepath: path.join(fixture.library, 'a', 'nested'), type: 'folder', title: 'Child', url: '', tags: {} })
  const after = await scan(fixture)
  const group = after.groups.find(group => group.items.some(item => item.id === 'a'))
  assert.ok(group.items.find(item => item.id === 'a').nestedBookIds.includes('child'))
  assert.notEqual(group.evidenceRevision, before.groups[0].evidenceRevision)
  assert.throws(() => normalizeDedupeReview(after, { reportId: after.reportId, decisions: { [group.id]: decisionFor(group, { a: 'b' }, true) } }), /FOLDER_CONTAINS_OTHER_BOOKS/)
  assert.ok(fs.existsSync(path.join(fixture.library, 'a', 'nested', '01.jpg')))
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

test('a review group contains independent content classes and never quarantines another language through transitivity', async t => {
  const entries = { '01.jpg': 'jp1', '02.jpg': 'jp2', '.ehviewer': marker }
  const fixture = await fixtureFor(t, [
    { id: 'a', entries }, { id: 'b', entries, comment: 'repacked' },
    { id: 'c', entries: { '01.jpg': 'cn1', '02.jpg': 'cn2', '.ehviewer': marker }, tags: { artist: ['fixture-artist'], language: ['chinese'] } }
  ])
  const report = await scan(fixture)
  assert.equal(report.groups.length, 1)
  assert.equal(report.groups[0].items.length, 3)
  assert.deepEqual(report.groups[0].equivalenceClasses[0].memberIds.sort(), ['a', 'b'])
  const { suggestedDecision, getDecisionFiles } = await import('../src/audit/dedupeReview.mjs')
  const decision = suggestedDecision(report.groups[0])
  assert.ok(decision.keepIds.includes('c'))
  assert.equal(getDecisionFiles(report, { [report.groups[0].id]: decision }).length, 1)
})

test('folders retain direct-page reading semantics, disclose nested images and invalidate equal-length edits', async t => {
  const entries = { '01.jpg': 'one', '02.jpg': 'two', 'nested/01.jpg': 'nested', '.ehviewer': marker }
  const fixture = await fixtureFor(t, [{ id: 'a', type: 'folder', entries }, { id: 'b', type: 'folder', entries }])
  const report = await scan(fixture)
  const group = report.groups[0]
  assert.equal(group.items[0].actualPageCount, 2)
  assert.deepEqual(group.items[0].uncoveredEntries, ['nested/01.jpg'])
  assert.equal(group.eligible, false)
  const item = group.items.find(item => item.id === 'a')
  const directoryStamp = await fs.promises.stat(item.filepath)
  await fs.promises.writeFile(path.join(item.filepath, '01.jpg'), 'new')
  await fs.promises.utimes(item.filepath, directoryStamp.atime, directoryStamp.mtime)
  await assert.rejects(verifyDedupeItem(item, { ...fixture, isCancelled: () => false }), /DEDUPE_CONTENT_CHANGED/)
  const changed = await scan(fixture)
  assert.notEqual(changed.groups[0].evidenceRevision, group.evidenceRevision)
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

test('decisions bind evidence revisions, validate explicit mappings and preview unique physical files', async t => {
  const fixture = await fixtureFor(t, [{ id: 'a' }, { id: 'b', comment: 'repack' }, { id: 'c', entries: { '01.jpg': 'edition', '.ehviewer': marker } }])
  const report = await scan(fixture)
  const group = report.groups[0]
  const review = { reportId: report.reportId, decisions: { [group.id]: decisionFor(group, { b: 'a' }) }, quarantineRoot: path.join(fixture.root, 'Quarantine') }
  const preview = buildExecutionPreview({ taskType: 'dedupe', report, review, library: fixture.library })
  assert.equal(preview.quarantineFileCount, 1)
  assert.equal(preview.files[0].keepId, 'a')
  assert.equal(preview.potentialBytes, group.items.find(item => item.id === 'b').size)
  assert.throws(() => normalizeDedupeReview(report, { ...review, decisions: { [group.id]: { ...review.decisions[group.id], evidenceRevision: 'old' } } }), /EVIDENCE_CHANGED/)
  assert.throws(() => normalizeDedupeReview(report, { ...review, decisions: { [group.id]: decisionFor(group, { c: 'a' }) } }), /DIFFERENCES_NOT_CONFIRMED/)
  assert.doesNotThrow(() => normalizeDedupeReview(report, { ...review, decisions: { [group.id]: decisionFor(group, { c: 'a' }, true) } }))
  assert.throws(() => normalizeDedupeReview(report, { ...review, decisions: { [group.id]: { ...decisionFor(group, { b: 'a', a: 'b' }), keepIds: ['a', 'b'] } } }), /INVALID_DUPLICATE_SELECTION/)
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

test('lazy page previews extract selected neighbors, verify bytes, isolate owners and cancel rapid switches', async t => {
  const image = await sharp({ create: { width: 24, height: 30, channels: 3, background: '#324a76' } }).png().toBuffer()
  const entries = { '.ehviewer': marker, 'note.txt': 'notes', ...Object.fromEntries(Array.from({ length: 9 }, (_, index) => [String(index + 1).padStart(2, '0') + '.png', image])) }
  const fixture = await fixtureFor(t, [{ id: 'a', entries }, { id: 'b', entries }])
  const report = await scan(fixture)
  const manager = { getReport: async () => report, repository: new AuditReportRepository(fixture.root) }
  const service = new DedupeReviewService({ manager, previewRoot: path.join(fixture.root, 'preview') })
  const request = { reportId: report.reportId, groupId: report.groups[0].id, leftId: 'a', rightId: 'b', leftIndex: 4, rightIndex: 4 }
  const [first, other] = await Promise.all([service.preview(1, request), service.preview(2, request)])
  assert.equal(first.length, 6)
  assert.equal(first[1].width, 24)
  assert.notEqual(first[1].path, other[1].path)
  await service.cleanup(1)
  assert.equal(fs.existsSync(first[1].path), false)
  assert.equal(fs.existsSync(other[1].path), true)
  const text = await service.preview(1, { ...request, textPath: 'note.txt' })
  assert.deepEqual(text.map(item => item.text), ['notes', 'notes'])
  const earlier = service.preview(1, request).catch(error => error)
  const latest = service.preview(1, { ...request, leftIndex: 2, rightIndex: 2 })
  assert.match((await earlier).message, /AUDIT_CANCELLED/)
  assert.ok((await latest).some(item => item.key === 'left-2' && item.url))
  await Promise.all([service.cleanup(1), service.cleanup(2)])
  assert.equal(fs.existsSync(path.join(fixture.root, 'preview', '1')) ? (await fs.promises.readdir(path.join(fixture.root, 'preview', '1'))).length : 0, 0)
})

test('execution rechecks archive bytes even when size and mtime are unchanged, plus current metadata provenance', async t => {
  const fixture = await fixtureFor(t, [{ id: 'a', comment: 'one' }, { id: 'b', comment: 'one' }])
  const report = await scan(fixture)
  const item = report.groups[0].items.find(item => item.id === 'b')
  const stamp = await fs.promises.stat(item.filepath)
  const buffer = await fs.promises.readFile(item.filepath)
  buffer[buffer.length - 1] ^= 1
  await fs.promises.writeFile(item.filepath, buffer)
  await fs.promises.utimes(item.filepath, stamp.atime, stamp.mtime)
  await assert.rejects(verifyDedupeItem(item, { ...fixture, isCancelled: () => false }), /DEDUPE_CONTENT_CHANGED/)
  const keeper = report.groups[0].items.find(item => item.id === 'a')
  await fixture.Metadata.update({ url: 'https://nhentai.net/g/123456/' }, { where: { hash: keeper.hash } })
  await assert.rejects(verifyDedupeItem(keeper, { ...fixture, isCancelled: () => false }), /DEDUPE_METADATA_CHANGED/)
})

test('new mapped approvals execute quarantine, merge user state and preserve before/after snapshots and history', async t => {
  const fixture = await fixtureFor(t, [{ id: 'a', readCount: 2, hiddenBook: true }, { id: 'b', readCount: 7, mark: true }])
  await fixture.Metadata.update({ title: 'Effective keeper title' }, { where: { hash: 'sample-a' } })
  const originalTags = (await fixture.Metadata.findByPk('sample-a')).tags
  const report = await scan(fixture)
  const group = report.groups[0]
  const executionId = 'mapped-execution', executionDir = path.join(fixture.auditStorePath, 'executions', executionId)
  await fs.promises.mkdir(executionDir, { recursive: true })
  let collections
  const result = await executeApprovedDuplicates({ ...fixture, dedupeReport: report,
    dedupeReview: { reportId: report.reportId, decisions: { [group.id]: decisionFor(group, { b: 'a' }) }, quarantineRoot: path.join(fixture.root, 'Quarantine') }, executionId, executionDir,
    collectionList: [{ id: 'collection', list: ['sample-b'] }], saveCollectionList: async value => { collections = value },
    rendererState: { recentRead: [{ id: 'b' }], viewerReadingProgress: [{ bookId: 'b', pageId: '02.jpg' }] } })
  assert.equal(result.movedCount, 1)
  assert.equal(await fixture.Manga.count(), 1)
  const keeper = await fixture.Manga.findByPk('a')
  assert.equal(keeper.mark, true)
  assert.equal(keeper.readCount, 7)
  assert.equal((await fixture.Metadata.findByPk('sample-a')).title, 'Effective keeper title')
  assert.deepEqual((await fixture.Metadata.findByPk('sample-a')).tags, originalTags)
  const storedMetadata = await fixture.Metadata.findByPk('sample-a', { raw: true })
  assert.deepEqual(JSON.parse(storedMetadata.tags), originalTags, 'Persisted tags must decode to an object after one JSON parse')
  assert.deepEqual(collections[0].list, ['sample-a'])
  const state = JSON.parse(await fs.promises.readFile(result.statePath, 'utf8'))
  assert.equal(state.before.mangas.length, 2)
  assert.equal(state.after.mangas.length, 1)
  const service = new DedupeReviewService({ manager: { repository: new AuditReportRepository(fixture.root) } })
  const history = await service.getHistory()
  assert.equal(history.length, 1)
  assert.equal(history[0].files[0].keepId, 'a')
  assert.equal(history[0].backupDir, result.backupDir)
})

test('metadata rollback preserves structured tags without adding JSON encoding', async t => {
  const fixture = await fixtureFor(t, [{ id: 'a', tags: { artist: ['Original author'], language: ['chinese', 'translated'] } }])
  const original = (await fixture.Metadata.findByPk('sample-a')).toJSON()
  const rows = await snapshotMetadataRows(fixture.Metadata, ['sample-a'])
  await fixture.Metadata.update({ tags: { artist: ['Changed author'] } }, { where: { hash: 'sample-a' } })
  await restoreMetadataRows(fixture.Metadata, ['sample-a'], rows)
  assert.deepEqual((await fixture.Metadata.findByPk('sample-a')).toJSON(), original)
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

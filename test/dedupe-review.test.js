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
const { summarizeBook } = require('../modules/audit/dedupe_analyzer.js')
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
const { stableId } = require('../modules/audit/utils.js')
const { loadDedupeDecisions, saveDedupeDecisions } = require('../modules/audit/dedupe_review_repository.js')

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

test('review members carry upload and file modification times from both audit paths', () => {
  const raw = { id: 'book-1', filepath: 'C:/fixture/book.zip', type: 'zip', mtime: '2026-10-08T01:02:03.000Z', posted: 1791417600 }
  const effective = { ...raw, posted: 1791504000 }
  const local = summarizeBook({ raw, effective, actual: { size: 100, mtimeMs: 1791507723000, mtime: '2026-10-09T01:02:03.000Z' } })
  assert.equal(local.posted, effective.posted)
  assert.equal(local.mtime, '2026-10-09T01:02:03.000Z')
  assert.equal(local.mtimeMs, 1791507723000)
  const ai = summarizeBook({ raw, effective })
  assert.equal(ai.posted, effective.posted)
  assert.equal(ai.mtime, raw.mtime)
  assert.equal(ai.mtimeMs, null)
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
  const items = report.groups.find(group => ['a', 'b'].every(id => group.items.some(item => item.id === id))).items
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

test('page containment enters the manual review queue with direct page evidence', async t => {
  const fixture = await fixtureFor(t, [
    { id: 'short', title: 'Short', entries: { '01.jpg': 'one', '02.jpg': 'two', '.ehviewer': marker } },
    { id: 'long', title: 'Compilation', entries: { '01.jpg': 'one', '02.jpg': 'two', '03.jpg': 'three', '.ehviewer': marker } }
  ])
  const report = await scan(fixture, { scanMode: 'full' })
  assert.equal(report.groups.length, 1)
  assert.deepEqual(report.groups[0].items.map(item => item.id), ['long', 'short'])
  assert.equal(report.groups[0].kind, 'coverage-review')
  assert.equal(report.groups[0].relations[0].contentRelation, 'left_contains_right')
  assert.equal(report.coverageRelations.length, 1)
  assert.equal(report.coverageRelations[0].verified, true)
  assert.equal(report.coverageRelations[0].matchedPages, 2)
})

test('a full scan finds partial page overlap without a title or source clue', async t => {
  const fixture = await fixtureFor(t, [
    { id: 'a', title: 'Unrelated first title', hash: null, url: '', tags: {}, entries: { '01.jpg': 'first', '02.jpg': 'shared-1', '03.jpg': 'shared-2' } },
    { id: 'a-copy', title: 'First title repacked', hash: null, url: '', tags: {}, comment: 'repacked', entries: { '01.jpg': 'first', '02.jpg': 'shared-1', '03.jpg': 'shared-2' } },
    { id: 'b', title: 'Other title', hash: null, url: '', tags: {}, entries: { '01.jpg': 'shared-1', '02.jpg': 'shared-2', '03.jpg': 'last' } }
  ])
  const report = await scan(fixture, { scanMode: 'full' })
  assert.ok(report.groups.every(group => group.items.length === 2))
  assert.ok(report.groups.some(group => group.reviewShape === 'whole-book' &&
    ['a', 'a-copy'].every(id => group.items.some(item => item.id === id))))
  const pairGroup = report.groups.find(group => group.reviewShape === 'direct-pair' &&
    ['a', 'b'].every(id => group.items.some(item => item.id === id)))
  const relation = pairGroup.relations.find(pair => pair.leftId === 'a' && pair.rightId === 'b')
  assert.ok(relation.sources.includes('page-overlap'))
  assert.equal(relation.contentRelation, 'overlap')
  assert.equal(relation.matchedPages, 2)
  assert.deepEqual([relation.leftUniquePages, relation.rightUniquePages], [1, 1])
  assert.equal(pairGroup.eligible, false)
})

test('shared translation pages do not join unrelated works into one review group', async t => {
  const credits = Object.fromEntries(Array.from({ length: 6 }, (_, index) =>
    [`${94 + index}.jpg`, `translation-group-page-${index}`]))
  const first = { '01.jpg': 'first-work-unique-page-one', '02.jpg': 'first-work-unique-page-two', ...credits }
  const second = { '01.jpg': 'second-work-page-one', '02.jpg': 'second-work-page-two', '03.jpg': 'second-work-page-three', ...credits }
  const third = { '01.jpg': 'third-work-page-one', '02.jpg': 'third-work-page-two', '03.jpg': 'third-work-page-three', '04.jpg': 'third-work-page-four', ...credits }
  const fixture = await fixtureFor(t, [
    { id: 'first', title: 'First work', hash: null, url: '', tags: {}, entries: first },
    { id: 'first-copy', title: 'First work copy', hash: null, url: '', tags: {}, entries: first, comment: 'repacked' },
    { id: 'second', title: 'Second work', hash: null, url: '', tags: {}, entries: second },
    { id: 'second-copy', title: 'Second work copy', hash: null, url: '', tags: {}, entries: second, comment: 'repacked' },
    { id: 'third', title: 'Third work', hash: null, url: '', tags: {}, entries: third }
  ])
  const report = await scan(fixture, { scanMode: 'full' })
  assert.deepEqual(report.groups.map(group => group.items.map(item => item.id).sort()).sort(),
    [['first', 'first-copy'], ['second', 'second-copy']])
  assert.ok(report.groups.every(group => group.relations.every(relation => relation.contentRelation === 'equal-pages')))
})

test('a consecutive story segment stays reviewable when several distinct books contain it', async t => {
  const story = Object.fromEntries(Array.from({ length: 10 }, (_, index) =>
    [`${String(index + 10).padStart(2, '0')}.jpg`, `shared-story-page-${index}`]))
  const fixture = await fixtureFor(t, [
    { id: 'magazine', title: 'Magazine issue', hash: null, url: '', tags: {}, entries: {
      '01.jpg': 'magazine-opening', '02.jpg': 'magazine-other-story', ...story, '99.jpg': 'magazine-ending' } },
    { id: 'collection-one', title: 'Collected work 1', hash: null, url: '', tags: {}, entries: {
      '01.jpg': 'collection-one-opening', ...story, '99.jpg': 'collection-one-ending' } },
    { id: 'collection-two', title: 'Collected work 2', hash: null, url: '', tags: {}, entries: {
      '01.jpg': 'collection-two-opening', ...story, '99.jpg': 'collection-two-ending' } }
  ])
  const report = await scan(fixture, { scanMode: 'full' })
  assert.equal(report.groups.length, 1)
  assert.equal(report.groups[0].items.length, 3)
  assert.ok(report.groups[0].relations.some(relation => relation.sources.includes('page-overlap') && relation.matchedPages === 10))
})

test('old grouping reports require a full rebuild while retaining existing AI candidate pairs', async t => {
  const fixture = await fixtureFor(t, [])
  const reportPath = path.join(fixture.root, 'old-dedupe-report.json')
  await fs.promises.writeFile(reportPath, JSON.stringify({ schemaVersion: 4, dedupeVersion: 2,
    dedupeRulesVersion: 5, reportType: 'dedupe', reportId: 'dedupe:old', groups: [] }))
  const previous = await new AuditReportRepository(fixture.root).getReport('dedupe', { latestReportPath: reportPath })
  assert.equal(previous.outdatedRules, true)
  assert.equal(previous.executable, false)
  previous.aiCandidatePairs = { semantic: [{ leftId: 'a', rightId: 'b' }], coverage: [] }
  const manager = { getReport: async () => previous, startWorker: async (_task, _worker, options) => options }
  const localOptions = await AuditWorkspaceManager.prototype.startDedupe.call(manager, { scanMode: 'full' })
  assert.deepEqual(localOptions.aiCandidatePairs, previous.aiCandidatePairs)
  const aiOptions = await AuditWorkspaceManager.prototype.startDedupe.call(manager,
    { candidatePairs: [{ leftId: 'c', rightId: 'd' }] })
  assert.equal(aiOptions.scope, 'library')
  assert.equal(aiOptions.scanMode, 'full')
  assert.equal(aiOptions.bookIds, undefined)
  assert.deepEqual(aiOptions.aiCandidatePairs, previous.aiCandidatePairs)
})

test('manual containment choice previews unique content and quarantines without merging unrelated state', async t => {
  const fixture = await fixtureFor(t, [
    { id: 'short', title: 'Work Ch.2', readCount: 2, entries: { '01.jpg': 'one', '02.jpg': 'two', '.ehviewer': marker } },
    { id: 'long', title: 'Work Ch.1-3', readCount: 8, mark: true, entries: { '01.jpg': 'one', '02.jpg': 'two', '03.jpg': 'three', '.ehviewer': marker } }
  ])
  const report = await scan(fixture, { scanMode: 'full' })
  const group = report.groups[0]
  const review = { reportId: report.reportId, decisions: { [group.id]: decisionFor(group, { long: 'short' }, true) },
    quarantineRoot: path.join(fixture.root, 'Quarantine') }
  const preview = buildExecutionPreview({ taskType: 'dedupe', report, review, library: fixture.library })
  const service = new DedupeReviewService({ manager: { getReport: async () => report, repository: new AuditReportRepository(fixture.root) } })
  await service.enrichExecutionPreview(preview)
  assert.equal(preview.files[0].mode, 'move')
  assert.equal(preview.files[0].matchedPages, 2)
  assert.equal(preview.files[0].uniquePages, 1)
  assert.equal(preview.files[0].collectionAction, 'remove')
  const executionId = 'containment-execution', executionDir = path.join(fixture.auditStorePath, 'executions', executionId)
  await fs.promises.mkdir(executionDir, { recursive: true })
  let collections
  const result = await executeApprovedDuplicates({ ...fixture, dedupeReport: report, dedupeReview: review, executionId, executionDir,
    collectionList: [{ id: 'c', list: ['sample-long'] }], saveCollectionList: async value => { collections = value },
    rendererState: { recentRead: [{ id: 'long' }, { id: 'short' }], viewerReadingProgress: [{ bookId: 'long', pageId: '03.jpg' }] } })
  const keeper = await fixture.Manga.findByPk('short')
  assert.equal(keeper.readCount, 2)
  assert.equal(keeper.mark, false)
  assert.equal(await fixture.Manga.findByPk('long'), null)
  assert.deepEqual(collections[0].list, [])
  assert.deepEqual(result.rendererState.recentRead.map(item => item.id), ['short'])
  assert.deepEqual(result.rendererState.viewerReadingProgress, [])
  assert.equal(result.movedCount, 1)
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

test('registered nested books allow parent review and use a split-folder execution plan', async t => {
  const entries = { '01.jpg': 'one', '02.jpg': 'two', 'nested/01.jpg': 'child', '.ehviewer': marker }
  const fixture = await fixtureFor(t, [{ id: 'a', type: 'folder', entries }, { id: 'b', type: 'folder', entries }])
  const before = await scan(fixture)
  await fixture.Manga.create({ id: 'child', hash: null, filepath: path.join(fixture.library, 'a', 'nested'), type: 'folder', title: 'Child', url: '', tags: {} })
  const after = await scan(fixture)
  const group = after.groups.find(group => group.items.some(item => item.id === 'a'))
  assert.ok(group.items.find(item => item.id === 'a').nestedBookIds.includes('child'))
  assert.notEqual(group.evidenceRevision, before.groups[0].evidenceRevision)
  const review = { reportId: after.reportId, decisions: { [group.id]: decisionFor(group, { a: 'b' }, true) }, quarantineRoot: path.join(fixture.root, 'Quarantine') }
  assert.doesNotThrow(() => normalizeDedupeReview(after, review))
  const preview = buildExecutionPreview({ taskType: 'dedupe', report: after, review, library: fixture.library,
    registeredBooks: await fixture.Manga.findAll({ attributes: ['id', 'filepath'], raw: true }) })
  assert.equal(preview.files.find(row => row.bookId === 'a').mode, 'split-folder')
  assert.ok(fs.existsSync(path.join(fixture.library, 'a', 'nested', '01.jpg')))
  const executionId = 'nested-execution', executionDir = path.join(fixture.auditStorePath, 'executions', executionId)
  await fs.promises.mkdir(executionDir, { recursive: true })
  const result = await executeApprovedDuplicates({ ...fixture, dedupeReport: after, dedupeReview: review, executionId, executionDir,
    collectionList: [], saveCollectionList: async () => {}, rendererState: {} })
  assert.ok(result.movedCount > 0)
  assert.equal(await fixture.Manga.findByPk('a'), null)
  assert.ok(await fixture.Manga.findByPk('child'))
  assert.ok(fs.existsSync(path.join(fixture.library, 'a', 'nested', '01.jpg')))
  assert.equal(fs.existsSync(path.join(fixture.library, 'a', '01.jpg')), false)
})

test('shared physical path can quarantine one record without moving the retained book', async t => {
  const fixture = await fixtureFor(t, [{ id: 'a' }])
  const original = await fixture.Manga.findByPk('a', { raw: true })
  await fixture.Manga.create({ ...original, id: 'same-path', hash: 'other-hash', tags: JSON.parse(original.tags) })
  const report = await scan(fixture)
  const group = report.groups[0]
  const review = { reportId: report.reportId, decisions: { [group.id]: decisionFor(group, { 'same-path': 'a' }, true) },
    quarantineRoot: path.join(fixture.root, 'Quarantine') }
  const preview = buildExecutionPreview({ taskType: 'dedupe', report, review, library: fixture.library,
    registeredBooks: await fixture.Manga.findAll({ attributes: ['id', 'filepath'], raw: true }) })
  assert.equal(preview.quarantineFileCount, 0)
  assert.equal(preview.recordOnlyCount, 1)
  assert.equal(preview.files[0].mode, 'record-only')
  const executionId = 'record-execution', executionDir = path.join(fixture.auditStorePath, 'executions', executionId)
  await fs.promises.mkdir(executionDir, { recursive: true })
  const result = await executeApprovedDuplicates({ ...fixture, dedupeReport: report, dedupeReview: review, executionId, executionDir,
    collectionList: [], saveCollectionList: async () => {}, rendererState: {} })
  assert.equal(result.movedCount, 0)
  assert.equal(result.recordOnlyCount, 1)
  assert.equal(await fixture.Manga.count(), 1)
  assert.ok(fs.existsSync(original.filepath))
})

test('two removed records sharing one archive move that archive only once', async t => {
  const fixture = await fixtureFor(t, [{ id: 'a' }, { id: 'b' }])
  const shared = await fixture.Manga.findByPk('b', { raw: true })
  await fixture.Manga.create({ ...shared, id: 'c', hash: 'third-hash', tags: JSON.parse(shared.tags) })
  const report = await scan(fixture, { scanMode: 'full' })
  const group = report.groups.find(entry => ['a', 'b', 'c'].every(id => entry.items.some(item => item.id === id)))
  assert.ok(group)
  const review = { reportId: report.reportId, decisions: { [group.id]: decisionFor(group, { b: 'a', c: 'a' }, true) },
    quarantineRoot: path.join(fixture.root, 'Quarantine') }
  const preview = buildExecutionPreview({ taskType: 'dedupe', report, review, library: fixture.library,
    registeredBooks: await fixture.Manga.findAll({ attributes: ['id', 'filepath'], raw: true }) })
  assert.deepEqual(preview.files.map(row => row.mode), ['move', 'shared-move'])
  assert.equal(preview.quarantineFileCount, 1)
  assert.equal(preview.recordOnlyCount, 1)
  assert.equal(preview.files[1].target, null)
  const executionId = 'shared-move-execution', executionDir = path.join(fixture.auditStorePath, 'executions', executionId)
  await fs.promises.mkdir(executionDir, { recursive: true })
  const result = await executeApprovedDuplicates({ ...fixture, dedupeReport: report, dedupeReview: review, executionId, executionDir,
    collectionList: [], saveCollectionList: async () => {}, rendererState: {} })
  assert.equal(result.movedCount, 1)
  assert.equal(result.recordOnlyCount, 1)
  assert.equal(await fixture.Manga.count(), 1)
  assert.equal(fs.existsSync(shared.filepath), false)
})

test('a manual decision on a daily weak candidate gets on-demand page comparison before execution', async t => {
  const fixture = await fixtureFor(t, [
    { id: 'a', title: 'First', hash: 'shared-sample', url: 'https://exhentai.org/g/123456/abcdef1234/', tags: {}, entries: { '01.jpg': 'one' } },
    { id: 'b', title: 'Second', hash: 'other-sample', url: 'https://exhentai.org/g/654321/abcdef1234/', tags: {}, entries: { '01.jpg': 'other', '02.jpg': 'two' } }
  ])
  await fixture.Manga.update({ hash: 'shared-sample' }, { where: { id: 'b' } })
  const report = await scan(fixture, { scanMode: 'daily' })
  const group = report.groups[0]
  assert.ok(group.items.every(item => !item.contentProof))
  const review = { reportId: report.reportId, decisions: { [group.id]: decisionFor(group, { b: 'a' }, true) },
    quarantineRoot: path.join(fixture.root, 'Quarantine') }
  const service = new DedupeReviewService({ manager: { getReport: async () => report, repository: new AuditReportRepository(fixture.root) } })
  const preview = buildExecutionPreview({ taskType: 'dedupe', report, review, library: fixture.library })
  await service.enrichExecutionPreview(preview)
  assert.equal(preview.files[0].matchedPages, 0)
  assert.equal(preview.files[0].uniquePages, 2)
  const executionId = 'weak-execution', executionDir = path.join(fixture.auditStorePath, 'executions', executionId)
  await fs.promises.mkdir(executionDir, { recursive: true })
  const result = await executeApprovedDuplicates({ ...fixture, dedupeReport: report, dedupeReview: review, executionId, executionDir,
    collectionList: [], saveCollectionList: async () => {}, rendererState: {} })
  assert.equal(result.movedCount, 1)
  assert.equal(await fixture.Manga.findByPk('b'), null)
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
  assert.equal(pathReport.groups[0].actionable, true)
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

test('unchanged old duplicate choices migrate to the new relation revision', async t => {
  const fixture = await fixtureFor(t, [{ id: 'a' }, { id: 'b' }])
  const report = await scan(fixture, { scanMode: 'full' })
  const group = report.groups[0]
  const previousRevision = stableId(4, group.items.map(item => [item.id, item.filepath, item.archiveSha256, item.contentProof,
    item.folderFingerprint, item.size, item.mtimeMs, item.sourceEvidence.fingerprint, item.metadataFingerprint,
    item.nestedBookIds.slice().sort()]))
  const previous = { disposition: 'not-duplicate', evidenceRevision: previousRevision, keepIds: group.items.map(item => item.id),
    quarantineToKeep: {}, reason: '', confirmedConflictCodes: [] }
  await saveDedupeDecisions(fixture.auditStorePath, { [group.id]: previous })
  const migrated = await loadDedupeDecisions(fixture.auditStorePath, report)
  assert.equal(migrated[group.id].disposition, 'not-duplicate')
  assert.equal(migrated[group.id].evidenceRevision, group.evidenceRevision)
  const joined = { ...report, groups: [{ ...group, relations: [...group.relations, { category: 'coverage' }] }] }
  assert.deepEqual(await loadDedupeDecisions(fixture.auditStorePath, joined), {})
})

test('unchanged decisions survive shared-page grouping revisions', async t => {
  const fixture = await fixtureFor(t, [{ id: 'a' }, { id: 'b', comment: 'repack' }])
  const report = await scan(fixture, { scanMode: 'full' })
  const group = report.groups[0]
  for (const version of [5, 6]) {
    const previousRevision = stableId(version, group.items.map(item => [item.id, item.filepath, item.archiveSha256, item.contentProof,
      item.folderFingerprint, item.size, item.mtimeMs, item.sourceEvidence.fingerprint, item.metadataFingerprint,
      item.nestedBookIds.slice().sort()]),
    group.relations.map(({ leftId, rightId, declaredRelation, contentRelation, matchedPages, leftPages, rightPages, sources }) =>
      [leftId, rightId, declaredRelation, contentRelation, matchedPages, leftPages, rightPages, sources]))
    const previous = { ...decisionFor(group, {}), evidenceRevision: previousRevision }
    await saveDedupeDecisions(fixture.auditStorePath, { [group.id]: previous })
    const migrated = await loadDedupeDecisions(fixture.auditStorePath, report)
    assert.equal(migrated[group.id].evidenceRevision, group.evidenceRevision)
    assert.deepEqual(migrated[group.id].keepIds, previous.keepIds)
  }
  const changed = { ...report, groups: [{ ...group, relations: [...group.relations, { category: 'coverage' }] }] }
  assert.deepEqual(await loadDedupeDecisions(fixture.auditStorePath, changed), {})
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

test('checkbox review saves one keeper and two removals without a target or mandatory reason', async t => {
  const fixture = await fixtureFor(t, [{ id: 'a' }, { id: 'b', comment: 'repack' },
    { id: 'c', entries: { '01.jpg': 'edition', '.ehviewer': marker } }])
  const report = await scan(fixture)
  const group = report.groups[0]
  const choice = { disposition: 'duplicate', selectionMode: 'checkbox', evidenceRevision: group.evidenceRevision, keepIds: ['a'] }
  const review = { reportId: report.reportId, decisions: { [group.id]: choice }, quarantineRoot: path.join(fixture.root, 'Quarantine') }
  const normalized = normalizeDedupeReview(report, review)
  assert.deepEqual(normalized.decisions[group.id].quarantineIds.sort(), ['b', 'c'])
  assert.deepEqual(normalized.decisions[group.id].quarantineToKeep, { b: 'a' })
  const repository = new AuditReportRepository(fixture.root)
  const state = { latestCompletedJobId: report.jobId, latestReportId: report.reportId }
  await repository.saveReview('dedupe', state, normalized)
  assert.deepEqual((await new AuditReportRepository(fixture.root).getReview('dedupe', state)).decisions[group.id].keepIds, ['a'])
  const preview = buildExecutionPreview({ taskType: 'dedupe', report, review, library: fixture.library })
  assert.equal(preview.files.length, 2)
  assert.equal(preview.manualReviewGroupCount, 1)
  assert.equal(preview.files.find(file => file.bookId === 'c').keepId, null)
  assert.equal(preview.files.find(file => file.bookId === 'c').referenceId, 'a')
  const executionId = 'checkbox-execution', executionDir = path.join(fixture.auditStorePath, 'executions', executionId)
  await fs.promises.mkdir(executionDir, { recursive: true })
  let savedCollections = null
  const result = await executeApprovedDuplicates({ ...fixture, dedupeReport: report, dedupeReview: review, executionId, executionDir,
    collectionList: [{ id: 'fixture', list: ['b', 'c'] }], saveCollectionList: async value => { savedCollections = value },
    rendererState: { recentRead: [{ id: 'b', read_time: 2 }, { id: 'c', read_time: 1 }] } })
  assert.equal(result.success, true)
  assert.deepEqual(savedCollections[0].list, [group.items.find(item => item.id === 'a').hash])
  assert.deepEqual(result.rendererState.recentRead.map(item => item.id), ['a'])
  assert.ok(await fixture.Manga.findByPk('a'))
  assert.equal(await fixture.Manga.findByPk('b'), null)
  assert.equal(await fixture.Manga.findByPk('c'), null)
})

test('checkbox review with several keepers leaves an unrelated removal without a merge target', async t => {
  const fixture = await fixtureFor(t, [{ id: 'a' }, { id: 'b', comment: 'repack' },
    { id: 'c', entries: { '01.jpg': 'edition', '.ehviewer': marker } }])
  const report = await scan(fixture)
  const group = report.groups[0]
  const review = { reportId: report.reportId, decisions: { [group.id]: { disposition: 'duplicate', selectionMode: 'checkbox',
    evidenceRevision: group.evidenceRevision, keepIds: ['a', 'b'] } }, quarantineRoot: path.join(fixture.root, 'Quarantine') }
  const preview = buildExecutionPreview({ taskType: 'dedupe', report, review, library: fixture.library })
  assert.equal(preview.files.length, 1)
  assert.equal(preview.files[0].bookId, 'c')
  assert.equal(preview.files[0].keepId, null)
  assert.equal(preview.files[0].referenceId, null)
  const enriched = await new DedupeReviewService({ manager: { getReport: async () => report } }).enrichExecutionPreview(preview)
  assert.equal(enriched.files[0].verified, false)
  assert.equal(enriched.files[0].uniquePages, null)
  assert.throws(() => normalizeDedupeReview(report, { ...review, decisions: { [group.id]: { ...review.decisions[group.id], keepIds: [] } } }), /INVALID_DUPLICATE_SELECTION/)
  assert.throws(() => normalizeDedupeReview(report, { ...review, decisions: { [group.id]: { ...review.decisions[group.id], keepIds: ['a', 'b', 'c'] } } }), /INVALID_DUPLICATE_SELECTION/)
  const executionId = 'checkbox-multiple-keepers', executionDir = path.join(fixture.auditStorePath, 'executions', executionId)
  await fs.promises.mkdir(executionDir, { recursive: true })
  const result = await executeApprovedDuplicates({ ...fixture, dedupeReport: report, dedupeReview: review, executionId, executionDir,
    collectionList: [], saveCollectionList: async () => {}, rendererState: {} })
  assert.equal(result.success, true)
  assert.ok(await fixture.Manga.findByPk('a'))
  assert.ok(await fixture.Manga.findByPk('b'))
  assert.equal(await fixture.Manga.findByPk('c'), null)
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

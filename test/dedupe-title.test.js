const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { parseTitleParts, parseBookSemantics, DEDUPE_RULES_VERSION } = require('../modules/audit/dedupe_title.js')
const { buildDuplicateGroups } = require('../modules/audit/dedupe_candidates.js')
const { AuditReportRepository } = require('../modules/audit/report_repository.js')
const { AuditWorkspaceManager } = require('../modules/audit/job_manager.js')
const { LibraryTaskCoordinator } = require('../modules/audit/task_coordinator.js')
const { createFixture, scan } = require('./fixtures/dedupe-fixture.cjs')

const book = (id, title, extra = {}) => ({ raw: { id, title, filepath: `C:/fixture/${id}.zip`, type: 'zip', url: '', hash: null, bundleSize: 100 },
  effective: { title, url: '', tags: { artist: ['same-artist'] } }, ...extra })

test('a short story magazine qualifier is published-in information, never a work volume or implied chapter one', () => {
  const title = '[ぐすたふ] 君は輝く月花のように (コミックメガストア Vol.13) [中国翻訳]'
  const semantic = parseBookSemantics(book('a', title))
  assert.equal(semantic.chapter, null)
  assert.equal(semantic.volume, null)
  assert.equal(semantic.publications[0].kind, 'embedded')
  assert.equal(semantic.publications[0].issue, '13')
  assert.deepEqual(semantic.languages, ['chinese'])
  const later = parseTitleParts('[ぐすたふ] 君は輝く月花のように 第3話 (コミックメガストア Vol.16) [中国翻訳]')
  assert.deepEqual(later.chapter, { start: 3, end: null })
  assert.equal(later.volume, null)
  assert.equal(later.publications[0].issue, '16')
  assert.notEqual(later.key, semantic.titles[0])
})

test('chapter notation and zero padding normalize while real volumes, ranges and dates stay distinct', () => {
  const variants = ['Title Ch.01', 'Title Chapter 1', 'Title 第1話', 'Title 第1话']
  assert.equal(new Set(variants.map(title => parseTitleParts(title).key)).size, 1)
  assert.notEqual(parseTitleParts('Title 第1話').key, parseTitleParts('Title 第2話').key)
  assert.notEqual(parseTitleParts('Title 第1話').key, parseTitleParts('Title 第1卷').key)
  assert.notEqual(parseTitleParts('Title').key, parseTitleParts('Title Ch.1').key)
  assert.deepEqual(parseTitleParts('Title Ch.1–3').chapter, { start: 1, end: 3 })
  assert.deepEqual(parseTitleParts('Title Vol.2').volume, { start: 2, end: null })
  assert.equal(parseTitleParts('Title 2023-08').chapter, null)
})

test('unknown parenthetical context is preserved and cannot supply work ordinals', () => {
  const parsed = parseTitleParts('Title (Unrecognized Publisher Vol.13)')
  assert.equal(parsed.volume, null)
  assert.deepEqual(parsed.qualifiers, ['Unrecognized Publisher Vol.13'])
  assert.notEqual(parsed.key, parseTitleParts('Title').key)
  assert.notEqual(parseTitleParts('Title (Subtitle A)').key, parseTitleParts('Title (Subtitle B)').key)
  const conflict = parseBookSemantics({ ...book('a', 'Title Ch.2'), raw: { ...book('a', '').raw, filepath: 'C:/fixture/Title Ch.3.zip' } })
  assert.equal(conflict.ordinalConflict, true)
})

test('different chapters and magazine issues do not enter a series-linked review group', () => {
  assert.deepEqual(buildDuplicateGroups([book('a', 'Title Ch.1'), book('b', 'Title Ch.2'), book('c', 'Title Ch.3')]), [])
  const groups = buildDuplicateGroups([book('a', 'Dascomi Vol.35 [Colorized]'), book('b', 'ダスコミ Vol.35 [DL版]'),
    book('c', 'Dascomi Vol.38'), book('d', 'Dascomi Vol.42')])
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].items.map(item => item.id), ['a', 'b'])
  assert.equal(groups[0].kind, 'version-review')
  assert.equal(groups[0].eligible, false)
  assert.ok(groups[0].reasons.some(reason => reason.code === 'publication-issue'))
  assert.ok(groups[0].reasons.every(reason => reason.code !== 'series-author'))
  assert.ok(groups[0].items[0].semantic.versions.includes('colorized'))
})

test('same chapter and work title survive notation and published-in differences without joining the next chapter', () => {
  const groups = buildDuplicateGroups([book('a', '[作者] Title Ch.01 (COMIC Test Vol.13)'),
    book('b', '[作者] Title 第1話 (COMIC Test Vol.99)'), book('c', '[作者] Title 第2話 (COMIC Test Vol.100)')])
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].items.map(item => item.id), ['a', 'b'])
  assert.equal(groups[0].reasons.some(reason => reason.code === 'title-author'), true)
  const dates = ['COMIC Test 2023年8月号', 'COMIC Test 2023-08', 'COMIC Test 2023年9月号'].map((title, index) => book(String(index), title))
  assert.deepEqual(buildDuplicateGroups(dates)[0].items.map(item => item.id), ['0', '1'])
})

test('actual content and archive copies remain candidates despite contradictory title numbers', () => {
  const inspection = { pageCount: 2, imageSignature: 'ordered', imageMultisetSignature: 'set', ancillarySignature: 'ancillary',
    images: [{ sha256: 'first', size: 10 }, { sha256: 'second', size: 20 }], ancillary: [], ehviewer: { status: 'missing' } }
  const groups = buildDuplicateGroups([book('a', 'Title Ch.1', { inspection }), book('b', 'Title Ch.2', { inspection })])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].kind, 'content-review')
  assert.ok(groups[0].reasons.some(reason => reason.code === 'image-content'))
  assert.equal(buildDuplicateGroups([book('a', 'Dascomi Vol.35', { archiveSha256: 'same' }), book('b', 'Dascomi Vol.38', { archiveSha256: 'same' })])[0].kind, 'exact-archive')
})

test('daily worker verifies same-issue editions without artist overlap and excludes other chapters and issues', async t => {
  const titles = ['Dascomi Vol.35 [Colorized]', 'ダスコミ Vol.35 [DL版]', 'Dascomi Vol.38', 'Title Ch.1', 'Title Ch.2']
  const fixture = await createFixture(titles.map((title, index) => ({ id: String(index), title, tags: {}, url: '', hash: null,
    entries: { '01.jpg': 'different'.repeat(index + 1) } })))
  t.after(fixture.cleanup)
  const report = await scan(fixture)
  assert.equal(report.dedupeRulesVersion, DEDUPE_RULES_VERSION)
  assert.equal(report.groups.length, 1)
  assert.deepEqual(report.groups[0].items.map(item => item.id), ['0', '1'])
  assert.ok(report.groups[0].items.every(item => item.contentProof))
})

test('old candidate reports are read-only and cannot be used as scoped verification bases', async t => {
  const fixture = await createFixture([{ id: 'a' }, { id: 'b' }]); t.after(fixture.cleanup)
  const repository = new AuditReportRepository(fixture.root)
  await repository.initialize()
  const report = await scan(fixture, {}, 'rules-current')
  const reportPath = path.join(fixture.auditStorePath, 'jobs', 'dedupe', report.jobId, 'report.json')
  const state = { latestCompletedJobId: report.jobId, latestReportId: report.reportId, latestReportPath: reportPath }
  assert.equal((await repository.getReport('dedupe', state)).executable, true)
  const oldRevision = require('../modules/audit/utils.js').stableId(report.groups[0].items.map(item => [item.id, item.filepath, item.archiveSha256, item.contentProof, item.folderFingerprint, item.size, item.mtimeMs, item.sourceEvidence.fingerprint, item.metadataFingerprint, item.nestedBookIds.slice().sort()]))
  assert.notEqual(oldRevision, report.groups[0].evidenceRevision)
  const oldReport = { ...report }; delete oldReport.dedupeRulesVersion
  await fs.promises.writeFile(reportPath, JSON.stringify(oldReport))
  const outdated = await new AuditReportRepository(fixture.root).getReport('dedupe', state)
  assert.equal(outdated.outdatedRules, true)
  assert.equal(outdated.executable, false)
  const decision = { disposition: 'duplicate', evidenceRevision: report.groups[0].evidenceRevision,
    keepIds: ['a'], quarantineToKeep: { b: 'a' }, reason: '', confirmedConflictCodes: [] }
  assert.throws(() => require('../modules/audit/review_validator.js').normalizeDedupeReview(outdated,
    { reportId: report.reportId, decisions: { [report.groups[0].id]: decision } }), /DEDUPE_REPORT_NOT_EXECUTABLE/)
  const manager = new AuditWorkspaceManager({ storePath: fixture.root, coordinator: new LibraryTaskCoordinator() })
  manager.getReport = async () => outdated
  await assert.rejects(manager.startDedupe({ reportId: report.reportId, groupIds: [report.groups[0].id] }), /DEDUPE_REVIEW_MISMATCH/)
})

test('daily and full workers retain repacked byte copies with missing old hashes and differing title numbers', async t => {
  const fixture = await createFixture([
    { id: 'a', title: 'Title Ch.1', url: '', hash: null, entries: { '01.jpg': 'first page', '02.jpg': 'last page' } },
    { id: 'b', title: 'Title Ch.2', url: '', hash: null, comment: 'repacked edition', entries: { 'renamed/001.jpg': 'first page', 'renamed/002.jpg': 'last page' } }
  ]); t.after(fixture.cleanup)
  for (const scanMode of ['daily', 'full']) {
    const report = await scan(fixture, { scanMode })
    assert.equal(report.groups.length, 1)
    assert.deepEqual(report.groups[0].items.map(item => item.id), ['a', 'b'])
    assert.ok(report.groups[0].items.every(item => item.contentProof))
    assert.equal(report.groups[0].kind, 'content-review')
    assert.ok(report.groups[0].reasons.every(reason => reason.code !== 'series-author'))
  }
})

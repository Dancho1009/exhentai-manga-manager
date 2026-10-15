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

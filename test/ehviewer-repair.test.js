const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const AdmZip = require('adm-zip')
const { prepareMangaModel, prepareMetadataModel } = require('../modules/database.js')
const { executeApprovedActions } = require('../modules/audit/action_executor.js')
const { inspectEhviewerIdentity } = require('../modules/audit/archive_inspector.js')
const {
  buildEhviewerVersion2Buffer,
  getEhviewerRepairSupport,
  normalizeEhviewerIdentity,
  prepareEhviewerRepair
} = require('../modules/audit/ehviewer_repair.js')

const makeInvalidArchive = () => {
  const zip = new AdmZip()
  zip.addFile('001.jpg', Buffer.from('image-content'))
  zip.addFile('.ehviewer', Buffer.from('this is not an ehviewer record'))
  zip.addFile('note.txt', Buffer.from('keep this ancillary file'))
  return zip.toBuffer()
}

const readZipEntry = (filepath, entryName) => new AdmZip(filepath).getEntry(entryName).getData()

test('VERSION2 recovery builder rejects invalid identities and produces parser-compatible bytes', async () => {
  const buffer = buildEhviewerVersion2Buffer({ title: 'Title\nwith line break', gid: '3865827', token: '75BE22627A' })
  assert.equal(buffer.toString('utf8'), 'VERSION2\nTitle with line break\n3865827\n75be22627a\n')
  assert.deepEqual(require('../fileLoader/ehviewer.js').readEhviewerBuffer(buffer), { gid: '3865827', token: '75be22627a' })
  assert.throws(() => buildEhviewerVersion2Buffer({ title: 'Title', gid: 'x', token: 'bad' }), /EHVIEWER_RECOVERY_METADATA_INVALID/)
})

test('empty ehviewer identities are ignored during audit normalization', () => {
  assert.equal(normalizeEhviewerIdentity(null), null)
  assert.equal(normalizeEhviewerIdentity(undefined), null)
  assert.deepEqual(normalizeEhviewerIdentity({ gid: '3865827', token: '75BE22627A' }), {
    gid: '3865827',
    token: '75be22627a'
  })
})

test('ZIP repair preserves every non-ehviewer entry and retains a verified original backup', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ehviewer-zip-repair-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const filepath = path.join(root, 'book.zip')
  const backupDir = path.join(root, 'backup')
  await fs.promises.writeFile(filepath, makeInvalidArchive())
  const beforeImage = readZipEntry(filepath, '001.jpg')
  const beforeNote = readZipEntry(filepath, 'note.txt')
  const action = {
    type: 'repair-ehviewer',
    bookType: 'zip',
    bookId: 'zip-book',
    filepath,
    entryPath: '.ehviewer',
    expectedTitle: 'Recovered title',
    identity: { gid: '3865827', token: '75be22627a' }
  }

  const repair = await prepareEhviewerRepair({ action, backupDir })
  await repair.apply()
  assert.deepEqual(await inspectEhviewerIdentity({ filepath, type: 'zip' }), {
    status: 'parsed',
    format: 'version2',
    entryPath: '.ehviewer',
    candidateCount: 1,
    gid: '3865827',
    token: '75be22627a'
  })
  assert.deepEqual(readZipEntry(filepath, '001.jpg'), beforeImage)
  assert.deepEqual(readZipEntry(filepath, 'note.txt'), beforeNote)
  assert.equal(readZipEntry(repair.backupPath, '.ehviewer').toString('utf8'), 'this is not an ehviewer record')
  await repair.finalize()
})

test('folder repair can be rolled back without changing the original marker', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ehviewer-folder-repair-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const folderpath = path.join(root, 'book')
  await fs.promises.mkdir(folderpath)
  await fs.promises.writeFile(path.join(folderpath, '001.jpg'), 'image')
  await fs.promises.writeFile(path.join(folderpath, '.ehviewer'), 'invalid marker')
  const repair = await prepareEhviewerRepair({
    action: {
      type: 'repair-ehviewer',
      bookType: 'folder',
      bookId: 'folder-book',
      filepath: folderpath,
      entryPath: '.ehviewer',
      expectedTitle: 'Recovered folder title',
      identity: { gid: '123456', token: 'abcdef1234' }
    },
    backupDir: path.join(root, 'backup')
  })
  await repair.apply()
  assert.deepEqual(await inspectEhviewerIdentity({ filepath: folderpath, type: 'folder' }), {
    status: 'parsed',
    format: 'version2',
    entryPath: '.ehviewer',
    candidateCount: 1,
    gid: '123456',
    token: 'abcdef1234'
  })
  assert.equal((await repair.snapshot()).bundleSize, Buffer.byteLength('image') + Buffer.byteLength('VERSION2\nRecovered folder title\n123456\nabcdef1234\n'))
  await repair.rollback()
  assert.equal(await fs.promises.readFile(path.join(folderpath, '.ehviewer'), 'utf8'), 'invalid marker')
})

test('RAR and 7z-family repairs remain report-only', () => {
  for (const extension of ['.rar', '.cbr', '.7z', '.cb7']) {
    assert.deepEqual(getEhviewerRepairSupport({ filepath: `book${extension}`, type: 'archive' }), {
      supported: false,
      format: extension.slice(1),
      reason: 'EHVIEWER_REPAIR_ARCHIVE_UNSUPPORTED'
    })
  }
})

test('approved ehviewer repair rolls back on transaction failure and only updates local file stats on success', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ehviewer-execution-'))
  const library = path.join(root, 'Library')
  const auditStorePath = path.join(root, 'audit')
  const executionDir = path.join(auditStorePath, 'executions', 'repair-ehviewer')
  await Promise.all([fs.promises.mkdir(library, { recursive: true }), fs.promises.mkdir(executionDir, { recursive: true })])
  const filepath = path.join(library, 'book.zip')
  await fs.promises.writeFile(filepath, makeInvalidArchive())
  const original = await fs.promises.readFile(filepath)
  const stat = await fs.promises.stat(filepath)
  const databasePath = path.join(root, 'database.sqlite')
  const metadataPath = path.join(root, 'metadata.sqlite')
  const Manga = prepareMangaModel(databasePath)
  const Metadata = prepareMetadataModel(metadataPath)
  t.after(async () => {
    await Promise.all([Manga.sequelize.close(), Metadata.sequelize.close()])
    await fs.promises.rm(root, { recursive: true, force: true })
  })
  await Promise.all([Manga.sync(), Metadata.sync()])
  const url = 'https://exhentai.org/g/3865827/75be22627a/'
  await Manga.create({ id: 'repair-book', title: 'Local title', hash: 'repair-hash', filepath, type: 'zip', pageCount: 1, bundleSize: stat.size, mtime: stat.mtime.toISOString(), coverHash: 'cover', status: 'tagged', url, readCount: 7, mark: true })
  await Metadata.create({ hash: 'repair-hash', title: 'Current metadata title', status: 'tagged', url, tags: { artist: ['artist'] } })
  const anomaly = {
    id: 'invalid-ehviewer',
    type: 'ehviewer-invalid',
    action: {
      type: 'repair-ehviewer',
      repairKind: 'ehviewer-rebuild-from-current-metadata',
      bookType: 'zip',
      bookId: 'repair-book',
      filepath,
      entryPath: '.ehviewer',
      expectedSize: stat.size,
      expectedMtimeMs: stat.mtimeMs,
      currentUrl: url,
      expectedTitle: 'Current metadata title',
      identity: { gid: '3865827', token: '75be22627a' }
    }
  }
  const reportId = 'anomaly:ehviewer-repair'
  const common = {
    taskType: 'anomaly',
    anomalyReport: { reportId, executable: true, anomalies: [anomaly] },
    anomalyReview: { reportId, actionIds: [anomaly.id] },
    executionId: 'repair-ehviewer',
    executionDir,
    auditStorePath,
    Manga,
    Metadata,
    databasePath,
    metadataPath,
    collectionList: [],
    rendererState: {},
    verifyRepairAction: async () => ({ valid: true })
  }

  await assert.rejects(executeApprovedActions({
    ...common,
    setProgress: async state => {
      if (state.phase === 'writing-metadata' && state.completed === 1) throw new Error('TEST_TRANSACTION_FAILURE')
    }
  }), /TEST_TRANSACTION_FAILURE/)
  assert.deepEqual(await fs.promises.readFile(filepath), original)
  assert.equal((await Manga.findByPk('repair-book')).bundleSize, stat.size)

  const result = await executeApprovedActions({ ...common, executionId: 'repair-ehviewer-success' })
  const repairedBook = await Manga.findByPk('repair-book')
  const sharedMetadata = await Metadata.findByPk('repair-hash')
  assert.equal(result.repairedCount, 1)
  assert.deepEqual(await inspectEhviewerIdentity({ filepath, type: 'zip' }), {
    status: 'parsed',
    format: 'version2',
    entryPath: '.ehviewer',
    candidateCount: 1,
    gid: '3865827',
    token: '75be22627a'
  })
  assert.equal(repairedBook.url, url)
  assert.equal(repairedBook.readCount, 7)
  assert.equal(repairedBook.mark, true)
  assert.equal(sharedMetadata.title, 'Current metadata title')
  assert.deepEqual(sharedMetadata.tags, { artist: ['artist'] })
  assert.equal(repairedBook.bundleSize, (await fs.promises.stat(filepath)).size)
})

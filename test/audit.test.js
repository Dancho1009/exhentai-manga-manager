const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Worker } = require('worker_threads')
const AdmZip = require('adm-zip')
const sqlite3 = require('sqlite3')
const { open } = require('sqlite')
const { LibraryTaskCoordinator } = require('../modules/audit/task_coordinator.js')
const { inspectBookContent } = require('../modules/audit/archive_inspector.js')
const { executeApprovedActions } = require('../modules/audit/action_executor.js')
const { prepareMangaModel, prepareMetadataModel } = require('../modules/database.js')

const createDatabases = async (root, books) => {
  const databasePath = path.join(root, 'database.sqlite')
  const metadataPath = path.join(root, 'metadata.sqlite')
  const database = await open({ filename: databasePath, driver: sqlite3.Database })
  const metadata = await open({ filename: metadataPath, driver: sqlite3.Database })
  await database.exec(`
    CREATE TABLE Mangas (
      id TEXT PRIMARY KEY, title TEXT, coverPath TEXT, hash TEXT, filepath TEXT, type TEXT,
      pageCount INTEGER, bundleSize INTEGER, mtime TEXT, coverHash TEXT, status TEXT,
      date INTEGER, rating REAL, tags TEXT, title_jpn TEXT, filecount INTEGER,
      posted INTEGER, filesize INTEGER, category TEXT, url TEXT, mark INTEGER,
      hiddenBook INTEGER, readCount INTEGER, exist INTEGER
    )
  `)
  await metadata.exec(`
    CREATE TABLE Metadata (
      hash TEXT PRIMARY KEY, title TEXT, status TEXT, rating REAL, tags TEXT,
      title_jpn TEXT, filecount INTEGER, posted INTEGER, filesize INTEGER,
      category TEXT, url TEXT, mark INTEGER
    )
  `)
  for (const book of books) {
    await database.run(`
      INSERT INTO Mangas(id, title, coverPath, hash, filepath, type, pageCount, bundleSize, mtime,
        coverHash, status, date, tags, filecount, category, url, mark, hiddenBook, readCount, exist)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 1)
    `, [book.id, book.title, book.coverPath || '', book.hash, book.filepath, 'zip', book.pageCount, book.bundleSize,
      book.mtime, book.coverHash, 'tagged', Date.now(), '{}', book.filecount, 'Doujinshi', book.url])
    await metadata.run(`
      INSERT OR REPLACE INTO Metadata(hash, title, status, tags, filecount, category, url, mark)
      VALUES (?, ?, 'tagged', '{}', ?, 'Doujinshi', ?, 0)
    `, [book.hash, book.title, book.filecount, book.url])
  }
  await database.close()
  await metadata.close()
  return { databasePath, metadataPath }
}

const runAuditWorker = ({ jobId, jobDir, options }) => new Promise((resolve, reject) => {
  const worker = new Worker(path.join(__dirname, '../modules/audit/audit_worker.js'), {
    workerData: { jobId, jobDir, options }
  })
  worker.on('message', message => {
    if (message.type === 'completed') resolve(message)
    if (message.type === 'failed') reject(new Error(message.error))
  })
  worker.on('error', reject)
})

const makeArchiveBuffer = () => {
  const zip = new AdmZip()
  zip.addFile('001.jpg', Buffer.from('image-one'))
  zip.addFile('.ehviewer', Buffer.from('VERSION2\nname\n123456\nabcdef1234\n'))
  return zip.toBuffer()
}

test('task coordinator blocks mutations while an audit owns the library', async () => {
  const coordinator = new LibraryTaskCoordinator()
  coordinator.beginAudit('job-1')
  assert.throws(() => coordinator.assertWritable(), /LIBRARY_AUDIT_LOCKED/)
  assert.doesNotThrow(() => coordinator.assertWritable('job-1'))
  coordinator.endAudit('job-1')
  await assert.doesNotReject(() => coordinator.runMutation('save', async () => true))
})

test('zip inspector streams images and parses VERSION2 ehviewer data', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-inspector-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const filepath = path.join(root, '123456-sample.zip')
  await fs.promises.writeFile(filepath, makeArchiveBuffer())
  const inspection = await inspectBookContent({ filepath, type: 'zip' })
  assert.equal(inspection.pageCount, 1)
  assert.equal(inspection.ehviewer.status, 'parsed')
  assert.equal(inspection.ehviewer.gid, '123456')
  assert.equal(inspection.ehviewer.token, 'abcdef1234')
})

test('quick worker reports stale rows and untracked archives without modifying inputs', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-quick-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const library = path.join(root, 'Library')
  const auditStorePath = path.join(root, 'audit')
  const jobDir = path.join(auditStorePath, 'jobs', 'quick-job')
  await fs.promises.mkdir(jobDir, { recursive: true })
  const archive = path.join(library, '123456-sample.zip')
  const untracked = path.join(library, '654321-untracked.zip')
  await fs.promises.mkdir(library, { recursive: true })
  const buffer = makeArchiveBuffer()
  await Promise.all([fs.promises.writeFile(archive, buffer), fs.promises.writeFile(untracked, buffer)])
  const stat = await fs.promises.stat(archive)
  const databases = await createDatabases(root, [{
    id: 'book-1', title: 'sample', hash: 'target-hash', coverHash: 'cover-hash', filepath: archive,
    pageCount: 1, bundleSize: stat.size + 10, mtime: stat.mtime.toISOString(), filecount: 1,
    url: 'https://exhentai.org/g/123456/abcdef1234/'
  }])
  const before = await fs.promises.readFile(archive)
  const result = await runAuditWorker({
    jobId: 'quick-job', jobDir,
    options: { mode: 'quick', deepScope: 'anomalies', library, auditStorePath, ...databases }
  })
  const report = JSON.parse(await fs.promises.readFile(result.reportPath, 'utf8'))
  assert.ok(report.anomalies.some(item => item.type === 'scan-stale-size'))
  assert.ok(report.anomalies.some(item => item.type === 'library-file-untracked'))
  assert.deepEqual(await fs.promises.readFile(archive), before)
})

test('deep worker proves byte-identical archives with full sha256', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-deep-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const library = path.join(root, 'Library')
  const auditStorePath = path.join(root, 'audit')
  const jobDir = path.join(auditStorePath, 'jobs', 'deep-job')
  await fs.promises.mkdir(jobDir, { recursive: true })
  await fs.promises.mkdir(library, { recursive: true })
  const buffer = makeArchiveBuffer()
  const first = path.join(library, '123456-first.zip')
  const second = path.join(library, '123456-second.zip')
  await Promise.all([fs.promises.writeFile(first, buffer), fs.promises.writeFile(second, buffer)])
  const [firstStat, secondStat] = await Promise.all([fs.promises.stat(first), fs.promises.stat(second)])
  const databases = await createDatabases(root, [
    { id: 'book-1', title: 'first', hash: 'target-hash', coverHash: 'cover-hash', filepath: first, pageCount: 1, bundleSize: firstStat.size, mtime: firstStat.mtime.toISOString(), filecount: 1, url: 'https://exhentai.org/g/123456/abcdef1234/' },
    { id: 'book-2', title: 'second', hash: 'target-hash', coverHash: 'cover-hash', filepath: second, pageCount: 1, bundleSize: secondStat.size, mtime: secondStat.mtime.toISOString(), filecount: 1, url: 'https://exhentai.org/g/123456/abcdef1234/' }
  ])
  const result = await runAuditWorker({
    jobId: 'deep-job', jobDir,
    options: { mode: 'deep', deepScope: 'anomalies', library, auditStorePath, sevenZipPath: null, ...databases }
  })
  const report = JSON.parse(await fs.promises.readFile(result.reportPath, 'utf8'))
  const exact = report.duplicates.find(group => group.kind === 'exact-archive')
  assert.ok(exact)
  assert.equal(exact.eligible, true)
  assert.equal(exact.items.length, 2)
  assert.match(exact.evidence.sha256, /^[a-f0-9]{64}$/)
})

test('approved duplicate execution quarantines one file and preserves merged user state', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-execute-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const library = path.join(root, 'Library')
  const quarantineRoot = path.join(root, 'DedupeReview')
  const auditStore = path.join(root, 'audit')
  const jobId = 'execution-job'
  const jobDir = path.join(auditStore, 'jobs', jobId)
  await fs.promises.mkdir(jobDir, { recursive: true })
  await fs.promises.mkdir(library, { recursive: true })
  const first = path.join(library, '123456-first.zip')
  const second = path.join(library, '123456-second.zip')
  const buffer = makeArchiveBuffer()
  await Promise.all([fs.promises.writeFile(first, buffer), fs.promises.writeFile(second, buffer)])
  const [firstStat, secondStat] = await Promise.all([fs.promises.stat(first), fs.promises.stat(second)])

  const databasePath = path.join(root, 'database.sqlite')
  const metadataPath = path.join(root, 'metadata.sqlite')
  const Manga = prepareMangaModel(databasePath)
  const Metadata = prepareMetadataModel(metadataPath)
  await Promise.all([Manga.sync(), Metadata.sync()])
  await Manga.bulkCreate([
    { id: 'keep', title: 'keep', hash: 'hash-keep', filepath: first, type: 'zip', pageCount: 1, bundleSize: firstStat.size, mtime: firstStat.mtime.toISOString(), coverHash: 'cover', status: 'tagged', url: 'https://exhentai.org/g/123456/abcdef1234/', readCount: 2, mark: false, hiddenBook: true },
    { id: 'remove', title: 'remove', hash: 'hash-remove', filepath: second, type: 'zip', pageCount: 1, bundleSize: secondStat.size, mtime: secondStat.mtime.toISOString(), coverHash: 'cover', status: 'tagged', url: 'https://exhentai.org/g/123456/abcdef1234/', readCount: 7, mark: true, hiddenBook: false }
  ])
  await Metadata.bulkCreate([
    { hash: 'hash-keep', title: 'keep', status: 'tagged', url: 'https://exhentai.org/g/123456/abcdef1234/' },
    { hash: 'hash-remove', title: 'remove', status: 'tagged', url: 'https://exhentai.org/g/123456/abcdef1234/' }
  ])

  const report = {
    jobId,
    anomalies: [],
    duplicates: [{
      id: 'group-1', kind: 'exact-archive', eligible: true,
      items: [
        { id: 'keep', filepath: first, hash: 'hash-keep', size: firstStat.size, mtimeMs: firstStat.mtimeMs },
        { id: 'remove', filepath: second, hash: 'hash-remove', size: secondStat.size, mtimeMs: secondStat.mtimeMs }
      ]
    }]
  }
  const review = { jobId, anomalyActionIds: [], duplicateSelections: { 'group-1': { keepId: 'keep', quarantineIds: ['remove'] } } }
  const states = []
  const jobManager = {
    storePath: auditStore,
    jobsPath: path.join(auditStore, 'jobs'),
    getReport: async () => report,
    getReview: async () => review,
    setState: async state => states.push(state)
  }
  const coordinator = new LibraryTaskCoordinator()
  let savedCollections
  const result = await executeApprovedActions({
    jobManager, coordinator, Manga, Metadata, databasePath, metadataPath,
    collectionList: [{ id: 'collection', title: 'test', list: ['hash-remove'] }],
    saveCollectionList: async value => { savedCollections = JSON.parse(JSON.stringify(value)) },
    library, quarantineRoot,
    rendererState: {
      recentRead: [{ id: 'remove', read_time: 100 }],
      viewerReadingProgress: [{ bookId: 'remove', pageId: '001.jpg' }]
    }
  })

  assert.equal(await Manga.count(), 1)
  const keeper = await Manga.findByPk('keep')
  assert.equal(keeper.readCount, 7)
  assert.equal(keeper.mark, true)
  assert.equal(keeper.hiddenBook, false)
  assert.equal(await fs.promises.stat(first).then(() => true), true)
  await assert.rejects(fs.promises.stat(second), error => error.code === 'ENOENT')
  const quarantined = path.join(quarantineRoot, jobId, path.basename(second))
  assert.equal(await fs.promises.stat(quarantined).then(() => true), true)
  assert.deepEqual(savedCollections[0].list, ['hash-keep'])
  assert.equal(result.rendererState.recentRead[0].id, 'keep')
  assert.equal(result.rendererState.viewerReadingProgress[0].bookId, 'keep')
  assert.ok(states.some(state => state.phase === 'verified'))
  await Promise.all([Manga.sequelize.close(), Metadata.sequelize.close()])
})

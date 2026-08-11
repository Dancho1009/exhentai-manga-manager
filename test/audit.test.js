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
const { AuditJobManager } = require('../modules/audit/job_manager.js')
const { AuditCache } = require('../modules/audit/cache.js')
const { atomicWriteJson } = require('../modules/audit/utils.js')
const { inspectBookContent, inspectEhviewerIdentity } = require('../modules/audit/archive_inspector.js')
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

const runAuditWorker = ({ jobId, jobDir, options, onMessage = () => {} }) => new Promise((resolve, reject) => {
  const worker = new Worker(path.join(__dirname, '../modules/audit/audit_worker.js'), {
    workerData: { jobId, jobDir, options }
  })
  let completedMessage = null
  worker.on('message', message => {
    onMessage(message)
    if (message.type === 'completed') completedMessage = message
    if (message.type === 'failed') reject(new Error(message.error))
  })
  worker.on('error', reject)
  worker.on('exit', code => {
    if (code !== 0) return reject(new Error(`Audit worker exited with code ${code}`))
    if (!completedMessage) return reject(new Error('Audit worker exited without a completed message'))
    resolve(completedMessage)
  })
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

test('atomic JSON writes use independent temporary files under concurrency', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-atomic-json-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const filepath = path.join(root, 'state.json')
  await Promise.all(Array.from({ length: 40 }, (_, index) => atomicWriteJson(filepath, { index })))
  const value = JSON.parse(await fs.promises.readFile(filepath, 'utf8'))
  assert.equal(Number.isInteger(value.index), true)
  assert.equal((await fs.promises.readdir(root)).some(name => name.endsWith('.tmp')), false)
})

test('audit state updates are serialized and persist the latest patch', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-state-queue-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const manager = new AuditJobManager({ storePath: root, coordinator: new LibraryTaskCoordinator() })
  manager.state = { ...manager.state, jobId: 'queued-job', status: 'running' }
  await Promise.all(Array.from({ length: 50 }, (_, index) => manager.setState({ completed: index, phase: `phase-${index}` })))
  const statePath = path.join(root, 'audit', 'jobs', 'queued-job', 'state.json')
  const persisted = JSON.parse(await fs.promises.readFile(statePath, 'utf8'))
  assert.equal(persisted.completed, 49)
  assert.equal(persisted.phase, 'phase-49')
  assert.equal(manager.getState().completed, 49)
})

test('audit progress updates are throttled and flush the latest value', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-progress-throttle-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const manager = new AuditJobManager({ storePath: root, coordinator: new LibraryTaskCoordinator() })
  manager.progressIntervalMs = 1000
  manager.state = { ...manager.state, jobId: 'progress-job', status: 'running' }
  let emittedStates = 0
  manager.on('state', () => { emittedStates += 1 })

  for (let index = 0; index < 100; index += 1) {
    manager.queueProgress({ completed: index, total: 100, phase: `phase-${index}` })
  }
  await manager.flushProgress()

  const statePath = path.join(root, 'audit', 'jobs', 'progress-job', 'state.json')
  const persisted = JSON.parse(await fs.promises.readFile(statePath, 'utf8'))
  assert.equal(persisted.completed, 99)
  assert.equal(persisted.phase, 'phase-99')
  assert.equal(manager.getState().completed, 99)
  assert.equal(emittedStates, 1)
})

test('audit manager keeps the previous report readable while a new task is running', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-previous-report-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const reportPath = path.join(root, 'previous-report.json')
  const previousReport = { jobId: 'previous-job', summary: { anomalies: 12 }, anomalies: [], duplicates: [] }
  await atomicWriteJson(reportPath, previousReport)
  const manager = new AuditJobManager({ storePath: root, coordinator: new LibraryTaskCoordinator() })
  manager.state = {
    ...manager.state,
    jobId: 'running-job',
    status: 'running',
    reportPath: null,
    previousReportPath: reportPath
  }
  assert.deepEqual(await manager.getReport(), previousReport)
})

test('audit manager reuses an unchanged parsed report and refreshes changed files', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-report-cache-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const reportPath = path.join(root, 'report.json')
  await atomicWriteJson(reportPath, { jobId: 'cached-job', anomalies: [] })
  const manager = new AuditJobManager({ storePath: root, coordinator: new LibraryTaskCoordinator() })
  manager.state = { ...manager.state, jobId: 'cached-job', reportPath }

  const first = await manager.getReport()
  const second = await manager.getReport()
  assert.strictEqual(second, first)

  await atomicWriteJson(reportPath, { jobId: 'cached-job', anomalies: [{ id: 'changed' }] })
  const changed = await manager.getReport()
  assert.notStrictEqual(changed, first)
  assert.equal(changed.anomalies[0].id, 'changed')
})

test('audit cache migrates and preserves lightweight ehviewer inspections independently', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-cache-'))
  let cache
  t.after(async () => {
    if (cache) await cache.close()
    await fs.promises.rm(root, { recursive: true, force: true })
  })
  const database = await open({ filename: path.join(root, 'audit-cache.sqlite'), driver: sqlite3.Database })
  await database.exec(`
    CREATE TABLE cache_entries (
      filepath TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      mtimeMs REAL NOT NULL,
      version INTEGER NOT NULL,
      archiveSha256 TEXT,
      inspection TEXT
    )
  `)
  await database.close()

  cache = await AuditCache.open(root)
  const book = { filepath: path.join(root, 'sample.zip') }
  const stat = { size: 123, mtimeMs: 456 }
  await cache.update(book, stat, { inspection: { pageCount: 10 } })
  await cache.update(book, stat, {
    ehviewerInspection: { status: 'parsed', gid: '123456', token: 'abcdef1234' }
  })

  const cached = await cache.get(book, stat)
  assert.deepEqual(cached.inspection, { pageCount: 10 })
  assert.deepEqual(cached.ehviewerInspection, { status: 'parsed', gid: '123456', token: 'abcdef1234' })
  assert.equal(await cache.get(book, { ...stat, size: 124 }), null)
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
  const lightweight = await inspectEhviewerIdentity({ filepath, type: 'zip' })
  assert.equal(lightweight.status, 'parsed')
  assert.equal(lightweight.gid, '123456')
  assert.equal(lightweight.token, 'abcdef1234')
})

test('lightweight ehviewer inspection marks multiple candidates as ambiguous', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-ambiguous-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const filepath = path.join(root, 'ambiguous.zip')
  const zip = new AdmZip()
  zip.addFile('.ehviewer', Buffer.from('VERSION2\nname\n123456\nabcdef1234\n'))
  zip.addFile('nested/.ehviewer', Buffer.from('VERSION2\nname\n654321\nfedcba4321\n'))
  await fs.promises.writeFile(filepath, zip.toBuffer())
  const result = await inspectEhviewerIdentity({ filepath, type: 'zip' })
  assert.equal(result.status, 'ambiguous')
  assert.equal(result.candidateCount, 2)
  assert.equal(result.entryPath, '.ehviewer')
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
  assert.equal(report.summary.anomalyBooks, 1)
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

test('targeted online worker only inspects requested conflict books', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-online-targets-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const library = path.join(root, 'Library')
  const auditStorePath = path.join(root, 'audit')
  const jobDir = path.join(auditStorePath, 'jobs', 'online-target-job')
  await Promise.all([
    fs.promises.mkdir(jobDir, { recursive: true }),
    fs.promises.mkdir(library, { recursive: true })
  ])
  const first = path.join(library, '123456-first.zip')
  const second = path.join(library, '123456-second.zip')
  await Promise.all([
    fs.promises.writeFile(first, makeArchiveBuffer()),
    fs.promises.writeFile(second, makeArchiveBuffer())
  ])
  const [firstStat, secondStat] = await Promise.all([fs.promises.stat(first), fs.promises.stat(second)])
  const databases = await createDatabases(root, [
    { id: 'book-1', title: 'first', hash: 'hash-1', coverHash: 'cover-1', filepath: first, pageCount: 1, bundleSize: firstStat.size, mtime: firstStat.mtime.toISOString(), filecount: 1, url: 'https://exhentai.org/g/123456/abcdef1234/' },
    { id: 'book-2', title: 'second', hash: 'hash-2', coverHash: 'cover-2', filepath: second, pageCount: 1, bundleSize: secondStat.size, mtime: secondStat.mtime.toISOString(), filecount: 1, url: 'https://exhentai.org/g/123456/abcdef1234/' }
  ])
  const progress = []
  const result = await runAuditWorker({
    jobId: 'online-target-job',
    jobDir,
    options: {
      mode: 'online',
      onlineScope: 'conflicts',
      onlineBookIds: ['book-2'],
      library,
      auditStorePath,
      sevenZipPath: null,
      ehentaiSetting: {},
      ...databases
    },
    onMessage: message => {
      if (message.type === 'progress' && message.phase === 'reading-ehviewer-identities') progress.push(message)
    }
  })
  const report = JSON.parse(await fs.promises.readFile(result.reportPath, 'utf8'))
  assert.equal(progress.at(-1)?.total, 1)
  assert.equal(progress.at(-1)?.completed, 1)
  assert.equal(report.summary.onlineIdentities, 0)
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

test('repair-url execution revalidates availability before atomically replacing metadata', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-repair-'))
  const library = path.join(root, 'Library')
  const auditStore = path.join(root, 'audit')
  const jobId = 'repair-job'
  const jobDir = path.join(auditStore, 'jobs', jobId)
  const quarantineRoot = path.join(root, 'DedupeReview')
  await Promise.all([
    fs.promises.mkdir(library, { recursive: true }),
    fs.promises.mkdir(jobDir, { recursive: true })
  ])
  const filepath = path.join(library, 'book.zip')
  await fs.promises.writeFile(filepath, makeArchiveBuffer())
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
  const oldUrl = 'https://exhentai.org/g/111111/oldtoken/'
  const newUrl = 'https://e-hentai.org/g/222222/newtoken/'
  await Manga.create({
    id: 'repair-book', title: 'Old title', hash: 'repair-hash', filepath, type: 'zip',
    pageCount: 1, bundleSize: stat.size, mtime: stat.mtime.toISOString(), coverHash: 'cover',
    status: 'tagged', url: oldUrl
  })
  await Metadata.create({ hash: 'repair-hash', title: 'Old title', status: 'tagged', url: oldUrl })
  const anomaly = {
    id: 'repair-anomaly',
    action: {
      type: 'repair-url', bookId: 'repair-book', filepath,
      expectedSize: stat.size, expectedMtimeMs: stat.mtimeMs,
      currentUrl: oldUrl, newUrl
    }
  }
  const jobManager = {
    storePath: auditStore,
    jobsPath: path.join(auditStore, 'jobs'),
    getReport: async () => ({ jobId, anomalies: [anomaly], duplicates: [] }),
    getReview: async () => ({ jobId, anomalyActionIds: [anomaly.id], duplicateSelections: {} }),
    setState: async () => {}
  }
  const common = {
    jobManager,
    coordinator: new LibraryTaskCoordinator(),
    Manga,
    Metadata,
    databasePath,
    metadataPath,
    collectionList: [],
    saveCollectionList: async () => {},
    library,
    quarantineRoot,
    rendererState: {}
  }

  await assert.rejects(
    executeApprovedActions({
      ...common,
      verifyRepairAction: async () => ({ valid: false, error: 'REPAIR_CANDIDATE_UNAVAILABLE' })
    }),
    /REPAIR_CANDIDATE_UNAVAILABLE/
  )
  assert.equal((await Manga.findByPk('repair-book')).url, oldUrl)

  const result = await executeApprovedActions({
    ...common,
    verifyRepairAction: async () => ({
      valid: true,
      newUrl,
      metadata: { title: 'Fresh title', title_jpn: '新しい題名', filecount: 42, status: 'tagged' }
    })
  })
  const repaired = await Manga.findByPk('repair-book')
  const shared = await Metadata.findByPk('repair-hash')
  assert.equal(result.repairedCount, 1)
  assert.equal(repaired.url, newUrl)
  assert.equal(repaired.title, 'Fresh title')
  assert.equal(repaired.filecount, 42)
  assert.equal(shared.url, newUrl)
  assert.equal(shared.title, 'Fresh title')
})

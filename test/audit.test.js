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
const { AuditWorkspaceManager } = require('../modules/audit/job_manager.js')
const { AuditReportRepository } = require('../modules/audit/report_repository.js')
const { AuditCache } = require('../modules/audit/cache.js')
const { EhentaiAvailabilityCache } = require('../modules/ehentai_availability_cache.js')
const { atomicWriteJson, normalizePath } = require('../modules/audit/utils.js')
const { inspectBookContent, inspectEhviewerIdentity, inspectBookHealth } = require('../modules/audit/archive_inspector.js')
const { executeApprovedActions } = require('../modules/audit/action_executor.js')
const { normalizeAnomalyReview, normalizeDedupeReview, buildExecutionPreview } = require('../modules/audit/review_validator.js')
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
      hiddenBook INTEGER, readCount INTEGER, exist INTEGER,
      createdAt DATETIME, updatedAt DATETIME
    )
  `)
  await metadata.exec(`
    CREATE TABLE Metadata (
      hash TEXT PRIMARY KEY, title TEXT, status TEXT, rating REAL, tags TEXT,
      title_jpn TEXT, filecount INTEGER, posted INTEGER, filesize INTEGER,
      category TEXT, url TEXT, mark INTEGER,
      createdAt DATETIME, updatedAt DATETIME
    )
  `)
  for (const book of books) {
    await database.run(`
      INSERT INTO Mangas(id, title, coverPath, hash, filepath, type, pageCount, bundleSize, mtime,
        coverHash, status, date, tags, filecount, category, url, mark, hiddenBook, readCount, exist)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 1)
    `, [
      book.id, book.title, book.coverPath || '', book.hash, book.filepath, book.type || 'zip',
      book.pageCount, book.bundleSize, book.mtime, book.coverHash, book.status || 'tagged',
      Date.now(), JSON.stringify(book.tags || {}), book.filecount, book.category || 'Doujinshi', book.url || ''
    ])
    await metadata.run(`
      INSERT OR REPLACE INTO Metadata(hash, title, status, tags, filecount, category, url, mark)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `, [book.hash, book.title, book.status || 'tagged', JSON.stringify(book.tags || {}), book.filecount, book.category || 'Doujinshi', book.url || ''])
  }
  await database.close()
  await metadata.close()
  return { databasePath, metadataPath }
}

const runAuditWorker = (workerFilename, { jobId, jobDir, options, onMessage = () => {} }) => new Promise((resolve, reject) => {
  const worker = new Worker(path.join(__dirname, `../modules/audit/${workerFilename}`), {
    workerData: { jobId, jobDir, options }
  })
  let completedMessage = null
  let settled = false
  const fail = error => {
    if (settled) return
    settled = true
    reject(error)
  }
  worker.on('message', message => {
    onMessage(message)
    if (message.type === 'completed') completedMessage = message
    if (message.type === 'failed') fail(new Error(message.error))
  })
  worker.on('error', fail)
  worker.on('exit', code => {
    if (settled) return
    if (code !== 0) return fail(new Error(`Audit worker exited with code ${code}`))
    if (!completedMessage) return fail(new Error('Audit worker exited without a completed message'))
    settled = true
    resolve(completedMessage)
  })
})

const makeArchiveBuffer = ({ image = 'image-one', gid = '123456', token = 'abcdef1234', ancillary = null } = {}) => {
  const zip = new AdmZip()
  zip.addFile('001.jpg', Buffer.from(image))
  zip.addFile('.ehviewer', Buffer.from(`VERSION2\nname\n${gid}\n${token}\n`))
  if (ancillary) zip.addFile('note.txt', Buffer.from(ancillary))
  return zip.toBuffer()
}

const writeWorkerReport = async ({ workerFilename, root, jobId, options, onMessage = () => {} }) => {
  const jobDir = path.join(root, 'audit', 'jobs', workerFilename.startsWith('anomaly') ? 'anomaly' : 'dedupe', jobId)
  await fs.promises.mkdir(jobDir, { recursive: true })
  const completed = await runAuditWorker(workerFilename, { jobId, jobDir, options, onMessage })
  return JSON.parse(await fs.promises.readFile(completed.reportPath, 'utf8'))
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

test('task timing estimates the current phase from its own progress baseline', async () => {
  const { calculateTaskTiming, formatTaskDuration } = await import('../src/audit/taskTiming.mjs')
  const now = Date.parse('2026-08-12T14:00:20.000Z')
  const timing = calculateTaskTiming({
    status: 'running',
    startedAt: '2026-08-12T13:00:00.000Z',
    phaseStartedAt: '2026-08-12T14:00:00.000Z',
    phaseStartCompleted: 10,
    phaseCompleted: 30,
    phaseTotal: 100
  }, now)
  assert.equal(timing.elapsedSeconds, 3620)
  assert.equal(timing.remainingSeconds, 70)
  assert.equal(timing.finishAt, now + 70000)
  assert.equal(formatTaskDuration(timing.elapsedSeconds), '01:00:20')
  assert.equal(calculateTaskTiming({ status: 'running', phaseCompleted: 3, phaseTotal: 10 }, now).remainingSeconds, null)
})

test('task stage summaries reflect conditional checks, execution type, and stopped work', async () => {
  const { calculateTaskStages } = await import('../src/audit/taskStages.mjs')
  const localOnly = calculateTaskStages({
    taskType: 'anomaly',
    phase: 'inspecting-book-health',
    status: 'running',
    options: { onlinePolicy: 'none' }
  })
  assert.deepEqual(localOnly.stages.map(item => item.id), ['prepare', 'snapshot', 'local-anomaly', 'report'])
  assert.equal(localOnly.completedCount, 2)
  assert.equal(localOnly.currentStage.id, 'local-anomaly')
  assert.equal(localOnly.nextStage.id, 'report')
  assert.equal(localOnly.remainingCount, 1)

  const online = calculateTaskStages({
    taskType: 'anomaly',
    phase: 'checking-online-sources',
    status: 'running',
    options: { onlinePolicy: 'ehviewer' }
  })
  assert.deepEqual(online.stages.map(item => item.id), ['prepare', 'snapshot', 'local-anomaly', 'online-sources', 'report'])
  assert.equal(online.completedCount, 3)
  assert.equal(online.nextStage.id, 'report')

  const stopped = calculateTaskStages({
    taskType: 'dedupe',
    phase: 'cancelled',
    lastWorkPhase: 'hashing-archives',
    status: 'interrupted'
  })
  assert.equal(stopped.currentStage.id, 'archive-hash')
  assert.equal(stopped.currentStage.state, 'paused')
  assert.equal(stopped.nextStage.id, 'content-verification')

  const anomalyExecution = calculateTaskStages({
    taskType: 'execution',
    phase: 'writing-metadata',
    status: 'running',
    options: { sourceTaskType: 'anomaly' }
  })
  const dedupeExecution = calculateTaskStages({
    taskType: 'execution',
    phase: 'quarantining-files',
    status: 'running',
    options: { sourceTaskType: 'dedupe' }
  })
  assert.equal(anomalyExecution.stages.some(item => item.id === 'quarantine'), false)
  assert.equal(dedupeExecution.currentStage.id, 'quarantine')
  assert.equal(dedupeExecution.stages.length, anomalyExecution.stages.length + 1)
})

test('workspace manager serializes independent channel state and throttles progress', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-workspace-state-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const manager = new AuditWorkspaceManager({ storePath: root, coordinator: new LibraryTaskCoordinator() })
  await manager.initialize()
  await Promise.all(Array.from({ length: 30 }, (_, index) => manager.setChannelState('anomaly', { completed: index, phase: `phase-${index}` })))
  assert.equal(manager.getState().channels.anomaly.completed, 29)
  assert.equal(manager.getState().channels.anomaly.phaseStartCompleted, 29)
  assert.ok(Number.isFinite(new Date(manager.getState().channels.anomaly.phaseStartedAt).getTime()))
  assert.equal(manager.getState().channels.dedupe.status, 'idle')

  await manager.setChannelState('anomaly', { phase: 'stable-phase', phaseCompleted: 4, phaseTotal: 20 })
  const phaseStartedAt = manager.getState().channels.anomaly.phaseStartedAt
  const currentItem = { id: 'book-1', title: 'current book', filepath: path.join(root, 'current.zip') }
  await manager.setChannelState('anomaly', { phase: 'stable-phase', phaseCompleted: 7, phaseTotal: 20, currentItem })
  assert.equal(manager.getState().channels.anomaly.phaseStartedAt, phaseStartedAt)
  assert.equal(manager.getState().channels.anomaly.phaseStartCompleted, 4)
  assert.equal(manager.getState().channels.anomaly.lastWorkPhase, 'stable-phase')
  assert.deepEqual(manager.getState().channels.anomaly.currentItem, currentItem)
  await manager.setChannelState('anomaly', { status: 'cancelling', phase: 'cancelling' })
  assert.equal(manager.getState().channels.anomaly.lastWorkPhase, 'stable-phase')
  assert.equal(manager.getState().channels.anomaly.currentItem, null)

  manager.progressIntervalMs = 1000
  let emitted = 0
  manager.on('state', () => { emitted += 1 })
  for (let index = 0; index < 100; index += 1) manager.queueProgress('dedupe', { completed: index, total: 100 })
  await manager.flushProgress()
  assert.equal(manager.getState().channels.dedupe.completed, 99)
  assert.equal(emitted, 1)
  const persisted = JSON.parse(await fs.promises.readFile(path.join(root, 'audit', 'channels', 'dedupe-state.json'), 'utf8'))
  assert.equal(persisted.completed, 99)

  manager.activeTask = { type: 'anomaly', jobId: 'already-running' }
  await assert.rejects(manager.startDedupe({}), /AUDIT_ALREADY_RUNNING/)
})

test('clearing inspection records resets reports, reviews, logs, and caches while preserving execution recovery data', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-clear-records-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const manager = new AuditWorkspaceManager({ storePath: root, coordinator: new LibraryTaskCoordinator() })
  await manager.initialize()
  const protectedPaths = [
    path.join(root, 'Library', 'protected-book.zip'),
    path.join(root, 'database.sqlite'),
    path.join(root, 'metadata.sqlite')
  ]
  await fs.promises.mkdir(path.dirname(protectedPaths[0]), { recursive: true })
  await Promise.all(protectedPaths.map((filepath, index) => fs.promises.writeFile(filepath, `protected-${index}`)))
  const protectedBefore = await Promise.all(protectedPaths.map(filepath => fs.promises.readFile(filepath)))

  const jobId = 'anomaly-to-clear'
  const jobDir = await manager.repository.createJob('anomaly', jobId)
  const reportPath = path.join(jobDir, 'report.json')
  const report = {
    reportType: 'anomaly', reportId: `anomaly:${jobId}`, jobId, executable: true,
    summary: { anomalies: 1 }, anomalies: [{ id: 'clear-me', action: null }]
  }
  await atomicWriteJson(reportPath, report)
  const reportState = await manager.repository.activateReport('anomaly', jobId, reportPath, report.summary)
  await manager.setChannelState('anomaly', { ...reportState, status: 'completed', latestJobId: jobId })
  await manager.saveReview('anomaly', { reportId: report.reportId, actionIds: [] })
  await manager.appendLog('anomaly', jobId, '检查记录')

  const executionDir = await manager.repository.createJob('execution', 'preserved-execution')
  await fs.promises.writeFile(path.join(executionDir, 'action-audit.jsonl'), '{"status":"verified"}\n')
  const backupDir = path.join(root, 'audit', 'backups', 'preserved-backup')
  await fs.promises.mkdir(backupDir, { recursive: true })
  await fs.promises.writeFile(path.join(backupDir, 'database.sqlite'), 'backup')

  const auditStorePath = path.join(root, 'audit')
  const localCache = await AuditCache.open(auditStorePath)
  await localCache.update(
    { filepath: path.join(root, 'book.zip') },
    { size: 10, mtimeMs: 20 },
    { healthInspection: { pageCount: 1, ehviewer: { status: 'absent' } } }
  )
  await localCache.close()
  const onlineCache = await EhentaiAvailabilityCache.open(auditStorePath)
  await onlineCache.set({ site: 'exhentai', gid: '1', token: 'token', status: 'available', checkedAt: Date.now() })
  await onlineCache.setGdata({ gid: '1', token: 'token', status: 'available', metadata: { gid: 1, title: 'cached' } })
  await onlineCache.close()

  const state = await manager.clearInspectionRecords()
  for (const taskType of ['anomaly', 'dedupe', 'execution']) {
    assert.equal(state.channels[taskType].status, 'idle')
    assert.equal(state.channels[taskType].latestReportId, null)
    assert.equal(state.channels[taskType].latestJobId, null)
  }
  assert.equal(await manager.getReport('anomaly'), null)
  assert.equal(await manager.getReview('anomaly'), null)
  assert.deepEqual(await manager.getLogs(), [])

  const cacheDb = await open({ filename: path.join(auditStorePath, 'audit-cache.sqlite'), driver: sqlite3.Database })
  assert.equal((await cacheDb.get('SELECT COUNT(*) AS count FROM cache_entries')).count, 0)
  assert.equal((await cacheDb.get('SELECT COUNT(*) AS count FROM gallery_availability')).count, 0)
  assert.equal((await cacheDb.get('SELECT COUNT(*) AS count FROM gallery_gdata')).count, 0)
  await cacheDb.close()

  assert.equal(await fs.promises.stat(path.join(executionDir, 'action-audit.jsonl')).then(() => true), true)
  assert.equal(await fs.promises.stat(path.join(backupDir, 'database.sqlite')).then(() => true), true)
  assert.equal(await fs.promises.stat(path.join(auditStorePath, 'migration-v3.json')).then(() => true), true)
  assert.deepEqual((await fs.promises.readdir(path.join(auditStorePath, 'jobs'))).sort(), ['anomaly', 'dedupe'])
  const protectedAfter = await Promise.all(protectedPaths.map(filepath => fs.promises.readFile(filepath)))
  assert.deepEqual(protectedAfter, protectedBefore)

  manager.activeTask = { type: 'anomaly', jobId: 'running' }
  await assert.rejects(manager.clearInspectionRecords(), /AUDIT_ALREADY_RUNNING/)
})

test('workspace manager releases its lock and records a failed state when task startup fails', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-startup-failure-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const coordinator = new LibraryTaskCoordinator()
  const manager = new AuditWorkspaceManager({ storePath: root, coordinator })
  await manager.initialize()
  manager.repository.createJob = async () => { throw new Error('synthetic startup failure') }
  await assert.rejects(manager.startAnomaly({}), /synthetic startup failure/)
  assert.equal(manager.getState().activeTask, null)
  assert.equal(manager.getState().channels.anomaly.status, 'failed')
  assert.equal(coordinator.getState().auditRunning, false)
})

test('anomaly and dedupe reports stay independently readable while another task is active', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-report-channels-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const manager = new AuditWorkspaceManager({ storePath: root, coordinator: new LibraryTaskCoordinator() })
  await manager.initialize()
  for (const taskType of ['anomaly', 'dedupe']) {
    const jobId = `${taskType}-previous`
    const jobDir = await manager.repository.createJob(taskType, jobId)
    const reportPath = path.join(jobDir, 'report.json')
    const report = taskType === 'anomaly'
      ? { reportType: taskType, reportId: `${taskType}:${jobId}`, jobId, summary: { anomalies: 3 }, anomalies: [] }
      : { reportType: taskType, reportId: `${taskType}:${jobId}`, jobId, summary: { duplicateGroups: 2 }, groups: [] }
    await atomicWriteJson(reportPath, report)
    const reportState = await manager.repository.activateReport(taskType, jobId, reportPath, report.summary)
    await manager.setChannelState(taskType, { ...reportState, status: 'completed' })
  }
  const firstAnomaly = await manager.getReport('anomaly')
  const firstDedupe = await manager.getReport('dedupe')
  await manager.setChannelState('dedupe', { status: 'running', activeJobId: 'dedupe-running' })
  assert.strictEqual(await manager.getReport('anomaly'), firstAnomaly)
  assert.strictEqual(await manager.getReport('dedupe'), firstDedupe)
  assert.equal(firstAnomaly.summary.anomalies, 3)
  assert.equal(firstDedupe.summary.duplicateGroups, 2)
})

test('resolved anomaly actions stay hidden without rewriting the source report', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-resolved-overlay-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const manager = new AuditWorkspaceManager({ storePath: root, coordinator: new LibraryTaskCoordinator() })
  await manager.initialize()
  const jobId = 'anomaly-resolved'
  const reportId = `anomaly:${jobId}`
  const jobDir = await manager.repository.createJob('anomaly', jobId)
  const reportPath = path.join(jobDir, 'report.json')
  await atomicWriteJson(reportPath, {
    reportType: 'anomaly',
    reportId,
    jobId,
    executable: true,
    summary: { anomalies: 3, anomalyBooks: 2, actionableAnomalies: 2 },
    anomalies: [
      { id: 'fixed', bookId: 'book-a', action: { type: 'repair-url' } },
      { id: 'remaining-action', bookId: 'book-a', action: { type: 'repair-url' } },
      { id: 'remaining-report-only', bookId: 'book-b', action: null }
    ]
  })
  const reportState = await manager.repository.activateReport('anomaly', jobId, reportPath)
  await manager.setChannelState('anomaly', { ...reportState, status: 'completed' })
  await manager.markAnomaliesResolved(reportId, ['fixed'])

  const visible = await manager.getReport('anomaly')
  assert.deepEqual(visible.anomalies.map(item => item.id), ['remaining-action', 'remaining-report-only'])
  assert.equal(visible.summary.anomalies, 2)
  assert.equal(visible.summary.anomalyBooks, 2)
  assert.equal(visible.summary.actionableAnomalies, 1)
  assert.equal(visible.resolvedAnomalies, 1)
  assert.equal((await fs.promises.readFile(reportPath, 'utf8')).includes('"fixed"'), true)

  const restored = new AuditWorkspaceManager({ storePath: root, coordinator: new LibraryTaskCoordinator() })
  await restored.initialize()
  assert.deepEqual((await restored.getReport('anomaly')).anomalies.map(item => item.id), ['remaining-action', 'remaining-report-only'])
})

test('completed legacy execution restores resolved anomaly ids from its verified action log', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-resolved-legacy-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const manager = new AuditWorkspaceManager({ storePath: root, coordinator: new LibraryTaskCoordinator() })
  await manager.initialize()
  const reportJobId = 'legacy-report'
  const reportId = `anomaly:${reportJobId}`
  const reportDir = await manager.repository.createJob('anomaly', reportJobId)
  const reportPath = path.join(reportDir, 'report.json')
  await atomicWriteJson(reportPath, {
    reportType: 'anomaly', reportId, jobId: reportJobId, executable: true,
    summary: { anomalies: 2, anomalyBooks: 2, actionableAnomalies: 2 },
    anomalies: [
      { id: 'legacy-fixed', bookId: 'book-a', action: { type: 'repair-url' } },
      { id: 'legacy-remaining', bookId: 'book-b', action: { type: 'repair-url' } }
    ]
  })
  const reportState = await manager.repository.activateReport('anomaly', reportJobId, reportPath)
  await manager.setChannelState('anomaly', { ...reportState, status: 'completed' })
  const executionJobId = 'legacy-execution'
  const executionDir = await manager.repository.createJob('execution', executionJobId)
  await fs.promises.writeFile(path.join(executionDir, 'action-audit.jsonl'), [
    JSON.stringify({ status: 'prepared', type: 'repair-url', anomalyId: 'legacy-fixed' }),
    JSON.stringify({ status: 'verified', taskType: 'anomaly', repairedCount: 1 })
  ].join('\n') + '\n')
  await manager.setChannelState('execution', {
    status: 'completed',
    latestJobId: executionJobId,
    options: { sourceTaskType: 'anomaly', reportId }
  })

  const restored = new AuditWorkspaceManager({ storePath: root, coordinator: new LibraryTaskCoordinator() })
  await restored.initialize()
  assert.deepEqual(restored.getState().channels.anomaly.resolvedAnomalyIds, ['legacy-fixed'])
  assert.deepEqual((await restored.getReport('anomaly')).anomalies.map(item => item.id), ['legacy-remaining'])
})

test('legacy combined reports migrate into separate non-executable reports without deleting originals', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-legacy-migration-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const legacyDir = path.join(root, 'audit', 'jobs', 'legacy-deep-job')
  await fs.promises.mkdir(legacyDir, { recursive: true })
  await atomicWriteJson(path.join(legacyDir, 'state.json'), { mode: 'deep', updatedAt: '2026-08-01T00:00:00.000Z' })
  await atomicWriteJson(path.join(legacyDir, 'report.json'), {
    mode: 'deep',
    createdAt: '2026-08-01T00:00:00.000Z',
    summary: { libraryItems: 10, mangaRows: 9, anomalies: 1, duplicateGroups: 1 },
    anomalies: [{ id: 'legacy-action', action: { type: 'repair-url' } }],
    duplicates: [{ id: 'legacy-group', kind: 'exact-archive', eligible: true, items: [] }]
  })
  const repository = new AuditReportRepository(root)
  await repository.initialize()
  const anomalyState = await repository.loadChannelState('anomaly')
  const dedupeState = await repository.loadChannelState('dedupe')
  const anomaly = await repository.getReport('anomaly', anomalyState)
  const dedupe = await repository.getReport('dedupe', dedupeState)
  assert.equal(anomaly.legacy, true)
  assert.equal(anomaly.executable, false)
  assert.equal(anomaly.anomalies[0].action, null)
  assert.equal(dedupe.legacy, true)
  assert.equal(dedupe.executable, false)
  assert.equal(dedupe.groups[0].kind, 'exact-archive')
  assert.equal(await fs.promises.stat(path.join(legacyDir, 'report.json')).then(() => true), true)
})

test('workspace state strips credentials and marks old reports read-only after library changes', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-state-v5-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const repository = new AuditReportRepository(root)
  await repository.initialize()
  await repository.saveChannelState('anomaly', {
    status: 'completed',
    options: {
      onlinePolicy: 'ehviewer',
      forceLocal: false,
      forceOnline: true,
      ehentaiSetting: { igneous: 'secret-cookie', ipb_pass_hash: 'secret-hash' }
    }
  })
  const manager = new AuditWorkspaceManager({ storePath: root, coordinator: new LibraryTaskCoordinator() })
  await manager.initialize()
  assert.deepEqual(manager.getState().channels.anomaly.options, {
    forceLocal: false,
    onlinePolicy: 'ehviewer',
    onlineBookCount: 0,
    forceOnline: true
  })
  assert.equal((await fs.promises.readFile(path.join(root, 'audit', 'channels', 'anomaly-state.json'), 'utf8')).includes('secret-cookie'), false)

  const jobId = 'current-anomaly'
  const jobDir = await manager.repository.createJob('anomaly', jobId)
  const reportPath = path.join(jobDir, 'report.json')
  await atomicWriteJson(reportPath, {
    schemaVersion: 3,
    reportType: 'anomaly',
    reportId: `anomaly:${jobId}`,
    jobId,
    executable: true,
    summary: {},
    anomalies: []
  })
  const reportState = await manager.repository.activateReport('anomaly', jobId, reportPath, {})
  await manager.setChannelState('anomaly', { ...reportState, status: 'completed' })
  await manager.markReportsStale('test-library-change')
  const staleReport = await manager.getReport('anomaly')
  assert.equal(staleReport.stale, true)
  assert.equal(staleReport.executable, false)
})

test('review validation keeps anomaly and duplicate approval models independent', () => {
  const anomalyReport = {
    reportId: 'anomaly:review',
    executable: true,
    anomalies: [
      { id: 'repair', action: { type: 'repair-url', currentUrl: 'https://exhentai.org/g/1/aaaaaaaaaa/', newUrl: 'https://e-hentai.org/g/1/aaaaaaaaaa/' } },
      { id: 'version', action: { type: 'repair-url', repairKind: 'gallery-version-upgrade', currentUrl: 'https://exhentai.org/g/2/bbbbbbbbbb/', newUrl: 'https://exhentai.org/g/3/cccccccccc/' } },
      { id: 'source', action: { type: 'repair-url', repairKind: 'source-recovery', currentUrl: null, newUrl: 'https://exhentai.org/g/4/dddddddddd/' } },
      { id: 'ehviewer', action: { type: 'repair-ehviewer', repairKind: 'ehviewer-rebuild-from-current-metadata' } },
      { id: 'unknown', action: { type: 'delete-file' } }
    ]
  }
  assert.deepEqual(normalizeAnomalyReview(anomalyReport, { reportId: anomalyReport.reportId, actionIds: ['repair', 'repair'] }).actionIds, ['repair'])
  assert.throws(() => normalizeAnomalyReview(anomalyReport, { reportId: anomalyReport.reportId, actionIds: ['unknown'] }), /UNSUPPORTED_ANOMALY_ACTION/)

  const dedupeReport = {
    reportId: 'dedupe:review',
    executable: true,
    groups: [
      { id: 'first', actionable: true, items: [{ id: 'a' }, { id: 'shared' }] },
      { id: 'second', actionable: true, items: [{ id: 'b' }, { id: 'shared' }] }
    ]
  }
  assert.throws(() => normalizeDedupeReview(dedupeReport, {
    reportId: dedupeReport.reportId,
    selections: {
      first: { keepId: 'a', quarantineIds: ['shared'] },
      second: { keepId: 'b', quarantineIds: ['shared'] }
    },
    quarantineRoot: path.join(os.tmpdir(), 'DedupeReview')
  }), /OVERLAPPING_DUPLICATE_SELECTION/)
  const preview = buildExecutionPreview({
    taskType: 'anomaly',
    report: anomalyReport,
    review: { reportId: anomalyReport.reportId, actionIds: ['repair', 'version', 'source', 'ehviewer'] },
    library: path.join(os.tmpdir(), 'Library')
  })
  assert.equal(preview.sameIdentityCount, 1)
  assert.equal(preview.versionUpgradeCount, 1)
  assert.equal(preview.sourceRecoveryCount, 1)
  assert.equal(preview.ehviewerRebuildCount, 1)
  assert.equal(preview.identityReplacementCount, 0)
})

test('execution requires an explicit task type when both review models contain approvals', async () => {
  await assert.rejects(executeApprovedActions({
    anomalyReview: { actionIds: ['repair'] },
    dedupeReview: { selections: { duplicate: { keepId: 'keep', quarantineIds: ['remove'] } } }
  }), /EXECUTION_TASK_TYPE_REQUIRED/)
})

test('audit cache migrates legacy content and preserves independent inspection layers', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-cache-'))
  let cache
  t.after(async () => {
    if (cache) await cache.close()
    await fs.promises.rm(root, { recursive: true, force: true })
  })
  const filepath = path.join(root, 'sample.zip')
  const stat = { size: 123, mtimeMs: 456 }
  const database = await open({ filename: path.join(root, 'audit-cache.sqlite'), driver: sqlite3.Database })
  await database.exec(`
    CREATE TABLE cache_entries (
      filepath TEXT PRIMARY KEY, size INTEGER NOT NULL, mtimeMs REAL NOT NULL,
      version INTEGER NOT NULL, archiveSha256 TEXT, inspection TEXT
    )
  `)
  await database.run('INSERT INTO cache_entries(filepath, size, mtimeMs, version, inspection) VALUES (?, ?, ?, 1, ?)', [
    normalizePath(filepath), stat.size, stat.mtimeMs, JSON.stringify({ pageCount: 10 })
  ])
  await database.close()

  cache = await AuditCache.open(root)
  const book = { filepath }
  let cached = await cache.get(book, stat)
  assert.deepEqual(cached.contentInspection, { pageCount: 10 })
  await cache.update(book, stat, {
    healthInspection: { pageCount: 10, ehviewer: { status: 'absent' } },
    ehviewerInspection: { status: 'parsed', gid: '123456', token: 'abcdef1234' }
  })
  cached = await cache.get(book, stat)
  assert.deepEqual(cached.contentInspection, { pageCount: 10 })
  assert.equal(cached.healthInspection.pageCount, 10)
  assert.equal(cached.ehviewerInspection.gid, '123456')
  assert.equal(await cache.get(book, { ...stat, size: 124 }), null)
})

test('zip inspectors separate lightweight health from full content verification', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-inspector-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const filepath = path.join(root, '123456-sample.zip')
  await fs.promises.writeFile(filepath, makeArchiveBuffer())
  const health = await inspectBookHealth({ filepath, type: 'zip' })
  assert.equal(health.pageCount, 1)
  assert.equal(health.ehviewer.status, 'parsed')
  assert.equal(health.ehviewer.gid, '123456')
  const full = await inspectBookContent({ filepath, type: 'zip' })
  assert.equal(full.images.length, 1)
  assert.match(full.images[0].sha256, /^[a-f0-9]{64}$/)
  const lightweight = await inspectEhviewerIdentity({ filepath, type: 'zip' })
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

test('anomaly worker checks individual books and never emits duplicate groups', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-anomaly-worker-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const library = path.join(root, 'Library')
  const auditStorePath = path.join(root, 'audit')
  await fs.promises.mkdir(library, { recursive: true })
  const archive = path.join(library, '123456-sample.zip')
  const untracked = path.join(library, '654321-untracked.zip')
  const buffer = makeArchiveBuffer()
  await Promise.all([fs.promises.writeFile(archive, buffer), fs.promises.writeFile(untracked, buffer)])
  const stat = await fs.promises.stat(archive)
  const databases = await createDatabases(root, [{
    id: 'book-1', title: 'sample', hash: 'target-hash', coverHash: 'cover-hash', filepath: archive,
    pageCount: 2, bundleSize: stat.size + 10, mtime: stat.mtime.toISOString(), filecount: 1,
    tags: { artist: ['author'] }, url: 'https://exhentai.org/g/123456/abcdef1234/'
  }])
  const before = await fs.promises.readFile(archive)
  const phases = []
  const currentItems = []
  const report = await writeWorkerReport({
    workerFilename: 'anomaly_worker.js', root, jobId: 'anomaly-job',
    options: { library, auditStorePath, onlinePolicy: 'none', sevenZipPath: null, ...databases },
    onMessage: message => {
      if (message.type !== 'progress') return
      phases.push(message.phase)
      if (message.currentItem) currentItems.push(message.currentItem)
    }
  })
  assert.equal(report.reportType, 'anomaly')
  assert.equal(report.executable, true)
  assert.ok(report.anomalies.some(item => item.type === 'scan-stale-size'))
  assert.ok(report.anomalies.some(item => item.type === 'scan-page-count-stale'))
  assert.ok(report.anomalies.some(item => item.type === 'library-file-untracked'))
  assert.equal(report.summary.anomalyBooks, 1)
  assert.equal('groups' in report, false)
  assert.ok(phases.includes('finalizing-report'))
  assert.ok(currentItems.some(item => item.id === 'book-1' && item.filepath === archive))
  assert.deepEqual(await fs.promises.readFile(archive), before)
})

test('online audit promotes .ehviewer source recovery into the original approvable anomaly and execution restores metadata', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-source-recovery-'))
  const library = path.join(root, 'Library')
  const auditStorePath = path.join(root, 'audit')
  await fs.promises.mkdir(library, { recursive: true })
  const archive = path.join(library, '4049796-source-recovery.zip')
  await fs.promises.writeFile(archive, makeArchiveBuffer({ gid: '4049796', token: 'bc7704fe8b' }))
  const stat = await fs.promises.stat(archive)
  const databases = await createDatabases(root, [{
    id: 'source-book', title: 'Local title', hash: 'source-hash', coverHash: 'source-cover', filepath: archive,
    pageCount: 1, bundleSize: stat.size, mtime: stat.mtime.toISOString(), filecount: 1,
    status: 'tagged', tags: { artist: ['local'] }, url: ''
  }])
  // Metadata is authoritative for the audit snapshot, even when Manga.url
  // contains a stale value left by an earlier partial metadata update.
  const mangaDatabase = await open({ filename: databases.databasePath, driver: sqlite3.Database })
  await mangaDatabase.run(
    'UPDATE Mangas SET url = ? WHERE id = ?',
    ['https://exhentai.org/g/4049796/bc7704fe8b/', 'source-book']
  )
  await mangaDatabase.close()
  const availabilityCache = await EhentaiAvailabilityCache.open(auditStorePath)
  await availabilityCache.set({
    site: 'ehentai', gid: '4049796', token: 'bc7704fe8b', status: 'available', httpStatus: 200,
    finalUrl: 'https://e-hentai.org/g/4049796/bc7704fe8b/', checkedAt: Date.now(), evidence: 'test-fixture'
  })
  await availabilityCache.set({
    site: 'exhentai', gid: '4049796', token: 'bc7704fe8b', status: 'generic-unavailable', httpStatus: 404,
    finalUrl: 'https://exhentai.org/g/4049796/bc7704fe8b/', checkedAt: Date.now(), evidence: 'test-fixture'
  })
  await availabilityCache.setGdata({
    gid: '4049796', token: 'bc7704fe8b', status: 'available', checkedAt: Date.now(),
    metadata: { gid: 4049796, token: 'bc7704fe8b', title: 'Recovered online title', tags: [], filecount: 24 }
  })
  await availabilityCache.close()

  let Manga
  let Metadata
  t.after(async () => {
    await Promise.allSettled([Manga?.sequelize.close(), Metadata?.sequelize.close()].filter(Boolean))
    await fs.promises.rm(root, { recursive: true, force: true })
  })
  const report = await writeWorkerReport({
    workerFilename: 'anomaly_worker.js',
    root,
    jobId: 'source-recovery-job',
    options: {
      library,
      auditStorePath,
      onlinePolicy: 'conflicts',
      forceLocal: false,
      forceOnline: false,
      sevenZipPath: null,
      ehentaiSetting: {},
      ...databases
    }
  })
  const recovery = report.anomalies.find(item => item.type === 'ehviewer-source-recoverable' && item.bookId === 'source-book')
  assert.ok(recovery)
  assert.equal(recovery.action?.type, 'repair-url')
  assert.equal(recovery.action?.repairKind, 'source-recovery')
  assert.equal(recovery.action?.currentUrl, null)
  assert.equal(recovery.action?.newUrl, 'https://e-hentai.org/g/4049796/bc7704fe8b/')
  assert.equal(recovery.evidence?.candidateGdataStatus, 'available')
  assert.equal(report.anomalies.some(item => item.type === 'ehviewer-url-conflict-online' && item.bookId === 'source-book'), false)

  Manga = prepareMangaModel(databases.databasePath)
  Metadata = prepareMetadataModel(databases.metadataPath)
  const executionDir = path.join(auditStorePath, 'executions', 'source-recovery-execution')
  await fs.promises.mkdir(executionDir, { recursive: true })
  const result = await executeApprovedActions({
    taskType: 'anomaly',
    anomalyReport: report,
    anomalyReview: { reportId: report.reportId, actionIds: [recovery.id] },
    executionId: 'source-recovery-execution',
    executionDir,
    auditStorePath,
    Manga,
    Metadata,
    databasePath: databases.databasePath,
    metadataPath: databases.metadataPath,
    collectionList: [],
    rendererState: {},
    verifyRepairAction: async action => {
      assert.equal(action.currentUrl, null)
      return {
        valid: true,
        newUrl: action.newUrl,
        metadata: { title: 'Recovered online title', filecount: 24, status: 'tagged' }
      }
    }
  })
  const repaired = await Manga.findByPk('source-book')
  const shared = await Metadata.findByPk('source-hash')
  assert.equal(result.repairedCount, 1)
  assert.equal(repaired.url, 'https://e-hentai.org/g/4049796/bc7704fe8b/')
  assert.equal(repaired.title, 'Recovered online title')
  assert.equal(repaired.filecount, 24)
  assert.equal(shared.url, repaired.url)
  assert.equal(shared.title, repaired.title)
})

test('online audit offers to rebuild a stale unavailable .ehviewer from the current available URL', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-ehviewer-sync-'))
  const library = path.join(root, 'Library')
  const auditStorePath = path.join(root, 'audit')
  await fs.promises.mkdir(library, { recursive: true })
  const archive = path.join(library, '2000000-current-url.zip')
  await fs.promises.writeFile(archive, makeArchiveBuffer({ gid: '1000000', token: 'aaaaaaaaaa' }))
  const stat = await fs.promises.stat(archive)
  const databases = await createDatabases(root, [{
    id: 'sync-book', title: 'Current title', hash: 'sync-hash', coverHash: 'sync-cover', filepath: archive,
    pageCount: 1, bundleSize: stat.size, mtime: stat.mtime.toISOString(), filecount: 1,
    status: 'tagged', tags: { artist: ['current'] }, url: 'https://exhentai.org/g/2000000/bbbbbbbbbb/'
  }])
  const cache = await EhentaiAvailabilityCache.open(auditStorePath)
  await cache.set({ site: 'ehentai', gid: '2000000', token: 'bbbbbbbbbb', status: 'available', httpStatus: 200, checkedAt: Date.now(), evidence: 'test' })
  await cache.set({ site: 'exhentai', gid: '2000000', token: 'bbbbbbbbbb', status: 'available', httpStatus: 200, checkedAt: Date.now(), evidence: 'test' })
  await cache.set({ site: 'ehentai', gid: '1000000', token: 'aaaaaaaaaa', status: 'generic-unavailable', httpStatus: 404, checkedAt: Date.now(), evidence: 'test' })
  await cache.set({ site: 'exhentai', gid: '1000000', token: 'aaaaaaaaaa', status: 'gallery-not-found', httpStatus: 404, checkedAt: Date.now(), evidence: 'test' })
  await cache.setGdata({ gid: '2000000', token: 'bbbbbbbbbb', status: 'available', checkedAt: Date.now(), metadata: { gid: 2000000, token: 'bbbbbbbbbb', title: 'Current title', filecount: 1 } })
  await cache.close()
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))

  const report = await writeWorkerReport({
    workerFilename: 'anomaly_worker.js', root, jobId: 'ehviewer-sync-job',
    options: { library, auditStorePath, onlinePolicy: 'conflicts', forceLocal: false, forceOnline: false, sevenZipPath: null, ehentaiSetting: {}, ...databases }
  })
  const sync = report.anomalies.find(item => item.bookId === 'sync-book' && item.type === 'ehviewer-url-conflict-online')
  assert.ok(sync)
  assert.equal(sync.reason, '当前 URL 可访问，但 .ehviewer 对应 Gallery 不可用')
  assert.equal(sync.action?.type, 'repair-ehviewer')
  assert.equal(sync.action?.repairKind, 'ehviewer-sync-to-current-metadata')
  assert.equal(sync.action?.currentUrl, 'https://exhentai.org/g/2000000/bbbbbbbbbb/')
  assert.deepEqual(sync.action?.identity, { gid: '2000000', token: 'bbbbbbbbbb' })
})

test('online audit makes an unavailable current identity replaceable when the .ehviewer identity is available', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-identity-replacement-'))
  const library = path.join(root, 'Library')
  const auditStorePath = path.join(root, 'audit')
  await fs.promises.mkdir(library, { recursive: true })
  const archive = path.join(library, '3000000-candidate.zip')
  await fs.promises.writeFile(archive, makeArchiveBuffer({ gid: '3000000', token: 'cccccccccc' }))
  const stat = await fs.promises.stat(archive)
  const databases = await createDatabases(root, [{
    id: 'replacement-book', title: 'Candidate title', hash: 'replacement-hash', coverHash: 'replacement-cover', filepath: archive,
    pageCount: 1, bundleSize: stat.size, mtime: stat.mtime.toISOString(), filecount: 1,
    status: 'tagged', tags: { artist: ['candidate'] }, url: 'https://exhentai.org/g/4000000/dddddddddd/'
  }])
  const cache = await EhentaiAvailabilityCache.open(auditStorePath)
  await cache.set({ site: 'ehentai', gid: '4000000', token: 'dddddddddd', status: 'generic-unavailable', httpStatus: 404, checkedAt: Date.now(), evidence: 'test' })
  await cache.set({ site: 'exhentai', gid: '4000000', token: 'dddddddddd', status: 'gallery-not-found', httpStatus: 404, checkedAt: Date.now(), evidence: 'test' })
  await cache.set({ site: 'ehentai', gid: '3000000', token: 'cccccccccc', status: 'available', httpStatus: 200, checkedAt: Date.now(), evidence: 'test' })
  await cache.set({ site: 'exhentai', gid: '3000000', token: 'cccccccccc', status: 'available', httpStatus: 200, checkedAt: Date.now(), evidence: 'test' })
  await cache.setGdata({ gid: '3000000', token: 'cccccccccc', status: 'available', checkedAt: Date.now(), metadata: { gid: 3000000, token: 'cccccccccc', title: 'Candidate title', filecount: 1 } })
  await cache.close()
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))

  const report = await writeWorkerReport({
    workerFilename: 'anomaly_worker.js', root, jobId: 'identity-replacement-job',
    options: { library, auditStorePath, onlinePolicy: 'conflicts', forceLocal: false, forceOnline: false, sevenZipPath: null, ehentaiSetting: {}, ...databases }
  })
  const replacement = report.anomalies.find(item => item.bookId === 'replacement-book' && item.type === 'ehviewer-url-conflict-online')
  assert.ok(replacement)
  assert.equal(replacement.action?.type, 'repair-url')
  assert.equal(replacement.action?.repairKind, 'identity-replacement')
  assert.equal(replacement.action?.currentUrl, 'https://exhentai.org/g/4000000/dddddddddd/')
  assert.equal(replacement.action?.newUrl, 'https://exhentai.org/g/3000000/cccccccccc/')
})

test('workspace manager releases the library lock after a worker completes', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-manager-worker-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const library = path.join(root, 'Library')
  await fs.promises.mkdir(library, { recursive: true })
  const archive = path.join(library, '123456-sample.zip')
  await fs.promises.writeFile(archive, makeArchiveBuffer())
  const stat = await fs.promises.stat(archive)
  const databases = await createDatabases(root, [{
    id: 'book-1', title: 'sample', hash: 'target-hash', coverHash: 'cover-hash', filepath: archive,
    pageCount: 1, bundleSize: stat.size, mtime: stat.mtime.toISOString(), filecount: 1,
    tags: { artist: ['author'] }, url: 'https://exhentai.org/g/123456/abcdef1234/'
  }])
  const coordinator = new LibraryTaskCoordinator()
  const manager = new AuditWorkspaceManager({ storePath: root, coordinator })
  await manager.initialize()
  const completed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('manager worker completion timed out')), 5000)
    manager.on('state', state => {
      if (state.channels.anomaly.status !== 'completed' || state.activeTask) return
      clearTimeout(timeout)
      resolve(state)
    })
  })
  await manager.startAnomaly({
    library,
    auditStorePath: path.join(root, 'audit'),
    onlinePolicy: 'none',
    sevenZipPath: null,
    ...databases
  })
  assert.equal(coordinator.getState().auditRunning, true)
  const state = await completed
  assert.equal(state.channels.anomaly.status, 'completed')
  assert.equal(coordinator.getState().auditRunning, false)
  assert.equal((await manager.getReport('anomaly')).reportType, 'anomaly')
  assert.ok((await manager.getLogs()).some(entry => entry.taskType === 'anomaly' && entry.message === '检查完成'))
})

test('dedupe worker proves byte-identical archives and never emits book anomalies', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-dedupe-worker-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const library = path.join(root, 'Library')
  const auditStorePath = path.join(root, 'audit')
  await fs.promises.mkdir(library, { recursive: true })
  const buffer = makeArchiveBuffer()
  const first = path.join(library, '123456-first.zip')
  const second = path.join(library, '123456-second.zip')
  await Promise.all([fs.promises.writeFile(first, buffer), fs.promises.writeFile(second, buffer)])
  const [firstStat, secondStat] = await Promise.all([fs.promises.stat(first), fs.promises.stat(second)])
  const databases = await createDatabases(root, [
    { id: 'book-1', title: 'first', hash: 'hash-one', coverHash: 'cover-one', filepath: first, pageCount: 1, bundleSize: firstStat.size, mtime: firstStat.mtime.toISOString(), filecount: 1, url: 'https://exhentai.org/g/123456/abcdef1234/' },
    { id: 'book-2', title: 'second', hash: 'hash-two', coverHash: 'cover-two', filepath: second, pageCount: 1, bundleSize: secondStat.size, mtime: secondStat.mtime.toISOString(), filecount: 1, url: 'https://exhentai.org/g/123456/abcdef1234/' }
  ])
  const phases = []
  const currentItems = []
  const concurrentItemCounts = []
  const report = await writeWorkerReport({
    workerFilename: 'dedupe_worker.js', root, jobId: 'dedupe-job',
    options: { library, auditStorePath, forceContent: false, sevenZipPath: null, ...databases },
    onMessage: message => {
      if (message.type !== 'progress') return
      phases.push(message.phase)
      if (message.currentItem) currentItems.push(message.currentItem)
      concurrentItemCounts.push(message.currentItems?.length || 0)
    }
  })
  const exact = report.groups.find(group => group.kind === 'exact-archive')
  assert.equal(report.reportType, 'dedupe')
  assert.ok(exact)
  assert.equal(exact.eligible, true)
  assert.equal(exact.items.length, 2)
  assert.match(exact.evidence.sha256, /^[a-f0-9]{64}$/)
  assert.equal('anomalies' in report, false)
  assert.ok(phases.includes('finalizing-report'))
  assert.ok(currentItems.some(item => item.id === 'book-1' || item.id === 'book-2'))
  assert.ok(concurrentItemCounts.some(count => count === 2))
})

test('dedupe worker excludes unreadable candidates instead of marking them duplicate', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-dedupe-excluded-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const library = path.join(root, 'Library')
  const auditStorePath = path.join(root, 'audit')
  await fs.promises.mkdir(library, { recursive: true })
  const valid = path.join(library, '123456-valid.zip')
  const broken = path.join(library, '123456-broken.zip')
  await Promise.all([fs.promises.writeFile(valid, makeArchiveBuffer()), fs.promises.writeFile(broken, Buffer.from('not a zip archive'))])
  const [validStat, brokenStat] = await Promise.all([fs.promises.stat(valid), fs.promises.stat(broken)])
  const databases = await createDatabases(root, [
    { id: 'valid', title: 'valid', hash: 'same-sample', coverHash: 'same-cover', filepath: valid, pageCount: 1, bundleSize: validStat.size, mtime: validStat.mtime.toISOString(), filecount: 1, url: 'https://exhentai.org/g/123456/abcdef1234/' },
    { id: 'broken', title: 'broken', hash: 'same-sample', coverHash: 'same-cover', filepath: broken, pageCount: 1, bundleSize: brokenStat.size, mtime: brokenStat.mtime.toISOString(), filecount: 1, url: 'https://exhentai.org/g/123456/abcdef1234/' }
  ])
  const report = await writeWorkerReport({
    workerFilename: 'dedupe_worker.js', root, jobId: 'excluded-job',
    options: { library, auditStorePath, forceContent: true, sevenZipPath: null, ...databases }
  })
  assert.ok(report.excludedItems.some(item => item.bookId === 'broken' && item.phase === 'inspecting-content'))
  assert.equal(report.groups.some(group => group.eligible && group.items.some(item => item.id === 'broken')), false)
})

test('approved duplicate execution quarantines one file and preserves merged user state', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-execute-'))
  const library = path.join(root, 'Library')
  const quarantineRoot = path.join(root, 'DedupeReview')
  const auditStorePath = path.join(root, 'audit')
  const executionId = 'execution-job'
  const executionDir = path.join(auditStorePath, 'executions', executionId)
  await Promise.all([fs.promises.mkdir(executionDir, { recursive: true }), fs.promises.mkdir(library, { recursive: true })])
  const first = path.join(library, '123456-first.zip')
  const second = path.join(library, '123456-second.zip')
  const buffer = makeArchiveBuffer()
  await Promise.all([fs.promises.writeFile(first, buffer), fs.promises.writeFile(second, buffer)])
  const [firstStat, secondStat] = await Promise.all([fs.promises.stat(first), fs.promises.stat(second)])
  const databasePath = path.join(root, 'database.sqlite')
  const metadataPath = path.join(root, 'metadata.sqlite')
  const Manga = prepareMangaModel(databasePath)
  const Metadata = prepareMetadataModel(metadataPath)
  t.after(async () => {
    await Promise.all([Manga.sequelize.close(), Metadata.sequelize.close()])
    await fs.promises.rm(root, { recursive: true, force: true })
  })
  await Promise.all([Manga.sync(), Metadata.sync()])
  await Manga.bulkCreate([
    { id: 'keep', title: 'keep', hash: 'hash-keep', filepath: first, type: 'zip', pageCount: 1, bundleSize: firstStat.size, mtime: firstStat.mtime.toISOString(), coverHash: 'cover', status: 'tagged', url: 'https://exhentai.org/g/123456/abcdef1234/', readCount: 2, mark: false, hiddenBook: true },
    { id: 'remove', title: 'remove', hash: 'hash-remove', filepath: second, type: 'zip', pageCount: 1, bundleSize: secondStat.size, mtime: secondStat.mtime.toISOString(), coverHash: 'cover', status: 'tagged', url: 'https://exhentai.org/g/123456/abcdef1234/', readCount: 7, mark: true, hiddenBook: false }
  ])
  await Metadata.bulkCreate([
    { hash: 'hash-keep', title: 'keep', status: 'tagged', url: 'https://exhentai.org/g/123456/abcdef1234/' },
    { hash: 'hash-remove', title: 'remove', status: 'tagged', url: 'https://exhentai.org/g/123456/abcdef1234/' }
  ])
  const reportId = 'dedupe:dedupe-report'
  const dedupeReport = {
    reportId, executable: true,
    groups: [{
      id: 'group-1', kind: 'exact-archive', eligible: true, actionable: true,
      items: [
        { id: 'keep', filepath: first, hash: 'hash-keep', size: firstStat.size, mtimeMs: firstStat.mtimeMs },
        { id: 'remove', filepath: second, hash: 'hash-remove', size: secondStat.size, mtimeMs: secondStat.mtimeMs }
      ]
    }]
  }
  let savedCollections
  const states = []
  const result = await executeApprovedActions({
    taskType: 'dedupe',
    anomalyReport: { reportId: 'anomaly:decoy', executable: true, anomalies: [] },
    anomalyReview: { reportId: 'anomaly:decoy', actionIds: ['must-not-run'] },
    dedupeReport,
    dedupeReview: { reportId, selections: { 'group-1': { keepId: 'keep', quarantineIds: ['remove'] } } },
    executionId,
    executionDir,
    auditStorePath,
    Manga,
    Metadata,
    databasePath,
    metadataPath,
    collectionList: [{ id: 'collection', title: 'test', list: ['hash-remove'] }],
    saveCollectionList: async value => { savedCollections = JSON.parse(JSON.stringify(value)) },
    library,
    quarantineRoot,
    rendererState: {
      recentRead: [{ id: 'remove', read_time: 100 }],
      viewerReadingProgress: [{ bookId: 'remove', pageId: '001.jpg' }]
    },
    setProgress: async state => states.push(state)
  })
  const keeper = await Manga.findByPk('keep')
  assert.equal(await Manga.count(), 1)
  assert.equal(keeper.readCount, 7)
  assert.equal(keeper.mark, true)
  assert.equal(keeper.hiddenBook, false)
  await assert.rejects(fs.promises.stat(second), error => error.code === 'ENOENT')
  assert.equal(await fs.promises.stat(path.join(quarantineRoot, executionId, path.basename(second))).then(() => true), true)
  assert.deepEqual(savedCollections[0].list, ['hash-keep'])
  assert.equal(result.rendererState.recentRead[0].id, 'keep')
  assert.equal(result.rendererState.viewerReadingProgress[0].bookId, 'keep')
  assert.ok(states.some(state => state.currentItem?.id === 'remove' && state.currentItem.filepath === second))
  assert.ok(states.some(state => state.phase === 'verified'))
  assert.equal(states.at(-1).currentItem, null)
})

test('duplicate execution restores files, databases, and collections when collection persistence fails', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-dedupe-rollback-'))
  const library = path.join(root, 'Library')
  const quarantineRoot = path.join(root, 'DedupeReview')
  const auditStorePath = path.join(root, 'audit')
  const executionId = 'rollback-execution'
  const executionDir = path.join(auditStorePath, 'executions', executionId)
  await Promise.all([fs.promises.mkdir(executionDir, { recursive: true }), fs.promises.mkdir(library, { recursive: true })])
  const first = path.join(library, 'first.zip')
  const second = path.join(library, 'second.zip')
  const buffer = makeArchiveBuffer()
  await Promise.all([fs.promises.writeFile(first, buffer), fs.promises.writeFile(second, buffer)])
  const [firstStat, secondStat] = await Promise.all([fs.promises.stat(first), fs.promises.stat(second)])
  const databasePath = path.join(root, 'database.sqlite')
  const metadataPath = path.join(root, 'metadata.sqlite')
  const Manga = prepareMangaModel(databasePath)
  const Metadata = prepareMetadataModel(metadataPath)
  t.after(async () => {
    await Promise.all([Manga.sequelize.close(), Metadata.sequelize.close()])
    await fs.promises.rm(root, { recursive: true, force: true })
  })
  await Promise.all([Manga.sync(), Metadata.sync()])
  await Manga.bulkCreate([
    { id: 'keep', title: 'keep', hash: 'hash-keep', filepath: first, type: 'zip', pageCount: 1, bundleSize: firstStat.size, mtime: firstStat.mtime.toISOString(), coverHash: 'cover', status: 'tagged' },
    { id: 'remove', title: 'remove', hash: 'hash-remove', filepath: second, type: 'zip', pageCount: 1, bundleSize: secondStat.size, mtime: secondStat.mtime.toISOString(), coverHash: 'cover', status: 'tagged' }
  ])
  await Metadata.bulkCreate([
    { hash: 'hash-keep', title: 'keep', status: 'tagged' },
    { hash: 'hash-remove', title: 'remove', status: 'tagged' }
  ])
  const reportId = 'dedupe:rollback-report'
  const collectionWrites = []
  await assert.rejects(executeApprovedActions({
    taskType: 'dedupe',
    dedupeReport: {
      reportId,
      executable: true,
      groups: [{
        id: 'group-1', kind: 'exact-archive', eligible: true, actionable: true,
        items: [
          { id: 'keep', filepath: first, hash: 'hash-keep', size: firstStat.size, mtimeMs: firstStat.mtimeMs },
          { id: 'remove', filepath: second, hash: 'hash-remove', size: secondStat.size, mtimeMs: secondStat.mtimeMs }
        ]
      }]
    },
    dedupeReview: {
      reportId,
      selections: { 'group-1': { keepId: 'keep', quarantineIds: ['remove'] } },
      quarantineRoot
    },
    executionId,
    executionDir,
    auditStorePath,
    Manga,
    Metadata,
    databasePath,
    metadataPath,
    collectionList: [{ id: 'collection', list: ['hash-remove'] }],
    saveCollectionList: async value => {
      collectionWrites.push(JSON.parse(JSON.stringify(value)))
      if (collectionWrites.length === 1) throw new Error('COLLECTION_WRITE_FAILED')
    },
    library,
    rendererState: {}
  }), /COLLECTION_WRITE_FAILED/)

  assert.equal(await Manga.count(), 2)
  assert.equal(await Metadata.count(), 2)
  assert.equal((await Manga.findByPk('remove')).filepath, second)
  assert.equal((await fs.promises.stat(second)).isFile(), true)
  await assert.rejects(fs.promises.stat(path.join(quarantineRoot, executionId, path.basename(second))), error => error.code === 'ENOENT')
  assert.equal(collectionWrites.length, 2)
  assert.deepEqual(collectionWrites[1], [{ id: 'collection', list: ['hash-remove'] }])
})

test('repair execution rejects stale or legacy evidence and updates metadata atomically after revalidation', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-repair-'))
  const library = path.join(root, 'Library')
  const auditStorePath = path.join(root, 'audit')
  const executionDir = path.join(auditStorePath, 'executions', 'repair-execution')
  const quarantineRoot = path.join(root, 'DedupeReview')
  await Promise.all([fs.promises.mkdir(library, { recursive: true }), fs.promises.mkdir(executionDir, { recursive: true })])
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
  await Manga.create({ id: 'repair-book', title: 'Old title', hash: 'repair-hash', filepath, type: 'zip', pageCount: 1, bundleSize: stat.size, mtime: stat.mtime.toISOString(), coverHash: 'cover', status: 'tagged', url: oldUrl })
  await Metadata.create({ hash: 'repair-hash', title: 'Old title', status: 'tagged', url: oldUrl })
  const anomaly = {
    id: 'repair-anomaly',
    action: { type: 'repair-url', bookId: 'repair-book', filepath, expectedSize: stat.size, expectedMtimeMs: stat.mtimeMs, currentUrl: oldUrl, newUrl }
  }
  const reportId = 'anomaly:repair-report'
  const common = {
    taskType: 'anomaly',
    anomalyReport: { reportId, executable: true, anomalies: [anomaly] },
    anomalyReview: { reportId, actionIds: [anomaly.id] },
    dedupeReport: { reportId: 'dedupe:decoy', executable: true, groups: [] },
    dedupeReview: { reportId: 'dedupe:decoy', selections: { 'must-not-run': { keepId: 'x', quarantineIds: ['y'] } } },
    executionId: 'repair-execution',
    executionDir,
    auditStorePath,
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
  const repairLogs = []
  await assert.rejects(executeApprovedActions({
    ...common,
    appendLog: async (message, level) => repairLogs.push({ message, level }),
    verifyRepairAction: async () => ({
      valid: false,
      error: 'REPAIR_GDATA_UNAVAILABLE',
      detail: { gdataStatus: 'network-error', gdataError: 'socket timed out' }
    })
  }), error => error.code === 'REPAIR_GDATA_UNAVAILABLE' && error.auditContext?.bookId === 'repair-book')
  assert.equal(repairLogs.length, 1)
  assert.equal(repairLogs[0].level, 'error')
  assert.match(repairLogs[0].message, /book\.zip/)
  assert.match(repairLogs[0].message, /gdata=network-error/)
  assert.equal((await Manga.findByPk('repair-book')).url, oldUrl)
  await assert.rejects(executeApprovedActions({
    ...common,
    anomalyReport: { ...common.anomalyReport, executable: false }
  }), /ANOMALY_REPORT_NOT_EXECUTABLE/)

  const repairStates = []
  const result = await executeApprovedActions({
    ...common,
    setProgress: async state => repairStates.push(state),
    verifyRepairAction: async () => ({ valid: true, newUrl, metadata: { title: 'Fresh title', title_jpn: '新しい題名', filecount: 42, status: 'tagged' } })
  })
  const repaired = await Manga.findByPk('repair-book')
  const shared = await Metadata.findByPk('repair-hash')
  assert.equal(result.repairedCount, 1)
  assert.equal(repaired.url, newUrl)
  assert.equal(repaired.title, 'Fresh title')
  assert.equal(repaired.filecount, 42)
  assert.equal(shared.url, newUrl)
  assert.equal(shared.title, 'Fresh title')
  assert.ok(repairStates.some(state => state.currentItem?.id === 'repair-book' && state.currentItem.filepath === filepath))
  assert.equal(repairStates.at(-1).currentItem, null)
})

const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const { open } = require('sqlite')
const { atomicWriteJson, hashFile, normalizePath } = require('./utils.js')

const copyIfExists = async (source, destination) => {
  try {
    await fs.promises.copyFile(source, destination)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

const backupDatabaseFamily = async (source, backupDir) => {
  const basename = path.basename(source)
  const destination = path.join(backupDir, basename)
  try {
    const db = await open({ filename: source, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY })
    try {
      await db.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`)
    } finally {
      await db.close()
    }
  } catch {
    await copyIfExists(source, destination)
    await copyIfExists(`${source}-wal`, path.join(backupDir, `${basename}-wal`))
    await copyIfExists(`${source}-shm`, path.join(backupDir, `${basename}-shm`))
  }
}

const ensureExpectedFile = async item => {
  const stat = await fs.promises.stat(item.filepath)
  if (item.size !== null && item.size !== undefined && Number(item.size) !== stat.size) {
    throw new Error(`APPROVAL_STALE_SIZE: ${item.filepath}`)
  }
  if (item.mtimeMs && Math.abs(Number(item.mtimeMs) - stat.mtimeMs) > 2000) {
    throw new Error(`APPROVAL_STALE_MTIME: ${item.filepath}`)
  }
  return stat
}

const moveAndVerify = async (source, target) => {
  await fs.promises.mkdir(path.dirname(target), { recursive: true })
  const sourceStat = await fs.promises.stat(source)
  try {
    await fs.promises.rename(source, target)
  } catch (error) {
    if (error.code !== 'EXDEV') throw error
    await fs.promises.copyFile(source, target)
    const [sourceHash, targetHash] = await Promise.all([hashFile(source), hashFile(target)])
    if (sourceHash !== targetHash) {
      await fs.promises.rm(target, { force: true })
      throw new Error(`QUARANTINE_COPY_HASH_MISMATCH: ${source}`)
    }
    await fs.promises.rm(source, { force: true })
  }
  const targetStat = await fs.promises.stat(target)
  if (targetStat.size !== sourceStat.size) throw new Error(`QUARANTINE_SIZE_MISMATCH: ${target}`)
}

const uniqueTargetPath = async (target, bookId) => {
  try {
    await fs.promises.access(target)
    const extension = path.extname(target)
    return path.join(path.dirname(target), `${path.basename(target, extension)}_${bookId}${extension}`)
  } catch {
    return target
  }
}

const mergeRendererState = (rendererState, idMap) => {
  const next = JSON.parse(JSON.stringify(rendererState || {}))
  if (Array.isArray(next.recentRead)) {
    const recordMap = new Map()
    for (const record of next.recentRead) {
      const id = idMap[record.id] || record.id
      const previous = recordMap.get(id)
      if (!previous || Number(record.read_time || 0) > Number(previous.read_time || 0)) recordMap.set(id, { ...record, id })
    }
    next.recentRead = [...recordMap.values()].sort((a, b) => Number(a.read_time || 0) - Number(b.read_time || 0)).slice(-100)
  }
  if (Array.isArray(next.viewerReadingProgress)) {
    const progressMap = new Map()
    for (const progress of next.viewerReadingProgress) {
      const bookId = idMap[progress.bookId] || progress.bookId
      if (!progressMap.has(bookId)) progressMap.set(bookId, { ...progress, bookId })
    }
    next.viewerReadingProgress = [...progressMap.values()].slice(0, 1000)
  }
  return next
}

const executeApprovedActions = async ({
  jobManager,
  coordinator,
  Manga,
  Metadata,
  databasePath,
  metadataPath,
  collectionList,
  saveCollectionList,
  library,
  quarantineRoot,
  rendererState
}) => {
  const report = await jobManager.getReport()
  const review = await jobManager.getReview()
  if (!report || !review || report.jobId !== review.jobId) throw new Error('AUDIT_REVIEW_MISMATCH')
  const jobId = report.jobId
  coordinator.beginAudit(jobId)
  const backupDir = path.join(jobManager.storePath, 'backups', `${jobId}_${Date.now()}`)
  const actionLogPath = path.join(jobManager.jobsPath, jobId, 'action-audit.jsonl')
  const writeActionLog = async entry => fs.promises.appendFile(actionLogPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8')
  const movedFiles = []
  const idMap = {}
  let nextCollections = JSON.parse(JSON.stringify(collectionList || []))
  let databaseCommitted = false

  try {
    await jobManager.setState({ status: 'running', phase: 'preparing-execution', completed: 0, total: 0, error: null })
    await fs.promises.mkdir(backupDir, { recursive: true })
    await Promise.all([
      backupDatabaseFamily(databasePath, backupDir),
      backupDatabaseFamily(metadataPath, backupDir),
      copyIfExists(path.join(path.dirname(databasePath), 'collectionList.json'), path.join(backupDir, 'collectionList.json')),
      atomicWriteJson(path.join(backupDir, 'renderer-state.json'), rendererState || {})
    ])

    const selectedGroups = Object.entries(review.duplicateSelections || {})
    const approvedAnomalyIds = new Set(review.anomalyActionIds || [])
    const approvedAnomalies = report.anomalies.filter(item => item.action && approvedAnomalyIds.has(item.id))
    const duplicateActions = []
    const selectedBookIds = new Set()
    for (const [groupId, selection] of selectedGroups) {
      const group = report.duplicates.find(item => item.id === groupId)
      if (!group) throw new Error(`DUPLICATE_GROUP_MISSING: ${groupId}`)
      const keep = group.items.find(item => item.id === selection.keepId)
      const quarantineItems = group.items.filter(item => (selection.quarantineIds || []).includes(item.id))
      if (!keep || quarantineItems.length === 0 || quarantineItems.some(item => item.id === keep.id)) {
        throw new Error(`INVALID_DUPLICATE_SELECTION: ${groupId}`)
      }
      for (const item of [keep, ...quarantineItems]) {
        if (selectedBookIds.has(item.id)) throw new Error(`OVERLAPPING_DUPLICATE_SELECTION: ${item.id}`)
        selectedBookIds.add(item.id)
      }
      duplicateActions.push({ group, keep, quarantineItems })
    }
    const quarantinedBookIds = new Set(duplicateActions.flatMap(action => action.quarantineItems.map(item => item.id)))
    if (approvedAnomalies.some(anomaly => quarantinedBookIds.has(anomaly.action.bookId))) {
      throw new Error('APPROVED_REPAIR_TARGET_IS_QUARANTINED')
    }

    const totalActions = approvedAnomalies.length + duplicateActions.reduce((sum, action) => sum + action.quarantineItems.length, 0)
    await jobManager.setState({ phase: 'validating-approvals', total: totalActions, completed: 0 })
    for (const anomaly of approvedAnomalies) {
      await ensureExpectedFile({ filepath: anomaly.action.filepath, size: anomaly.action.expectedSize, mtimeMs: anomaly.action.expectedMtimeMs })
    }
    for (const action of duplicateActions) {
      await ensureExpectedFile(action.keep)
      for (const item of action.quarantineItems) await ensureExpectedFile(item)
    }

    if (normalizePath(quarantineRoot).startsWith(`${normalizePath(library)}${path.sep}`)) {
      throw new Error('QUARANTINE_MUST_BE_OUTSIDE_LIBRARY')
    }
    let completed = 0
    for (const action of duplicateActions) {
      for (const item of action.quarantineItems) {
        const relative = path.relative(library, item.filepath)
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`FILE_OUTSIDE_LIBRARY: ${item.filepath}`)
        const requestedTarget = path.join(quarantineRoot, jobId, relative)
        const target = await uniqueTargetPath(requestedTarget, item.id)
        await writeActionLog({ status: 'prepared', type: 'quarantine', source: item.filepath, target, keepId: action.keep.id })
        await moveAndVerify(item.filepath, target)
        movedFiles.push({ source: item.filepath, target })
        idMap[item.id] = action.keep.id
        completed += 1
        await jobManager.setState({ phase: 'quarantining-files', completed, total: totalActions })
        await writeActionLog({ status: 'file-verified', type: 'quarantine', source: item.filepath, target, keepId: action.keep.id })
      }
    }

    const transaction = await Manga.sequelize.transaction()
    const removedHashes = new Set()
    try {
      for (const anomaly of approvedAnomalies) {
        const book = await Manga.findByPk(anomaly.action.bookId, { transaction })
        if (!book) throw new Error(`BOOK_MISSING: ${anomaly.action.bookId}`)
        await book.update({ url: anomaly.action.newUrl }, { transaction })
        completed += 1
        await jobManager.setState({ phase: 'writing-metadata', completed, total: totalActions })
        await writeActionLog({ status: 'manga-written', type: 'repair-url', bookId: book.id, oldUrl: anomaly.action.currentUrl, newUrl: anomaly.action.newUrl })
      }

      for (const action of duplicateActions) {
        const keepBook = await Manga.findByPk(action.keep.id, { transaction })
        const removedBooks = await Manga.findAll({ where: { id: action.quarantineItems.map(item => item.id) }, transaction })
        if (!keepBook || removedBooks.length !== action.quarantineItems.length) throw new Error(`BOOK_SET_CHANGED: ${action.group.id}`)
        const allBooks = [keepBook, ...removedBooks]
        await keepBook.update({
          readCount: Math.max(...allBooks.map(book => Number(book.readCount || 0))),
          mark: allBooks.some(book => Boolean(book.mark)),
          hiddenBook: allBooks.every(book => Boolean(book.hiddenBook))
        }, { transaction })
        for (const book of removedBooks) removedHashes.add(book.hash)
        await Manga.destroy({ where: { id: action.quarantineItems.map(item => item.id) }, transaction })
        const removedKeys = new Set(action.quarantineItems.flatMap(item => [item.id, item.hash]))
        nextCollections = nextCollections.map(collection => ({
          ...collection,
          list: [...new Set((collection.list || []).map(value => removedKeys.has(value) ? keepBook.hash : value))]
        }))
        await writeActionLog({ status: 'manga-written', type: 'dedupe', groupId: action.group.id, keepId: keepBook.id, removedIds: action.quarantineItems.map(item => item.id) })
      }
      await saveCollectionList(nextCollections)
      await transaction.commit()
      databaseCommitted = true
    } catch (error) {
      if (!transaction.finished) await transaction.rollback()
      await saveCollectionList(collectionList)
      throw error
    }

    const metadataBooks = new Set([
      ...approvedAnomalies.map(anomaly => anomaly.action.bookId),
      ...duplicateActions.map(action => action.keep.id)
    ])
    for (const bookId of metadataBooks) {
      try {
        const book = await Manga.findByPk(bookId)
        if (!book) continue
        const hashCount = await Manga.count({ where: { hash: book.hash } })
        if (hashCount === 1) await Metadata.upsert(book.toJSON())
      } catch (error) {
        await writeActionLog({ status: 'metadata-warning', bookId, error: error.message })
      }
    }
    for (const hash of removedHashes) {
      try {
        if (await Manga.count({ where: { hash } }) === 0) await Metadata.destroy({ where: { hash } })
      } catch (error) {
        await writeActionLog({ status: 'metadata-warning', hash, error: error.message })
      }
    }

    const nextRendererState = mergeRendererState(rendererState, idMap)
    await atomicWriteJson(path.join(jobManager.jobsPath, jobId, 'renderer-state-after.json'), nextRendererState)
    await jobManager.setState({ status: 'completed', phase: 'verified', completed: totalActions, total: totalActions, execution: { backupDir, movedCount: movedFiles.length, repairedCount: approvedAnomalies.length } })
    await writeActionLog({ status: 'verified', movedCount: movedFiles.length, repairedCount: approvedAnomalies.length })
    return { success: true, backupDir, rendererState: nextRendererState, collectionList: nextCollections, movedCount: movedFiles.length, repairedCount: approvedAnomalies.length }
  } catch (error) {
    if (!databaseCommitted) {
      for (const moved of [...movedFiles].reverse()) {
        try {
          await fs.promises.mkdir(path.dirname(moved.source), { recursive: true })
          await fs.promises.rename(moved.target, moved.source)
        } catch (rollbackError) {
          await writeActionLog({ status: 'rollback-failed', source: moved.source, target: moved.target, error: rollbackError.message })
        }
      }
    }
    await jobManager.setState({ status: 'failed', phase: 'failed', error: error.stack || error.message })
    await writeActionLog({ status: 'failed', error: error.stack || error.message })
    throw error
  } finally {
    coordinator.endAudit(jobId)
  }
}

module.exports = { executeApprovedActions }

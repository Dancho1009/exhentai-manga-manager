const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
const sqlite3 = require('sqlite3')
const { open } = require('sqlite')
const { Op } = require('sequelize')
const { atomicWriteJson, hashFile } = require('./utils.js')

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

const backupExecutionState = async ({ backupDir, databasePath, metadataPath, rendererState }) => {
  await fs.promises.mkdir(backupDir, { recursive: true })
  await Promise.all([
    backupDatabaseFamily(databasePath, backupDir),
    backupDatabaseFamily(metadataPath, backupDir),
    copyIfExists(path.join(path.dirname(databasePath), 'collectionList.json'), path.join(backupDir, 'collectionList.json')),
    atomicWriteJson(path.join(backupDir, 'renderer-state.json'), rendererState || {})
  ])
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

const hashDirectory = async root => {
  const hash = createHash('sha256')
  const files = []
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    const dirents = await fs.promises.readdir(current, { withFileTypes: true })
    for (const dirent of dirents) {
      const filepath = path.join(current, dirent.name)
      if (dirent.isDirectory()) stack.push(filepath)
      else if (dirent.isFile()) files.push(filepath)
    }
  }
  files.sort((left, right) => path.relative(root, left).localeCompare(path.relative(root, right)))
  for (const filepath of files) {
    hash.update(path.relative(root, filepath).replace(/\\/g, '/'))
    hash.update('\0')
    hash.update(await fs.promises.readFile(filepath))
    hash.update('\0')
  }
  return hash.digest('hex')
}

const hashPath = async (filepath, stat) => (stat || await fs.promises.stat(filepath)).isDirectory()
  ? await hashDirectory(filepath)
  : await hashFile(filepath)

const moveAndVerify = async (source, target) => {
  await fs.promises.mkdir(path.dirname(target), { recursive: true })
  const sourceStat = await fs.promises.stat(source)
  try {
    await fs.promises.rename(source, target)
  } catch (error) {
    if (error.code !== 'EXDEV') throw error
    if (sourceStat.isDirectory()) {
      await fs.promises.cp(source, target, { recursive: true, errorOnExist: true, force: false })
    } else {
      await fs.promises.copyFile(source, target)
    }
    const [sourceHash, targetHash] = await Promise.all([hashPath(source, sourceStat), hashPath(target)])
    if (sourceHash !== targetHash) {
      await fs.promises.rm(target, { recursive: true, force: true })
      throw new Error(`QUARANTINE_COPY_HASH_MISMATCH: ${source}`)
    }
    await fs.promises.rm(source, { recursive: true, force: true })
  }
  const targetStat = await fs.promises.stat(target)
  if (targetStat.isDirectory() !== sourceStat.isDirectory()) throw new Error(`QUARANTINE_TYPE_MISMATCH: ${target}`)
  if (!sourceStat.isDirectory() && targetStat.size !== sourceStat.size) throw new Error(`QUARANTINE_SIZE_MISMATCH: ${target}`)
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

const snapshotMetadataRows = async (Metadata, hashes) => {
  const list = [...new Set([...hashes].filter(Boolean))]
  if (list.length === 0) return []
  return await Metadata.findAll({ where: { hash: { [Op.in]: list } }, raw: true })
}

const restoreMetadataRows = async (Metadata, hashes, rows) => {
  const list = [...new Set([...hashes].filter(Boolean))]
  if (list.length === 0) return
  const transaction = await Metadata.sequelize.transaction()
  try {
    await Metadata.destroy({ where: { hash: { [Op.in]: list } }, transaction })
    if (rows.length > 0) await Metadata.bulkCreate(rows, { transaction })
    await transaction.commit()
  } catch (error) {
    if (!transaction.finished) await transaction.rollback()
    throw error
  }
}

const createExecutionContext = ({ executionDir, auditStorePath, executionId, isCancelled }) => {
  const backupDir = path.join(auditStorePath, 'backups', executionId)
  const actionLogPath = path.join(executionDir, 'action-audit.jsonl')
  const writeActionLog = async entry => fs.promises.appendFile(actionLogPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8')
  const assertNotCancelled = () => {
    if (isCancelled?.()) throw new Error('AUDIT_CANCELLED')
  }
  return { backupDir, actionLogPath, writeActionLog, assertNotCancelled }
}

module.exports = {
  backupExecutionState,
  ensureExpectedFile,
  moveAndVerify,
  uniqueTargetPath,
  mergeRendererState,
  snapshotMetadataRows,
  restoreMetadataRows,
  createExecutionContext
}

const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
const AdmZip = require('adm-zip')
const { nanoid } = require('nanoid')
const { readEhviewerBuffer, readEhviewerFile } = require('../../fileLoader/ehviewer.js')
const { hashFile } = require('./utils.js')

const ZIP_EXTENSIONS = new Set(['.zip', '.cbz'])

const normalizeEntryPath = value => String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '')

const sanitizeEhviewerTitle = value => String(value || '')
  .replace(/[\u0000-\u001F\u007F]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

const normalizeEhviewerIdentity = ({ gid, token } = {}) => {
  const normalizedGid = String(gid || '').trim()
  const normalizedToken = String(token || '').trim().toLowerCase()
  if (!/^\d+$/.test(normalizedGid) || !/^[0-9a-f]{10}$/.test(normalizedToken)) return null
  return { gid: normalizedGid, token: normalizedToken }
}

const buildEhviewerVersion2Buffer = ({ title, gid, token } = {}) => {
  const identity = normalizeEhviewerIdentity({ gid, token })
  const normalizedTitle = sanitizeEhviewerTitle(title)
  if (!identity || !normalizedTitle) throw new Error('EHVIEWER_RECOVERY_METADATA_INVALID')
  return Buffer.from(`VERSION2\n${normalizedTitle}\n${identity.gid}\n${identity.token}\n`, 'utf8')
}

const getEhviewerRepairSupport = ({ filepath, type, bookType } = {}) => {
  const normalizedType = bookType || type
  if (normalizedType === 'folder') return { supported: true, format: 'folder' }
  const extension = path.extname(filepath || '').toLowerCase()
  if (ZIP_EXTENSIONS.has(extension)) return { supported: true, format: extension.slice(1) }
  return { supported: false, format: extension.slice(1) || normalizedType || 'unknown', reason: 'EHVIEWER_REPAIR_ARCHIVE_UNSUPPORTED' }
}

const digestBuffer = buffer => createHash('sha256').update(buffer).digest('hex')

const snapshotZipEntries = zip => zip.getEntries()
  .filter(entry => !entry.isDirectory)
  .map(entry => {
    const buffer = entry.getData()
    return {
      path: normalizeEntryPath(entry.entryName),
      size: buffer.length,
      sha256: digestBuffer(buffer)
    }
  })
  .sort((left, right) => left.path.localeCompare(right.path))

const assertOtherZipEntriesUnchanged = (before, after, targetPath) => {
  const withoutTarget = entries => entries.filter(entry => entry.path !== targetPath)
  if (JSON.stringify(withoutTarget(before)) !== JSON.stringify(withoutTarget(after))) {
    throw new Error('EHVIEWER_REPAIR_ARCHIVE_CONTENT_CHANGED')
  }
  const targetEntries = after.filter(entry => entry.path === targetPath)
  if (targetEntries.length !== 1) throw new Error('EHVIEWER_REPAIR_TARGET_COUNT_CHANGED')
}

const assertIdentityMatches = (actual, expected) => {
  const normalized = normalizeEhviewerIdentity(actual)
  if (!normalized || normalized.gid !== expected.gid || normalized.token !== expected.token) {
    throw new Error('EHVIEWER_REPAIR_VERIFY_FAILED')
  }
}

const resolveFolderEntryPath = (folderpath, entryPath) => {
  const normalized = normalizeEntryPath(entryPath || '.ehviewer')
  if (path.posix.basename(normalized) !== '.ehviewer') throw new Error('EHVIEWER_REPAIR_TARGET_INVALID')
  const target = path.resolve(folderpath, ...normalized.split('/'))
  const relative = path.relative(path.resolve(folderpath), target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    if (normalized !== '.ehviewer') throw new Error('EHVIEWER_REPAIR_TARGET_INVALID')
  }
  return target
}

const copyAndVerifyBackup = async (source, destination) => {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true })
  await fs.promises.copyFile(source, destination)
  const [sourceHash, backupHash] = await Promise.all([hashFile(source), hashFile(destination)])
  if (sourceHash !== backupHash) throw new Error('EHVIEWER_REPAIR_BACKUP_HASH_MISMATCH')
  return sourceHash
}

const getFolderSnapshot = async (folderpath, ignoredPaths = new Set()) => {
  const dirents = await fs.promises.readdir(folderpath, { withFileTypes: true })
  let size = 0
  for (const dirent of dirents) {
    const filepath = path.join(folderpath, dirent.name)
    if (dirent.isFile() && !ignoredPaths.has(path.resolve(filepath))) size += (await fs.promises.stat(filepath)).size
  }
  const stat = await fs.promises.stat(folderpath)
  return { bundleSize: size, mtime: stat.mtime.toISOString(), mtimeMs: stat.mtimeMs }
}

const getBookFileSnapshot = async ({ filepath, type, bookType }) => {
  if ((bookType || type) === 'folder') return await getFolderSnapshot(filepath)
  const stat = await fs.promises.stat(filepath)
  return { bundleSize: stat.size, mtime: stat.mtime.toISOString(), mtimeMs: stat.mtimeMs }
}

const prepareZipRepair = async ({ filepath, entryPath, content, identity, backupPath }) => {
  const sourceZip = new AdmZip(filepath)
  const before = snapshotZipEntries(sourceZip)
  const normalizedEntryPath = normalizeEntryPath(entryPath)
  const matchingEntries = sourceZip.getEntries().filter(entry => !entry.isDirectory && normalizeEntryPath(entry.entryName) === normalizedEntryPath)
  if (matchingEntries.length !== 1 || path.posix.basename(normalizedEntryPath) !== '.ehviewer') {
    throw new Error('EHVIEWER_REPAIR_TARGET_NOT_UNIQUE')
  }

  const originalHash = await copyAndVerifyBackup(filepath, backupPath)
  const preparedPath = path.join(path.dirname(filepath), `.${path.basename(filepath)}.audit-${nanoid(10)}.tmp${path.extname(filepath)}`)
  try {
    sourceZip.updateFile(matchingEntries[0].entryName, content)
    sourceZip.writeZip(preparedPath)
    const verifiedZip = new AdmZip(preparedPath)
    const after = snapshotZipEntries(verifiedZip)
    assertOtherZipEntriesUnchanged(before, after, normalizedEntryPath)
    const repairedEntry = verifiedZip.getEntries().find(entry => !entry.isDirectory && normalizeEntryPath(entry.entryName) === normalizedEntryPath)
    assertIdentityMatches(readEhviewerBuffer(repairedEntry.getData()), identity)
  } catch (error) {
    await fs.promises.rm(preparedPath, { force: true }).catch(() => {})
    throw error
  }

  return { preparedPath, targetPath: filepath, originalHash }
}

const prepareFolderRepair = async ({ filepath, entryPath, content, identity, backupPath }) => {
  const targetPath = resolveFolderEntryPath(filepath, entryPath)
  const originalHash = await copyAndVerifyBackup(targetPath, backupPath)
  const preparedPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.audit-${nanoid(10)}.tmp`)
  try {
    await fs.promises.writeFile(preparedPath, content)
    assertIdentityMatches(await readEhviewerFile(preparedPath), identity)
  } catch (error) {
    await fs.promises.rm(preparedPath, { force: true }).catch(() => {})
    throw error
  }
  return { preparedPath, targetPath, originalHash }
}

const prepareEhviewerRepair = async ({ action, backupDir }) => {
  const support = getEhviewerRepairSupport(action)
  if (!support.supported) throw new Error(support.reason)
  const identity = normalizeEhviewerIdentity(action.identity)
  if (!identity) throw new Error('EHVIEWER_RECOVERY_METADATA_INVALID')
  const content = buildEhviewerVersion2Buffer({ title: action.expectedTitle, ...identity })
  const backupRoot = path.join(backupDir, 'ehviewer-sources', String(action.bookId || nanoid(8)))
  const sourceName = action.bookType === 'folder' ? '.ehviewer.original' : path.basename(action.filepath)
  const backupPath = path.join(backupRoot, sourceName)
  const prepared = action.bookType === 'folder'
    ? await prepareFolderRepair({ filepath: action.filepath, entryPath: action.entryPath, content, identity, backupPath })
    : await prepareZipRepair({ filepath: action.filepath, entryPath: action.entryPath, content, identity, backupPath })
  const rollbackPath = `${prepared.targetPath}.audit-rollback-${nanoid(10)}`
  let applied = false

  return {
    ...prepared,
    backupPath,
    identity,
    async apply() {
      if (applied) return
      if (await hashFile(prepared.targetPath) !== prepared.originalHash) throw new Error('APPROVAL_STALE_FILE_HASH')
      await fs.promises.rename(prepared.targetPath, rollbackPath)
      try {
        await fs.promises.rename(prepared.preparedPath, prepared.targetPath)
        if (action.bookType === 'folder') {
          assertIdentityMatches(await readEhviewerFile(prepared.targetPath), identity)
        } else {
          const zip = new AdmZip(prepared.targetPath)
          const entry = zip.getEntries().find(value => !value.isDirectory && normalizeEntryPath(value.entryName) === normalizeEntryPath(action.entryPath))
          assertIdentityMatches(entry ? readEhviewerBuffer(entry.getData()) : null, identity)
        }
        applied = true
      } catch (error) {
        await fs.promises.rm(prepared.targetPath, { force: true }).catch(() => {})
        await fs.promises.rename(rollbackPath, prepared.targetPath).catch(() => {})
        throw error
      }
    },
    async rollback() {
      if (applied) {
        await fs.promises.rm(prepared.targetPath, { force: true }).catch(() => {})
        await fs.promises.rename(rollbackPath, prepared.targetPath)
        applied = false
      } else {
        await fs.promises.rm(prepared.preparedPath, { force: true }).catch(() => {})
      }
    },
    async finalize() {
      if (applied) await fs.promises.rm(rollbackPath, { force: true })
    },
    async snapshot() {
      return action.bookType === 'folder'
        ? await getFolderSnapshot(action.filepath, new Set([path.resolve(rollbackPath)]))
        : await getBookFileSnapshot(action)
    }
  }
}

module.exports = {
  sanitizeEhviewerTitle,
  normalizeEhviewerIdentity,
  buildEhviewerVersion2Buffer,
  getEhviewerRepairSupport,
  getBookFileSnapshot,
  prepareEhviewerRepair
}

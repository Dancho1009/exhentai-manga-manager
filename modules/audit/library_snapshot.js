const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const { open } = require('sqlite')
const {
  IMAGE_EXTENSIONS,
  ARCHIVE_EXTENSIONS,
  normalizePath,
  stableId,
  extractGalleryIdentity,
  extractFilenameId,
  parseTags
} = require('./utils.js')

const openReadonly = filename => open({
  filename,
  driver: sqlite3.Database,
  mode: sqlite3.OPEN_READONLY
})

const makeAnomaly = (type, severity, data = {}) => ({
  id: stableId(type, data.bookId, data.filepath, data.groupKey, data.metadataHash),
  type,
  severity,
  title: data.title || type,
  bookId: data.bookId || null,
  filepath: data.filepath || null,
  reason: data.reason || '',
  evidence: data.evidence || {},
  recommendedAction: data.recommendedAction || 'review',
  action: data.action || null
})

const statFolder = async folderpath => {
  const dirents = await fs.promises.readdir(folderpath, { withFileTypes: true })
  let size = 0
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue
    size += (await fs.promises.stat(path.join(folderpath, dirent.name))).size
  }
  const stat = await fs.promises.stat(folderpath)
  return { size, mtimeMs: stat.mtimeMs, mtime: stat.mtime.toISOString() }
}

const walkLibrary = async (library, onProgress, isCancelled) => {
  await fs.promises.access(library, fs.constants.R_OK)
  const archives = []
  const imageFolders = new Map()
  const stack = [library]
  let visitedDirectories = 0

  while (stack.length > 0) {
    if (isCancelled()) throw new Error('AUDIT_CANCELLED')
    const current = stack.pop()
    const dirents = await fs.promises.readdir(current, { withFileTypes: true })
    visitedDirectories += 1
    let hasDirectImage = false
    for (const dirent of dirents) {
      const filepath = path.join(current, dirent.name)
      if (dirent.isDirectory()) {
        stack.push(filepath)
      } else if (dirent.isFile()) {
        const extension = path.extname(dirent.name).toLowerCase()
        if (ARCHIVE_EXTENSIONS.has(extension)) archives.push({ filepath, type: ['.zip', '.cbz'].includes(extension) ? 'zip' : 'archive' })
        if (IMAGE_EXTENSIONS.has(extension)) hasDirectImage = true
      }
    }
    if (hasDirectImage) imageFolders.set(normalizePath(current), { filepath: current, type: 'folder' })
    if (visitedDirectories % 25 === 0) onProgress('enumerating-library', visitedDirectories, null)
  }

  return [...archives, ...imageFolders.values()]
}

const loadDatabaseSnapshot = async (databasePath, metadataPath) => {
  const database = await openReadonly(databasePath)
  const metadata = await openReadonly(metadataPath)
  try {
    const databaseIntegrity = await database.get('PRAGMA quick_check')
    const metadataIntegrity = await metadata.get('PRAGMA quick_check')
    const books = await database.all('SELECT * FROM Mangas')
    const metadataRows = await metadata.all('SELECT * FROM Metadata')
    return {
      databaseIntegrity: Object.values(databaseIntegrity || {})[0],
      metadataIntegrity: Object.values(metadataIntegrity || {})[0],
      books: books.map(book => ({ ...book, tags: parseTags(book.tags) })),
      metadataRows: metadataRows.map(row => ({ ...row, tags: parseTags(row.tags) }))
    }
  } finally {
    await Promise.allSettled([database.close(), metadata.close()])
  }
}

const buildSnapshot = async ({ library, databasePath, metadataPath, excludeFile, onProgress, isCancelled }) => {
  let [libraryItems, databaseSnapshot] = await Promise.all([
    walkLibrary(library, onProgress, isCancelled),
    loadDatabaseSnapshot(databasePath, metadataPath)
  ])
  if (excludeFile) {
    try {
      const excludePattern = new RegExp(excludeFile)
      libraryItems = libraryItems.filter(item => !excludePattern.test(item.filepath))
    } catch {}
  }
  if (databaseSnapshot.databaseIntegrity !== 'ok' || databaseSnapshot.metadataIntegrity !== 'ok') {
    throw new Error(`SQLite quick_check failed: database=${databaseSnapshot.databaseIntegrity}, metadata=${databaseSnapshot.metadataIntegrity}`)
  }

  const actualItems = []
  for (let index = 0; index < libraryItems.length; index += 1) {
    if (isCancelled()) throw new Error('AUDIT_CANCELLED')
    const item = libraryItems[index]
    const stat = item.type === 'folder'
      ? await statFolder(item.filepath)
      : await fs.promises.stat(item.filepath).then(value => ({ size: value.size, mtimeMs: value.mtimeMs, mtime: value.mtime.toISOString() }))
    actualItems.push({ ...item, ...stat })
    if (index % 50 === 0 || index + 1 === libraryItems.length) onProgress('snapshot-files', index + 1, libraryItems.length)
  }

  const metadataByHash = new Map(databaseSnapshot.metadataRows.map(row => [row.hash, row]))
  const books = databaseSnapshot.books.map(raw => ({
    raw,
    effective: { ...raw, ...(metadataByHash.get(raw.hash) || {}) }
  }))
  return {
    createdAt: new Date().toISOString(),
    library,
    databasePath,
    metadataPath,
    actualItems,
    metadataRows: databaseSnapshot.metadataRows,
    books
  }
}

const analyzeSnapshot = snapshot => {
  const anomalies = []
  const actualByPath = new Map(snapshot.actualItems.map(item => [normalizePath(item.filepath), item]))
  const booksByPath = new Map()
  const booksByHash = new Map()
  const metadataHashes = new Set(snapshot.metadataRows.map(row => row.hash))

  for (const wrapped of snapshot.books) {
    const { raw, effective } = wrapped
    const pathKey = normalizePath(raw.filepath)
    const pathGroup = booksByPath.get(pathKey) || []
    pathGroup.push(wrapped)
    booksByPath.set(pathKey, pathGroup)
    const hashGroup = booksByHash.get(raw.hash) || []
    hashGroup.push(wrapped)
    booksByHash.set(raw.hash, hashGroup)

    const actual = actualByPath.get(pathKey)
    if (!actual) {
      anomalies.push(makeAnomaly('database-file-missing', 'critical', {
        bookId: raw.id, filepath: raw.filepath, reason: '数据库记录指向的文件不存在', evidence: { databasePath: raw.filepath }
      }))
      continue
    }
    if (Number(raw.bundleSize) !== Number(actual.size)) {
      anomalies.push(makeAnomaly('scan-stale-size', 'high', {
        bookId: raw.id, filepath: raw.filepath, reason: '文件实际大小与数据库快照不一致',
        evidence: { databaseSize: raw.bundleSize, actualSize: actual.size }, recommendedAction: 'targeted-rescan'
      }))
    }
    const storedMtime = new Date(raw.mtime || 0).getTime()
    if (Number.isFinite(storedMtime) && storedMtime > 0 && Math.abs(storedMtime - actual.mtimeMs) > 2000) {
      anomalies.push(makeAnomaly('scan-stale-mtime', 'medium', {
        bookId: raw.id, filepath: raw.filepath, reason: '文件修改时间与数据库快照不一致',
        evidence: { databaseMtime: raw.mtime, actualMtime: actual.mtime }, recommendedAction: 'targeted-rescan'
      }))
    }
    if (raw.coverPath && !fs.existsSync(raw.coverPath)) {
      anomalies.push(makeAnomaly('cover-missing', 'medium', {
        bookId: raw.id, filepath: raw.filepath, reason: '数据库封面路径不存在', evidence: { coverPath: raw.coverPath }, recommendedAction: 'targeted-rescan'
      }))
    }
    if (!metadataHashes.has(raw.hash)) {
      anomalies.push(makeAnomaly('metadata-missing', 'high', {
        bookId: raw.id, filepath: raw.filepath, metadataHash: raw.hash, reason: 'metadata.sqlite 中没有对应 hash'
      }))
    }
    const identity = extractGalleryIdentity(effective.url)
    const filenameId = extractFilenameId(raw.filepath)
    if (identity?.gid && filenameId && identity.gid !== filenameId) {
      anomalies.push(makeAnomaly('filename-url-id-conflict', 'high', {
        bookId: raw.id, filepath: raw.filepath, reason: '文件名前缀编号与元数据 URL gid 不一致',
        evidence: { filenameId, urlGid: identity.gid, url: effective.url }, recommendedAction: 'deep-identity-check'
      }))
    }
    if (effective.status === 'tagged' && !effective.url) {
      anomalies.push(makeAnomaly('tagged-without-source', 'high', {
        bookId: raw.id, filepath: raw.filepath, reason: '状态为 tagged，但没有来源 URL', recommendedAction: 'deep-identity-check'
      }))
    }
    const pageDiff = Math.abs(Number(raw.pageCount || 0) - Number(effective.filecount || 0))
    const pageBase = Math.max(Number(raw.pageCount || 0), Number(effective.filecount || 0), 1)
    if (effective.filecount && pageDiff > 5 && pageDiff / pageBase > 0.05) {
      anomalies.push(makeAnomaly('page-count-mismatch', pageDiff > 20 && pageDiff / pageBase > 0.25 ? 'high' : 'medium', {
        bookId: raw.id, filepath: raw.filepath, reason: '本地页数与来源页数差异较大',
        evidence: { localPages: raw.pageCount, remotePages: effective.filecount, difference: pageDiff }, recommendedAction: 'deep-identity-check'
      }))
    }
    const tags = effective.tags || {}
    if (!effective.title || !effective.category || !effective.filecount || Object.values(tags).flat().length === 0) {
      anomalies.push(makeAnomaly('metadata-incomplete', 'low', {
        bookId: raw.id, filepath: raw.filepath, reason: '存在缺失的常用元数据字段',
        evidence: { title: Boolean(effective.title), category: Boolean(effective.category), filecount: effective.filecount, tagCount: Object.values(tags).flat().length }
      }))
    }
  }

  for (const actual of snapshot.actualItems) {
    if (!booksByPath.has(normalizePath(actual.filepath))) {
      anomalies.push(makeAnomaly('library-file-untracked', 'high', {
        filepath: actual.filepath, reason: 'Library 中的作品没有数据库记录', evidence: { actualSize: actual.size }, recommendedAction: 'targeted-import'
      }))
    }
  }
  for (const [pathKey, group] of booksByPath) {
    if (group.length > 1) {
      anomalies.push(makeAnomaly('duplicate-database-path', 'critical', {
        filepath: group[0].raw.filepath, groupKey: pathKey, reason: '多个 Manga 记录指向同一路径', evidence: { bookIds: group.map(item => item.raw.id) }
      }))
    }
  }
  for (const [hash, group] of booksByHash) {
    if (group.length < 2) continue
    const rawUrls = [...new Set(group.map(item => item.raw.url).filter(Boolean))]
    const effectiveUrls = [...new Set(group.map(item => item.effective.url).filter(Boolean))]
    const conflict = rawUrls.length > 1 || effectiveUrls.length > 1 || group.some(item => item.raw.url && item.effective.url && item.raw.url !== item.effective.url)
    anomalies.push(makeAnomaly(conflict ? 'metadata-shadow-conflict' : 'shared-hash-review', conflict ? 'critical' : 'medium', {
      filepath: group[0].raw.filepath, groupKey: hash, metadataHash: hash,
      reason: conflict ? '共享 hash 的作品被同一 Metadata 记录覆盖，且身份信息冲突' : '多个作品共享抽样 hash，需要确认是否应共享元数据',
      evidence: { bookIds: group.map(item => item.raw.id), rawUrls, effectiveUrls }
    }))
  }

  const mangaHashes = new Set(snapshot.books.map(item => item.raw.hash))
  for (const metadata of snapshot.metadataRows) {
    if (!mangaHashes.has(metadata.hash)) {
      anomalies.push(makeAnomaly('orphan-metadata', 'low', {
        metadataHash: metadata.hash, reason: 'metadata.sqlite 记录没有对应 Manga', evidence: { title: metadata.title, url: metadata.url }
      }))
    }
  }
  return anomalies
}

module.exports = { buildSnapshot, analyzeSnapshot, makeAnomaly }

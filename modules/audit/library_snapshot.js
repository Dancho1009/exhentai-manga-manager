const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const { open } = require('sqlite')
const { mergeEffectiveBook } = require('../book_detail.js')
const {
  IMAGE_EXTENSIONS,
  ARCHIVE_EXTENSIONS,
  normalizePath,
  parseTags
} = require('./utils.js')

const openReadonly = filename => open({
  filename,
  driver: sqlite3.Database,
  mode: sqlite3.OPEN_READONLY
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
  const hashPeers = new Map()
  for (const raw of databaseSnapshot.books) {
    if (!raw.hash) continue
    if (!hashPeers.has(raw.hash)) hashPeers.set(raw.hash, [])
    hashPeers.get(raw.hash).push(raw)
  }
  const books = databaseSnapshot.books.map(raw => ({
    raw,
    effective: mergeEffectiveBook({
      manga: raw,
      metadata: raw.hash ? metadataByHash.get(raw.hash) : null,
      hashPeers: raw.hash ? hashPeers.get(raw.hash) : []
    })
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

module.exports = { buildSnapshot }

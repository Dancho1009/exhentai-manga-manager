const fs = require('fs')
const path = require('path')
const { openBufferedZip } = require('./buffered_zip_reader.js')
const { IMAGE_EXTENSIONS, stableId } = require('./utils.js')
const { run7z, parse7zRecords, inspectEhviewerIdentity } = require('./archive_inspector.js')

const naturalCompare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
const normalizeEntryPath = value => String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '')
const assertCurrent = options => { if (options.isCancelled?.()) throw new Error('AUDIT_CANCELLED') }

const enumerateFolderEntries = async (folderpath, options = {}) => {
  const entries = []
  const walk = async (directory, relative = '') => {
    assertCurrent(options)
    const dirents = await fs.promises.readdir(directory, { withFileTypes: true })
    for (const dirent of dirents) {
      const entryPath = relative ? `${relative}/${dirent.name}` : dirent.name
      const fullPath = path.join(directory, dirent.name)
      if (dirent.isDirectory()) await walk(fullPath, entryPath)
      else if (dirent.isFile()) {
        const stat = await fs.promises.stat(fullPath)
        const isImage = IMAGE_EXTENSIONS.has(path.extname(dirent.name).toLowerCase())
        entries.push({ path: entryPath, size: stat.size, mtimeMs: stat.mtimeMs, image: isImage && !relative, uncoveredImage: isImage && Boolean(relative) })
      } else entries.push({ path: entryPath, size: 0, unsupported: true })
    }
  }
  await walk(folderpath)
  return entries.sort((a, b) => naturalCompare(a.path, b.path))
}

const enumerateZipEntries = async (filepath, options) => {
  const zip = await openBufferedZip(filepath, options)
  return await new Promise((resolve, reject) => {
    const entries = []
    const fail = error => { zip.close(); reject(error) }
    zip.on('error', fail)
    zip.on('entry', entry => {
      try {
        assertCurrent(options)
        const entryPath = normalizeEntryPath(entry.fileName)
        if (entryPath && !entryPath.endsWith('/')) entries.push({ path: entryPath, size: entry.uncompressedSize,
          crc: entry.crc32, ignored: entryPath.includes('__MACOSX'), image: IMAGE_EXTENSIONS.has(path.extname(entryPath).toLowerCase()) })
        zip.readEntry()
      } catch (error) { fail(error) }
    })
    zip.on('end', () => resolve(entries))
    zip.readEntry()
  })
}

const enumerateBookEntries = async (book, options = {}) => {
  assertCurrent(options)
  let entries
  if (book.type === 'folder') entries = await enumerateFolderEntries(book.filepath, options)
  else if (['.zip', '.cbz'].includes(path.extname(book.filepath).toLowerCase())) entries = await enumerateZipEntries(book.filepath, options)
  else {
    if (!options.sevenZipPath) throw new Error('7z executable is unavailable')
    const listing = await run7z(options.sevenZipPath, ['l', book.filepath, '-slt', '-sccUTF-8', '-p123456'], false, options)
    entries = parse7zRecords(listing).map(record => ({ path: normalizeEntryPath(record.Path), size: Number(record.Size || 0),
      crc: record.CRC ? Number.parseInt(record.CRC, 16) : null,
      ignored: record.Path.includes('__MACOSX'),
      image: IMAGE_EXTENSIONS.has(path.extname(record.Path).toLowerCase()) }))
  }
  entries.sort((a, b) => naturalCompare(a.path, b.path))
  const images = entries.filter(entry => entry.image && !entry.ignored)
  const crcAvailable = images.length > 0 && images.every(entry => Number.isInteger(entry.crc))
  const pageCount = images.length
  const folderFingerprint = book.type === 'folder' ? stableId(entries.map(entry => [entry.path, entry.size, entry.mtimeMs, entry.unsupported])) : null
  const ehviewer = await inspectEhviewerIdentity(book, options)
  assertCurrent(options)
  return { version: 1, entries, images, pageCount, ehviewer, folderFingerprint,
    ignoredEntries: entries.filter(entry => entry.ignored).map(entry => entry.path),
    uncoveredEntries: entries.filter(entry => entry.uncoveredImage || entry.unsupported).map(entry => entry.path),
    totalImageBytes: images.reduce((sum, entry) => sum + entry.size, 0),
    orderedCandidate: crcAvailable ? stableId(images.map(entry => [entry.size, entry.crc])) : null,
    multisetCandidate: crcAvailable ? stableId(images.map(entry => `${entry.size}:${entry.crc}`).sort()) : null,
    sizeCandidate: pageCount ? stableId(images.map(entry => entry.size).sort((a, b) => a - b)) : null }
}

module.exports = { enumerateBookEntries, enumerateFolderEntries, normalizeEntryPath, naturalCompare }

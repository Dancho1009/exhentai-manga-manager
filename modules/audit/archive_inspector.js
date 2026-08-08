const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { createHash } = require('crypto')
const yauzl = require('yauzl')
const { readEhviewerBuffer } = require('../../fileLoader/ehviewer.js')
const { IMAGE_EXTENSIONS, stableId } = require('./utils.js')

const naturalCompare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
const normalizeEntryPath = value => String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '')

const digestStream = (stream, capture = false, maxCaptureBytes = 16 * 1024 * 1024) => new Promise((resolve, reject) => {
  const hash = createHash('sha256')
  const chunks = []
  let size = 0
  let captureAllowed = capture
  stream.on('data', chunk => {
    hash.update(chunk)
    size += chunk.length
    if (captureAllowed) {
      if (size <= maxCaptureBytes) chunks.push(chunk)
      else captureAllowed = false
    }
  })
  stream.on('error', reject)
  stream.on('end', () => resolve({
    sha256: hash.digest('hex'),
    size,
    buffer: capture && captureAllowed ? Buffer.concat(chunks) : null
  }))
})

const openZip = filepath => new Promise((resolve, reject) => {
  yauzl.open(filepath, { lazyEntries: true, autoClose: true }, (error, zipfile) => {
    if (error) reject(error)
    else resolve(zipfile)
  })
})

const openZipEntry = (zipfile, entry) => new Promise((resolve, reject) => {
  zipfile.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream))
})

const inspectZip = async filepath => {
  const zipfile = await openZip(filepath)
  const entries = []

  return await new Promise((resolve, reject) => {
    let settled = false
    const fail = error => {
      if (settled) return
      settled = true
      try { zipfile.close() } catch {}
      reject(error)
    }

    zipfile.on('error', fail)
    zipfile.on('entry', async entry => {
      try {
        const entryPath = normalizeEntryPath(entry.fileName)
        if (!entryPath || entryPath.endsWith('/') || entryPath.includes('__MACOSX')) {
          zipfile.readEntry()
          return
        }
        const extension = path.posix.extname(entryPath).toLowerCase()
        const isEhviewer = path.posix.basename(entryPath) === '.ehviewer'
        const stream = await openZipEntry(zipfile, entry)
        const digest = await digestStream(stream, isEhviewer)
        entries.push({
          path: entryPath,
          size: digest.size,
          sha256: digest.sha256,
          image: IMAGE_EXTENSIONS.has(extension),
          ehviewerBuffer: digest.buffer
        })
        zipfile.readEntry()
      } catch (error) {
        fail(error)
      }
    })
    zipfile.on('end', () => {
      if (settled) return
      settled = true
      resolve(entries)
    })
    zipfile.readEntry()
  })
}

const run7z = (sevenZipPath, args, capture = false) => new Promise((resolve, reject) => {
  const child = spawn(sevenZipPath, args, { windowsHide: true })
  const stdout = []
  const stderr = []
  child.stdout.on('data', chunk => stdout.push(chunk))
  child.stderr.on('data', chunk => stderr.push(chunk))
  child.on('error', reject)
  child.on('close', code => {
    if (code !== 0) {
      reject(new Error(`7z returned code ${code}: ${Buffer.concat(stderr).toString('utf8').trim()}`))
      return
    }
    resolve(capture ? Buffer.concat(stdout) : Buffer.concat(stdout).toString('utf8'))
  })
})

const inspect7zArchive = async (filepath, sevenZipPath) => {
  if (!sevenZipPath) throw new Error('7z executable is unavailable')
  const output = await run7z(sevenZipPath, ['l', filepath, '-slt', '-sccUTF-8', '-p123456'])
  const markerIndex = output.indexOf('----------')
  const detail = markerIndex >= 0 ? output.slice(markerIndex) : output
  const records = detail.split(/\r?\n\r?\n/).map(block => {
    const record = {}
    for (const line of block.split(/\r?\n/)) {
      const separator = line.indexOf(' = ')
      if (separator > 0) record[line.slice(0, separator)] = line.slice(separator + 3)
    }
    return record
  })
  const entryPaths = records
    .filter(record => record.Path && record.Folder !== '+')
    .map(record => normalizeEntryPath(record.Path))
    .filter(Boolean)
  const entries = []
  for (const entryPath of entryPaths) {
    const extension = path.posix.extname(entryPath).toLowerCase()
    const buffer = await run7z(sevenZipPath, ['x', '-so', '-p123456', '--', filepath, entryPath], true)
    const sha256 = createHash('sha256').update(buffer).digest('hex')
    entries.push({
      path: entryPath,
      size: buffer.length,
      sha256,
      image: IMAGE_EXTENSIONS.has(extension),
      ehviewerBuffer: path.posix.basename(entryPath) === '.ehviewer' ? buffer : null
    })
  }
  return entries
}

const inspectFolder = async folderpath => {
  const dirents = await fs.promises.readdir(folderpath, { withFileTypes: true })
  const entries = []
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue
    const extension = path.extname(dirent.name).toLowerCase()
    const isEhviewer = dirent.name === '.ehviewer'
    const filepath = path.join(folderpath, dirent.name)
    const stream = fs.createReadStream(filepath)
    const digest = await digestStream(stream, isEhviewer)
    entries.push({
      path: dirent.name,
      size: digest.size,
      sha256: digest.sha256,
      image: IMAGE_EXTENSIONS.has(extension),
      ehviewerBuffer: digest.buffer
    })
  }
  return entries
}

const resolveEhviewer = entries => {
  const candidates = entries
    .filter(entry => path.posix.basename(entry.path) === '.ehviewer')
    .sort((a, b) => {
      const aRoot = a.path === '.ehviewer' ? 0 : 1
      const bRoot = b.path === '.ehviewer' ? 0 : 1
      return aRoot - bRoot || a.path.length - b.path.length || naturalCompare(a.path, b.path)
    })
  if (candidates.length === 0) {
    return { status: 'absent', format: null, entryPath: null, candidateCount: 0, gid: null, token: null }
  }
  const selected = candidates[0]
  const parsed = selected.ehviewerBuffer ? readEhviewerBuffer(selected.ehviewerBuffer) : null
  return {
    status: candidates.length > 1 ? 'ambiguous' : parsed ? 'parsed' : 'invalid',
    format: selected.ehviewerBuffer?.slice(0, 10).toString('utf8').replace(/^\uFEFF/, '').startsWith('VERSION2') ? 'version2' : 'cbor',
    entryPath: selected.path,
    candidateCount: candidates.length,
    gid: parsed?.gid ? String(parsed.gid) : null,
    token: parsed?.token ? String(parsed.token) : null
  }
}

const inspectBookContent = async (book, options = {}) => {
  let entries
  const extension = path.extname(book.filepath).toLowerCase()
  if (book.type === 'folder') entries = await inspectFolder(book.filepath)
  else if (extension === '.zip' || extension === '.cbz') entries = await inspectZip(book.filepath)
  else entries = await inspect7zArchive(book.filepath, options.sevenZipPath)

  const images = entries.filter(entry => entry.image).sort((a, b) => naturalCompare(a.path, b.path))
  const ancillary = entries.filter(entry => !entry.image).sort((a, b) => naturalCompare(a.path, b.path))
  const ehviewer = resolveEhviewer(ancillary)
  const imageSignature = stableId(images.map(entry => entry.sha256))
  const ancillarySignature = stableId(ancillary.map(entry => [entry.path, entry.size, entry.sha256]))
  return {
    pageCount: images.length,
    imageSignature,
    ancillarySignature,
    images: images.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
    ancillary: ancillary.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
    ehviewer
  }
}

module.exports = { inspectBookContent }

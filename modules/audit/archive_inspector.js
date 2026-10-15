const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { createHash } = require('crypto')
const { openBufferedZip } = require('./buffered_zip_reader.js')
const { readEhviewerBuffer, readEhviewerFields } = require('../../fileLoader/ehviewer.js')
const { IMAGE_EXTENSIONS, stableId } = require('./utils.js')

const naturalCompare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
const normalizeEntryPath = value => String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '')
const MAX_SEQUENCE_SPAN = 1000000
const MAX_REPORTED_MISSING_NUMBERS = 200

const extractImageSequenceNumber = imagePath => {
  const basename = path.posix.basename(normalizeEntryPath(imagePath))
  const extension = path.posix.extname(basename)
  const stem = extension ? basename.slice(0, -extension.length) : basename
  const match = /(?:^|[,_\-.\s])(\d+)$/.exec(stem)
  if (!match) return null
  const number = Number(match[1])
  return Number.isSafeInteger(number) ? number : null
}

const formatSequenceDirectory = imagePath => path.posix.dirname(normalizeEntryPath(imagePath))

const analyzeImageSequence = imagePaths => {
  const grouped = new Map()
  for (const imagePath of imagePaths || []) {
    const directory = formatSequenceDirectory(imagePath)
    const group = grouped.get(directory) || { directory, imagePaths: [], numbered: [], unnumbered: 0 }
    group.imagePaths.push(imagePath)
    const number = extractImageSequenceNumber(imagePath)
    if (number === null) group.unnumbered += 1
    else group.numbered.push({ path: imagePath, number })
    grouped.set(directory, group)
  }

  const checkedGroups = []
  const gaps = []
  for (const group of grouped.values()) {
    // A sequence is only trusted when almost every image in one directory has
    // a unique, parseable page number. Randomly named archives remain ignored.
    if (group.numbered.length < 3 || group.unnumbered > 1) continue
    const sorted = [...group.numbered].sort((left, right) => left.number - right.number)
    const numbers = sorted.map(item => item.number)
    const uniqueNumbers = new Set(numbers)
    if (uniqueNumbers.size !== numbers.length) continue
    const first = numbers[0]
    const last = numbers[numbers.length - 1]
    if (last - first + 1 > MAX_SEQUENCE_SPAN) continue

    const missingRanges = []
    let missingCount = 0
    for (let index = 1; index < numbers.length; index += 1) {
      const rangeStart = numbers[index - 1] + 1
      const rangeEnd = numbers[index] - 1
      if (rangeStart > rangeEnd) continue
      const count = rangeEnd - rangeStart + 1
      missingRanges.push({ start: rangeStart, end: rangeEnd, count })
      missingCount += count
    }
    const missingNumbers = []
    if (missingCount <= MAX_REPORTED_MISSING_NUMBERS) {
      for (const range of missingRanges) {
        for (let number = range.start; number <= range.end; number += 1) missingNumbers.push(number)
      }
    }
    const result = {
      directory: group.directory,
      imageCount: group.imagePaths.length,
      first,
      last,
      missingCount,
      missingRanges,
      missingNumbers
    }
    checkedGroups.push(result)
    if (missingCount > 0) gaps.push(result)
  }

  return {
    status: checkedGroups.length ? 'checked' : 'not-applicable',
    checkedGroups,
    gaps,
    gapCount: gaps.reduce((total, group) => total + group.missingCount, 0)
  }
}

const digestStream = (stream, capture = false, maxCaptureBytes = 16 * 1024 * 1024, isCancelled = () => false) => new Promise((resolve, reject) => {
  const hash = createHash('sha256')
  const chunks = []
  let size = 0
  let captureAllowed = capture
  const timer = setInterval(() => { if (isCancelled()) stream.destroy(new Error('AUDIT_CANCELLED')) }, 100)
  timer.unref()
  stream.once('close', () => clearInterval(timer))
  stream.once('end', () => clearInterval(timer))
  stream.once('error', () => clearInterval(timer))
  stream.on('data', chunk => {
    if (isCancelled()) { stream.destroy(new Error('AUDIT_CANCELLED')); return }
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

const openZipEntry = (zipfile, entry) => new Promise((resolve, reject) => {
  zipfile.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream))
})

const inspectZip = async (filepath, options = {}) => {
  const zipfile = await openBufferedZip(filepath, options)
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
        const digest = await digestStream(stream, isEhviewer, 16 * 1024 * 1024, options.isCancelled)
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

const run7z = (sevenZipPath, args, capture = false, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(sevenZipPath, args, { windowsHide: true })
  const stdout = []
  const stderr = []
  let size = 0
  let failure
  const timer = setInterval(() => {
    if (options.isCancelled?.()) { failure = new Error('AUDIT_CANCELLED'); child.kill() }
  }, 100)
  timer.unref()
  child.stdout.on('data', chunk => {
    size += chunk.length
    if (options.maxBytes && size > options.maxBytes) { failure = new Error('PREVIEW_ENTRY_TOO_LARGE'); child.kill() }
    else stdout.push(chunk)
  })
  child.stderr.on('data', chunk => stderr.push(chunk))
  child.on('error', error => { clearInterval(timer); reject(error) })
  child.on('close', code => {
    clearInterval(timer)
    if (failure) { reject(failure); return }
    if (code !== 0) {
      reject(new Error(`7z returned code ${code}: ${Buffer.concat(stderr).toString('utf8').trim()}`))
      return
    }
    resolve(capture ? Buffer.concat(stdout) : Buffer.concat(stdout).toString('utf8'))
  })
})

const parse7zRecords = output => {
  const markerIndex = output.indexOf('----------')
  const detail = markerIndex >= 0 ? output.slice(markerIndex) : output
  return detail.split(/\r?\n\r?\n/).map(block => {
    const record = {}
    for (const line of block.split(/\r?\n/)) {
      const separator = line.indexOf(' = ')
      if (separator > 0) record[line.slice(0, separator)] = line.slice(separator + 3)
    }
    return record
  }).filter(record => record.Path && record.Folder !== '+')
}

const inspect7zArchive = async (filepath, sevenZipPath, options = {}) => {
  if (!sevenZipPath) throw new Error('7z executable is unavailable')
  const output = await run7z(sevenZipPath, ['l', filepath, '-slt', '-sccUTF-8', '-p123456'], false, options)
  const entryPaths = parse7zRecords(output)
    .map(record => normalizeEntryPath(record.Path))
    .filter(entryPath => entryPath && !entryPath.includes('__MACOSX'))
  const entries = []
  for (const entryPath of entryPaths) {
    if (options.isCancelled?.()) throw new Error('AUDIT_CANCELLED')
    const extension = path.posix.extname(entryPath).toLowerCase()
    const child = spawn(sevenZipPath, ['x', '-so', '-spd', '-p123456', '--', filepath, entryPath], { windowsHide: true })
    const isEhviewer = path.posix.basename(entryPath) === '.ehviewer'
    const completion = new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`7z returned code ${code}`)))
    })
    const digesting = digestStream(child.stdout, isEhviewer, 16 * 1024 * 1024, options.isCancelled)
    const timer = setInterval(() => { if (options.isCancelled?.()) { child.stdout.destroy(new Error('AUDIT_CANCELLED')); child.kill() } }, 100)
    timer.unref()
    child.stdout.on('error', () => child.kill())
    child.stderr.resume()
    const settled = await Promise.allSettled([digesting, completion])
    clearInterval(timer)
    const failure = settled.find(result => result.status === 'rejected')
    if (failure) throw failure.reason
    const digest = settled[0].value
    entries.push({
      path: entryPath,
      size: digest.size,
      sha256: digest.sha256,
      image: IMAGE_EXTENSIONS.has(extension),
      ehviewerBuffer: digest.buffer
    })
  }
  return entries
}

const inspectFolder = async (folderpath, options = {}) => {
  const { enumerateFolderEntries } = require('./dedupe_manifest.js')
  const manifest = options.manifest?.entries || await enumerateFolderEntries(folderpath, options)
  const entries = []
  for (const entry of manifest) {
    if (entry.unsupported) continue
    const isEhviewer = path.posix.basename(entry.path) === '.ehviewer'
    const filepath = path.join(folderpath, entry.path)
    const stream = fs.createReadStream(filepath)
    const digest = await digestStream(stream, isEhviewer, 16 * 1024 * 1024, options.isCancelled)
    entries.push({
      path: entry.path,
      size: digest.size,
      sha256: digest.sha256,
      image: entry.image,
      ehviewerBuffer: digest.buffer
    })
  }
  return entries
}

const resolveEhviewer = (entries, includeFields = false) => {
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
    token: parsed?.token ? String(parsed.token) : null,
    ...(includeFields ? { fields: selected.ehviewerBuffer ? readEhviewerFields(selected.ehviewerBuffer) : null } : {})
  }
}

const inspectBookContent = async (book, options = {}) => {
  let entries
  const extension = path.extname(book.filepath).toLowerCase()
  if (book.type === 'folder') entries = await inspectFolder(book.filepath, options)
  else if (extension === '.zip' || extension === '.cbz') entries = await inspectZip(book.filepath, options)
  else entries = await inspect7zArchive(book.filepath, options.sevenZipPath, options)

  const images = entries.filter(entry => entry.image).sort((a, b) => naturalCompare(a.path, b.path))
  const ancillary = entries.filter(entry => !entry.image).sort((a, b) => naturalCompare(a.path, b.path))
  const ehviewer = resolveEhviewer(ancillary, true)
  const imageSignature = stableId(images.map(entry => entry.sha256))
  const ancillarySignature = stableId(ancillary.map(entry => [entry.path, entry.size, entry.sha256]))
  return {
    formatVersion: 2,
    pageCount: images.length,
    imageSignature,
    imageMultisetSignature: stableId(images.map(entry => entry.sha256).sort()),
    ancillarySignature,
    folderFingerprint: options.manifest?.folderFingerprint || null,
    uncoveredEntries: options.manifest?.uncoveredEntries || [],
    images: images.map(({ path: entryPath, size, sha256 }, index) => ({ entryId: stableId(entryPath), ordinal: index + 1, path: entryPath, size, sha256, format: path.extname(entryPath).slice(1).toLowerCase() })),
    ancillary: ancillary.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
    ehviewer
  }
}

const inspectZipEhviewer = async (filepath, options) => {
  const zipfile = await openBufferedZip(filepath, options)
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
        if (!entryPath.includes('__MACOSX') && path.posix.basename(entryPath) === '.ehviewer') {
          const stream = await openZipEntry(zipfile, entry)
          const digest = await digestStream(stream, true)
          entries.push({ path: entryPath, ehviewerBuffer: digest.buffer })
        }
        zipfile.readEntry()
      } catch (error) {
        fail(error)
      }
    })
    zipfile.on('end', () => {
      if (settled) return
      settled = true
      resolve(resolveEhviewer(entries))
    })
    zipfile.readEntry()
  })
}

const inspect7zEhviewer = async (filepath, sevenZipPath, options = {}) => {
  if (!sevenZipPath) throw new Error('7z executable is unavailable')
  const output = await run7z(sevenZipPath, ['l', filepath, '-slt', '-sccUTF-8', '-p123456'], false, options)
  const candidates = parse7zRecords(output)
    .map(record => normalizeEntryPath(record.Path))
    .filter(entryPath => !entryPath.includes('__MACOSX') && path.posix.basename(entryPath) === '.ehviewer')
  const entries = []
  for (const entryPath of candidates) {
    entries.push({
      path: entryPath,
      ehviewerBuffer: await run7z(sevenZipPath, ['x', '-so', '-spd', '-p123456', '--', filepath, entryPath], true, { ...options, maxBytes: 16 * 1024 * 1024 })
    })
  }
  return resolveEhviewer(entries)
}

const inspectFolderEhviewer = async folderpath => {
  const entries = []
  const walk = async (current, relative = '') => {
    const dirents = await fs.promises.readdir(current, { withFileTypes: true })
    for (const dirent of dirents) {
      if (dirent.name === '__MACOSX') continue
      const nextRelative = normalizeEntryPath(path.posix.join(relative, dirent.name))
      const nextPath = path.join(current, dirent.name)
      if (dirent.isDirectory()) await walk(nextPath, nextRelative)
      else if (dirent.isFile() && dirent.name === '.ehviewer') {
        entries.push({ path: nextRelative, ehviewerBuffer: await fs.promises.readFile(nextPath) })
      }
    }
  }
  await walk(folderpath)
  return resolveEhviewer(entries)
}

const inspectEhviewerIdentity = async (book, options = {}) => {
  const extension = path.extname(book.filepath).toLowerCase()
  if (book.type === 'folder') return await inspectFolderEhviewer(book.filepath)
  if (extension === '.zip' || extension === '.cbz') return await inspectZipEhviewer(book.filepath, options)
  return await inspect7zEhviewer(book.filepath, options.sevenZipPath, options)
}

const inspectZipHealth = async (filepath, options) => {
  const zipfile = await openBufferedZip(filepath, options)
  const imagePaths = []
  const ehviewerEntries = []
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
        if (IMAGE_EXTENSIONS.has(path.posix.extname(entryPath).toLowerCase())) imagePaths.push(entryPath)
        if (path.posix.basename(entryPath) === '.ehviewer') {
          const stream = await openZipEntry(zipfile, entry)
          const digest = await digestStream(stream, true)
          ehviewerEntries.push({ path: entryPath, ehviewerBuffer: digest.buffer })
        }
        zipfile.readEntry()
      } catch (error) {
        fail(error)
      }
    })
    zipfile.on('end', () => {
      if (settled) return
      settled = true
      resolve({
        pageCount: imagePaths.length,
        imagePaths: imagePaths.sort(naturalCompare),
        imageSequence: analyzeImageSequence(imagePaths),
        ehviewer: resolveEhviewer(ehviewerEntries)
      })
    })
    zipfile.readEntry()
  })
}

const inspect7zHealth = async (filepath, sevenZipPath) => {
  if (!sevenZipPath) throw new Error('7z executable is unavailable')
  const output = await run7z(sevenZipPath, ['l', filepath, '-slt', '-sccUTF-8', '-p123456'])
  const entryPaths = parse7zRecords(output)
    .map(record => normalizeEntryPath(record.Path))
    .filter(entryPath => entryPath && !entryPath.includes('__MACOSX'))
  const imagePaths = entryPaths.filter(entryPath => IMAGE_EXTENSIONS.has(path.posix.extname(entryPath).toLowerCase()))
  const ehviewerEntries = []
  for (const entryPath of entryPaths.filter(value => path.posix.basename(value) === '.ehviewer')) {
    ehviewerEntries.push({
      path: entryPath,
      ehviewerBuffer: await run7z(sevenZipPath, ['x', '-so', '-p123456', '--', filepath, entryPath], true)
    })
  }
  return {
    pageCount: imagePaths.length,
    imagePaths: imagePaths.sort(naturalCompare),
    imageSequence: analyzeImageSequence(imagePaths),
    ehviewer: resolveEhviewer(ehviewerEntries)
  }
}

const inspectFolderHealth = async folderpath => {
  const dirents = await fs.promises.readdir(folderpath, { withFileTypes: true })
  const imagePaths = dirents
    .filter(dirent => dirent.isFile() && IMAGE_EXTENSIONS.has(path.extname(dirent.name).toLowerCase()))
    .map(dirent => dirent.name)
    .sort(naturalCompare)
  return {
    pageCount: imagePaths.length,
    imagePaths,
    imageSequence: analyzeImageSequence(imagePaths),
    ehviewer: await inspectFolderEhviewer(folderpath)
  }
}

const inspectBookHealth = async (book, options = {}) => {
  const extension = path.extname(book.filepath).toLowerCase()
  if (book.type === 'folder') return await inspectFolderHealth(book.filepath)
  if (extension === '.zip' || extension === '.cbz') return await inspectZipHealth(book.filepath, options)
  return await inspect7zHealth(book.filepath, options.sevenZipPath)
}

module.exports = { analyzeImageSequence, extractImageSequenceNumber, inspectBookContent, inspectEhviewerIdentity, inspectBookHealth,
  run7z, parse7zRecords, openZipEntry, resolveEhviewer }

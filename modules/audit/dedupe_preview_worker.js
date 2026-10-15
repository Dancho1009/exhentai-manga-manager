const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
const { parentPort, workerData } = require('worker_threads')
const sharp = require('sharp')
const { openBufferedZip } = require('./buffered_zip_reader.js')
const { openZipEntry, run7z } = require('./archive_inspector.js')
const { readEhviewerFields } = require('../../fileLoader/ehviewer.js')

const readBookEntry = async (book, entry, options) => {
  const maxBytes = options.maxBytes || 64 * 1024 * 1024
  if (entry.size > maxBytes) throw new Error('PREVIEW_ENTRY_TOO_LARGE')
  let buffer
  if (book.type === 'folder') {
    const root = await fs.promises.realpath(book.filepath)
    const filename = await fs.promises.realpath(path.join(root, entry.path))
    const relative = path.relative(root, filename)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('PREVIEW_ENTRY_OUTSIDE_BOOK')
    if ((await fs.promises.stat(filename)).size > maxBytes) throw new Error('PREVIEW_ENTRY_TOO_LARGE')
    buffer = await fs.promises.readFile(filename)
  } else if (['.zip', '.cbz'].includes(path.extname(book.filepath).toLowerCase())) {
    const zip = await openBufferedZip(book.filepath)
    buffer = await new Promise((resolve, reject) => {
      let settled = false
      let stream
      const finish = (error, result) => {
        if (settled) return
        settled = true
        clearInterval(timer)
        stream?.destroy()
        zip.close()
        error ? reject(error) : resolve(result)
      }
      const timer = setInterval(() => { if (options.isCancelled?.()) finish(new Error('AUDIT_CANCELLED')) }, 100)
      zip.on('error', error => finish(error))
      zip.on('end', () => finish(new Error('PREVIEW_ENTRY_MISSING')))
      zip.on('entry', async candidate => {
        if (candidate.fileName.replace(/\\/g, '/') !== entry.path) { zip.readEntry(); return }
        try {
          stream = await openZipEntry(zip, candidate)
          const chunks = []
          let size = 0
          stream.on('error', error => finish(error))
          stream.on('data', chunk => {
            size += chunk.length
            if (size > maxBytes) finish(new Error('PREVIEW_ENTRY_TOO_LARGE'))
            else chunks.push(chunk)
          })
          stream.on('end', () => finish(null, Buffer.concat(chunks)))
        } catch (error) { finish(error) }
      })
      zip.readEntry()
    })
  } else buffer = await run7z(options.sevenZipPath, ['x', '-so', '-spd', '-p123456', '--', book.filepath, entry.path], true, { ...options, maxBytes })
  if (options.isCancelled?.()) throw new Error('AUDIT_CANCELLED')
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  if (entry.sha256 !== sha256) throw new Error('DEDUPE_PREVIEW_CONTENT_CHANGED')
  return buffer
}

const runPreview = async data => {
  const flag = new Int32Array(data.cancelBuffer)
  const options = { sevenZipPath: data.sevenZipPath, isCancelled: () => Atomics.load(flag, 0) === 1 }
  await fs.promises.mkdir(data.outputDir, { recursive: true })
  const results = []
  for (const request of data.entries) {
    if (options.isCancelled()) throw new Error('AUDIT_CANCELLED')
    try {
      const buffer = await readBookEntry(request.book, request.entry, { ...options, maxBytes: data.text ? 1024 * 1024 : undefined })
      if (data.text) {
        const fields = path.basename(request.entry.path) === '.ehviewer' ? readEhviewerFields(buffer) : null
        results.push({ key: request.key, text: fields ? JSON.stringify(fields, null, 2) : buffer.toString('utf8') })
      } else {
        const metadata = await sharp(buffer).metadata()
        const filename = path.join(data.outputDir, request.key + '.jpg')
        await sharp(buffer).rotate().resize({ width: 1400, height: 1800, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toFile(filename)
        results.push({ key: request.key, path: filename, width: metadata.width, height: metadata.height, format: metadata.format, bytes: buffer.length, sha256: request.entry.sha256 })
      }
    } catch (error) {
      if (options.isCancelled()) throw error
      results.push({ key: request.key, error: error.message })
    }
  }
  return results
}

if (parentPort) runPreview(workerData).then(results => parentPort.postMessage({ results }), error => parentPort.postMessage({ error: error.message }))
module.exports = { readBookEntry, runPreview }

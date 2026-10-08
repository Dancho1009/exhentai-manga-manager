const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const AdmZip = require('adm-zip')
const yauzl = require('yauzl')
const { BufferedZipReader, openBufferedZip } = require('../modules/audit/buffered_zip_reader.js')
const { inspectBookHealth, inspectEhviewerIdentity } = require('../modules/audit/archive_inspector.js')
const { AuditCache, HEALTH_INSPECTION_VERSION } = require('../modules/audit/cache.js')
const { normalizePath } = require('../modules/audit/utils.js')
const { mapWithConcurrency } = require('../modules/audit/worker_runtime.js')

const makeRoot = async (t, beforeRemove = async () => {}) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'manga-audit-performance-'))
  t.after(async () => {
    await beforeRemove()
    await fs.promises.rm(root, { recursive: true, force: true })
  })
  return root
}

const readRange = (reader, start, length) => new Promise((resolve, reject) => {
  const buffer = Buffer.alloc(length)
  reader.read(buffer, 0, length, start, (error, count) => error ? reject(error) : resolve(buffer.subarray(0, count)))
})

test('buffered ZIP reader handles block boundaries, EOF, eviction and close', async t => {
  const root = await makeRoot(t)
  const filepath = path.join(root, 'bytes.bin')
  const source = Buffer.from(Array.from({ length: 512 }, (_, index) => index % 251))
  await fs.promises.writeFile(filepath, source)
  const handle = await fs.promises.open(filepath, 'r')
  const ioStats = {}
  const reader = new BufferedZipReader(handle, source.length, { blockSize: 64, maxBlocks: 2, ioStats })
  try {
    assert.deepEqual(await readRange(reader, 60, 12), source.subarray(60, 72))
    assert.equal(ioStats.readCalls, 2)
    assert.deepEqual(await readRange(reader, 60, 12), source.subarray(60, 72))
    assert.equal(ioStats.readCalls, 2)
    await readRange(reader, 256, 8)
    assert.equal(reader.blocks.size, 2)
    assert.equal(reader.blocks.has(0), false)
    assert.deepEqual(await readRange(reader, 510, 8), source.subarray(510))
    assert.equal((await readRange(reader, 512, 8)).length, 0)
  } finally {
    await new Promise((resolve, reject) => reader.close(error => error ? reject(error) : resolve()))
  }
  assert.equal(handle.fd, -1)
  assert.equal(reader.blocks.size, 0)
})

test('buffered ZIP inspection preserves names, gaps and identities with a large central directory', async t => {
  const root = await makeRoot(t)
  const filepath = path.join(root, 'large-directory.cbz')
  const zip = new AdmZip()
  const directory = `pages/${'long-directory-'.repeat(20)}`
  const expected = []
  for (let page = 1; page <= 1400; page += 1) {
    if (page === 19 || page === 22) continue
    const filename = `${directory}/${String(page).padStart(8, '0')}.webp`
    expected.push(filename)
    zip.addFile(filename, Buffer.from('image'))
  }
  zip.addFile('.ehviewer', Buffer.from('VERSION2\nname\n123456\nabcdef1234\n'))
  zip.addFile('__MACOSX/ignored.jpg', Buffer.from('ignored'))
  zip.addFile('notes/\u65e5\u672c\u8a9e.txt', Buffer.from('notes'))
  zip.addZipComment('zip comment')
  await fs.promises.writeFile(filepath, zip.toBuffer())
  const ioStats = {}
  const health = await inspectBookHealth({ filepath, type: 'zip' }, { ioStats })
  assert.deepEqual(health.imagePaths, expected)
  assert.equal(health.pageCount, 1398)
  assert.deepEqual(health.imageSequence.gaps[0].missingNumbers, [19, 22])
  assert.equal(health.ehviewer.gid, '123456')
  assert.deepEqual(await inspectEhviewerIdentity({ filepath, type: 'zip' }), health.ehviewer)
  assert.ok(ioStats.readCalls < 20, `metadata reads: ${ioStats.readCalls}`)

  const names = []
  const baseline = await new Promise((resolve, reject) => yauzl.open(filepath, { lazyEntries: true }, (error, file) => error ? reject(error) : resolve(file)))
  await new Promise((resolve, reject) => {
    baseline.on('error', reject)
    baseline.on('entry', entry => { names.push(entry.fileName); baseline.readEntry() })
    baseline.on('end', resolve)
    baseline.readEntry()
  })
  assert.deepEqual(names.filter(name => name.endsWith('.webp')), health.imagePaths)
})

test('invalid ZIP opening releases its file handle', async t => {
  const root = await makeRoot(t)
  const filepath = path.join(root, 'broken.zip')
  await fs.promises.writeFile(filepath, 'not a zip archive')
  const handles = []
  const original = fs.promises.open
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await original(...args)
    handles.push(handle)
    return handle
  })
  await assert.rejects(openBufferedZip(filepath), /end of central directory/i)
  assert.equal(handles.length, 1)
  assert.equal(handles[0].fd, -1)
})

test('buffered inspection retains ZIP64 support', async t => {
  const root = await makeRoot(t)
  const filepath = path.join(root, 'empty-zip64.zip')
  const record = Buffer.alloc(56)
  record.writeUInt32LE(0x06064b50, 0)
  record.writeUInt32LE(44, 4)
  record.writeUInt16LE(45, 12)
  record.writeUInt16LE(45, 14)
  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(0x07064b50, 0)
  locator.writeUInt32LE(1, 16)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0xffff, 8)
  end.writeUInt16LE(0xffff, 10)
  end.writeUInt32LE(0xffffffff, 12)
  end.writeUInt32LE(0xffffffff, 16)
  await fs.promises.writeFile(filepath, Buffer.concat([record, locator, end]))
  const result = await inspectBookHealth({ filepath, type: 'zip' })
  assert.equal(result.pageCount, 0)
  assert.equal(result.ehviewer.status, 'absent')
})

test('buffered ZIP reader handles short reads and releases its handle on an I/O failure', async t => {
  const root = await makeRoot(t)
  const filepath = path.join(root, 'bytes.bin')
  const source = Buffer.from('0123456789abcdef')
  await fs.promises.writeFile(filepath, source)
  const handle = await fs.promises.open(filepath, 'r')
  const reader = new BufferedZipReader(handle, source.length, { blockSize: 8 })
  const originalRead = fs.read
  t.mock.method(fs, 'read', (fd, buffer, offset, length, position, callback) => {
    return originalRead(fd, buffer, offset, Math.min(length, 2), position, callback)
  })
  assert.deepEqual(await readRange(reader, 0, 16), source)
  await new Promise(resolve => reader.close(resolve))
  const handles = []
  const originalOpen = fs.promises.open
  t.mock.method(fs.promises, 'open', async (...args) => {
    const opened = await originalOpen(...args)
    handles.push(opened)
    return opened
  })
  t.mock.method(fs, 'read', (...args) => {
    setImmediate(() => args.at(-1)(Object.assign(new Error('NAS read failed'), { code: 'EIO' })))
  })
  await assert.rejects(openBufferedZip(filepath), { code: 'EIO' })
  assert.equal(handles[0].fd, -1)
})

test('health cache batches preserve unchanged dedupe evidence and invalidate changed files', async t => {
  let cache
  const root = await makeRoot(t, () => cache?.close())
  cache = await AuditCache.open(root)
  const book = { filepath: path.join(root, 'sample.zip') }
  const stat = { size: 123, mtimeMs: 456 }
  const health = { pageCount: 7, ehviewer: { status: 'absent' } }
  await cache.update(book, stat, { archiveSha256: 'sha256', contentInspection: { pageCount: 7 } })
  await cache.updateHealthMany([{ book, stat, health }])
  let cached = await cache.get(book, stat)
  assert.equal(cached.archiveSha256, 'sha256')
  assert.equal(cached.contentInspection.pageCount, 7)
  let healthByPath = await cache.getHealthMany([{ raw: book, actual: stat }])
  assert.deepEqual(healthByPath.get(normalizePath(book.filepath)), health)
  assert.equal((await cache.getHealthMany([{ raw: book, actual: { ...stat, size: 124 } }])).size, 0)
  const changedStat = { size: 124, mtimeMs: 500 }
  await cache.updateHealthMany([{ book, stat: changedStat, health: { ...health, pageCount: 8 } }])
  cached = await cache.get(book, changedStat)
  assert.equal(cached.archiveSha256, null)
  assert.equal(cached.contentInspection, null)
  assert.equal(cached.healthInspection.pageCount, 8)
  await cache.db.run('UPDATE cache_entries SET healthVersion = ?', HEALTH_INSPECTION_VERSION - 1)
  healthByPath = await cache.getHealthMany([{ raw: book, actual: changedStat }])
  assert.equal(healthByPath.size, 0)
})

test('health cache batching crosses query limits and rolls back failed batches', async t => {
  let cache
  const root = await makeRoot(t, () => cache?.close())
  cache = await AuditCache.open(root)
  const entries = Array.from({ length: 205 }, (_, index) => ({
    book: { filepath: path.join(root, `${index}.zip`) },
    stat: { size: index + 1, mtimeMs: 100 },
    health: { pageCount: index + 1 }
  }))
  await cache.updateHealthMany(entries)
  assert.equal((await cache.getHealthMany(entries.map(({ book, stat }) => ({ raw: book, actual: stat })))).size, 205)
  await assert.rejects(cache.updateHealthMany([
    { ...entries[0], health: { pageCount: 999 } },
    { ...entries[1], stat: { mtimeMs: 100 } }
  ]), /NOT NULL/)
  assert.equal((await cache.get(entries[0].book, entries[0].stat)).healthInspection.pageCount, 1)
})

test('bounded concurrency drains in-flight tasks after cancellation', async () => {
  let cancelled = false
  const started = []
  const finished = []
  await assert.rejects(mapWithConcurrency([1, 2, 3, 4], 2, async item => {
    started.push(item)
    await new Promise(resolve => setTimeout(resolve, item === 1 ? 5 : 20))
    cancelled = true
    finished.push(item)
    return item
  }, () => cancelled), /AUDIT_CANCELLED/)
  assert.deepEqual(started, [1, 2])
  assert.deepEqual(finished, [1, 2])
})

test('bounded concurrency waits for remaining work before propagating an error', async () => {
  let finished = false
  await assert.rejects(mapWithConcurrency([1, 2, 3], 2, async item => {
    if (item === 1) throw new Error('read failed')
    await new Promise(resolve => setTimeout(resolve, 10))
    finished = true
    return item
  }), /read failed/)
  assert.equal(finished, true)
})

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { isPathWithinLibrary, removeLibraryPath } = require('../modules/file_deletion.js')

test('library path checks follow Windows case-insensitive boundaries', () => {
  const library = '\\\\Dancho_NAS\\home\\Library'
  assert.equal(isPathWithinLibrary('\\\\DANCHO_NAS\\HOME\\LIBRARY\\Book.zip', library), true)
  assert.equal(isPathWithinLibrary('\\\\Dancho_NAS\\home\\Library2\\Book.zip', library), false)
  assert.equal(isPathWithinLibrary(library, library), false)
})

test('library deletion verifies local trash removal before returning success', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'file-deletion-'))
  const filepath = path.join(root, 'book.zip')
  await fs.promises.writeFile(filepath, 'book')

  try {
    const result = await removeLibraryPath(filepath, {
      trashItem: async target => fs.promises.rm(target)
    })
    assert.deepEqual(result, { removed: true, alreadyMissing: false })
    await assert.rejects(fs.promises.lstat(filepath), { code: 'ENOENT' })
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

test('library deletion falls back when the recycle bin cannot handle a local file', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'file-deletion-fallback-'))
  const filepath = path.join(root, 'book.zip')
  await fs.promises.writeFile(filepath, 'book')

  try {
    await removeLibraryPath(filepath, { trashItem: async () => { throw new Error('trash unavailable') } })
    await assert.rejects(fs.promises.lstat(filepath), { code: 'ENOENT' })
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

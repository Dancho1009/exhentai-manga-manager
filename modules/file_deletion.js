const fs = require('fs')
const path = require('path')

const isNetworkPath = filepath => /^\\\\|^\/\//.test(String(filepath || ''))

const normalizeWindowsPath = filepath => path.win32.normalize(String(filepath || '').replace(/\//g, '\\')).replace(/[\\]+$/, '').toLowerCase()

const isPathWithinLibrary = (filepath, library) => {
  const target = normalizeWindowsPath(filepath)
  const root = normalizeWindowsPath(library)
  return Boolean(target && root && target !== root && target.startsWith(`${root}\\`))
}

const assertPathRemoved = async filepath => {
  try {
    await fs.promises.lstat(filepath)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  throw new Error('LIBRARY_DELETE_VERIFY_FAILED')
}

const removeLibraryPath = async (filepath, { trashItem } = {}) => {
  const target = String(filepath || '')
  if (!target) throw new Error('LIBRARY_DELETE_PATH_MISSING')

  let stats
  try {
    stats = await fs.promises.lstat(target)
  } catch (error) {
    if (error.code === 'ENOENT') return { removed: true, alreadyMissing: true }
    throw error
  }

  const recursive = stats.isDirectory()
  if (isNetworkPath(target)) {
    await fs.promises.rm(target, { recursive, force: false })
  } else {
    if (typeof trashItem !== 'function') throw new Error('LIBRARY_DELETE_TRASH_UNAVAILABLE')
    try {
      await trashItem(target)
    } catch {
      await fs.promises.rm(target, { recursive, force: false })
    }
  }

  await assertPathRemoved(target)
  return { removed: true, alreadyMissing: false }
}

module.exports = {
  isNetworkPath,
  isPathWithinLibrary,
  removeLibraryPath
}

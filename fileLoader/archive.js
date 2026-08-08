const fs = require('fs')
const path = require('path')
const { globSync } = require('glob')
const { nanoid } = require('nanoid')
const { spawn } = require('child_process')
const _ = require('lodash')
const { getRootPath } = require('../modules/utils.js')
const { readEhviewerBuffer } = require('./ehviewer.js')

const _7z = path.join(getRootPath(), 'resources/extraResources/7z.exe')
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif'])

const pickEhviewerEntryName = (entryNames) => {
  const candidates = entryNames
    .map(entryName => String(entryName).replace(/\\/g, '/').replace(/^\.\/+/, ''))
    .filter(entryName => entryName && !entryName.includes('__MACOSX') && path.posix.basename(entryName) === '.ehviewer')

  const rootCandidate = candidates.find(entryName => entryName === '.ehviewer')
  if (rootCandidate) return rootCandidate

  candidates.sort((a, b) => a.length - b.length || a.localeCompare(b))
  return candidates[0]
}

const get7zPathList = (output, excludeMacosx = false) => {
  return output
    .split(/\r?\n/)
    .filter(line => line.startsWith('Path = ') && (!excludeMacosx || !line.includes('__MACOSX')))
    .map(line => line.slice('Path = '.length))
}

const extractArchiveEntry = async (filepath, tempFolder, entryName) => {
  const output = await spawnPromise(_7z, ['x', '-o' + tempFolder, '-p123456', '--', filepath, entryName])
  const extractedFilePath = path.join(tempFolder, entryName)

  try {
    await fs.promises.access(extractedFilePath, fs.constants.R_OK)
  } catch {
    const detail = output.includes('No files to process') ? ' (7z reported no matching file)' : ''
    throw new Error(`7z did not extract "${entryName}" from "${filepath}"${detail}`)
  }

  return extractedFilePath
}

const getArchivelist = async (libraryPath) => {
  const list = globSync('**/*.@(rar|7z|cb7|cbr)', {
    cwd: libraryPath,
    nocase: true,
    nodir: true,
    follow: true,
    absolute: true
  })
  return list
}

const solveBookTypeArchive = async (filepath, TEMP_PATH, COVER_PATH) => {
  const tempFolder = path.join(TEMP_PATH, nanoid(8))
  const output = await spawnPromise(_7z, ['l', filepath, '-slt', '-sccUTF-8', '-p123456'])
  const pathlist = get7zPathList(output, true)
  let imageList = _.filter(pathlist, p => IMAGE_EXTENSIONS.has(path.extname(p).toLowerCase()))
  imageList = imageList.sort((a, b) => a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'}))

  let targetFile
  let targetFilePath
  let coverFile
  let tempCoverPath
  let coverPath
  if (imageList.length > 8) {
    targetFile = imageList[7]
    coverFile = imageList[0]
  } else if (imageList.length > 0) {
    targetFile = imageList[0]
    coverFile = imageList[0]
  } else {
    throw new Error('compression package does not include a supported image')
  }
  targetFilePath = await extractArchiveEntry(filepath, tempFolder, targetFile)
  tempCoverPath = coverFile === targetFile
    ? targetFilePath
    : await extractArchiveEntry(filepath, tempFolder, coverFile)

  coverPath = path.join(COVER_PATH, nanoid() + '.webp')

  const fileStat = await fs.promises.stat(filepath)
  return {targetFilePath, tempCoverPath, coverPath, pageCount: imageList.length, bundleSize: fileStat?.size, mtime: fileStat?.mtime}
}

const getImageListFromArchive = async (filepath, VIEWER_PATH) => {
  const tempFolder = path.join(VIEWER_PATH, nanoid(8))
  await spawnPromise(_7z, ['x', filepath, '-o' + tempFolder, '-p123456'], 2 * 60 * 1000)
  let list = globSync('**/*.@(jpg|jpeg|png|webp|avif|gif)', {
    cwd: tempFolder,
    nocase: true
  })
  list = _.filter(list, s => !_.includes(s, '__MACOSX'))
  list = list.sort((a, b) => a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'}))
  return list.map(f => ({
    relativePath: f,
    absolutePath: path.join(tempFolder, f)
  }))
}

const deleteImageFromArchive = async (filename, filepath) => {
  await spawnPromise(_7z, ['d', '-p123456', '--', filepath, filename])
  return true
}

const getEhviewerDataFromArchive = async (filepath, TEMP_PATH) => {
  const tempFolder = path.join(TEMP_PATH, nanoid(8))
  try {
    const output = await spawnPromise(_7z, ['l', filepath, '-slt', '-sccUTF-8', '-p123456'])
    const pathlist = get7zPathList(output)

    const targetEntry = pickEhviewerEntryName(pathlist)
    if (!targetEntry) return null

    const extractedFilePath = await extractArchiveEntry(filepath, tempFolder, targetEntry)
    const fileContent = await fs.promises.readFile(extractedFilePath)
    return readEhviewerBuffer(fileContent)
  } catch (error) {
    console.error('Failed to read .ehviewer from archive:', error)
    return null
  } finally {
    try {
      await fs.promises.rm(tempFolder, { recursive: true, force: true })
    } catch (cleanupError) {
      console.error('Failed to cleanup temporary .ehviewer folder:', cleanupError)
    }
  }
}

const spawnPromise = (commmand, argument, timeoutMs = 30 * 1000) => {
  return new Promise((resolve, reject) => {
    const spawned = spawn(commmand, argument)
    const output = []
    const errorOutput = []
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      spawned.kill()
      reject(new Error('7z return timeout'))
    }, timeoutMs) // 默认30s超时

    spawned.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
    spawned.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      const stdout = Buffer.concat(output).toString('utf8')
      if (code === 0) {
        resolve(stdout)
      } else {
        const stderr = Buffer.concat(errorOutput).toString('utf8').trim()
        reject(new Error(`7z returned code ${code}${stderr ? `: ${stderr}` : ''}`))
      }
    })
    spawned.stdout.on('data', data => {
      output.push(data)
    })
    spawned.stderr.on('data', data => {
      errorOutput.push(data)
    })
  })
}

module.exports = {
  getArchivelist,
  solveBookTypeArchive,
  getImageListFromArchive,
  deleteImageFromArchive,
  getEhviewerDataFromArchive
}

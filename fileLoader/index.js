const fs = require('fs')
const path = require('node:path')
const { createHash } = require('crypto')
const sharp = require('sharp')
const { getFolderlist, solveBookTypeFolder, getImageListFromFolder, deleteImageFromFolder } = require('./folder.js')
const { getArchivelist, solveBookTypeArchive, getImageListFromArchive, deleteImageFromArchive } = require('./archive.js')
const { getZipFilelist, solveBookTypeZip } = require('./zip.js')
const { TEMP_PATH, COVER_PATH, VIEWER_PATH } = require('../modules/init_folder_setting.js')

const getBookFilelist = async (library) => {
  const folderList = await getFolderlist(library)
  const archiveList = await getArchivelist(library)
  const zipList = await getZipFilelist(library)
  return [
    ...folderList.map(filepath => ({ filepath, type: 'folder' })),
    ...archiveList.map(filepath => ({ filepath, type: 'archive' })),
    ...zipList.map(filepath => ({ filepath, type: 'zip' })),
  ]
}

const geneCover = async (filepath, type, options = {}) => {
  const tempPath = options.tempPath || TEMP_PATH
  const coverPathRoot = options.coverPath || COVER_PATH
  let targetFilePath, coverPath, tempCoverPath, pageCount, bundleSize, mtime
  switch (type) {
    case 'folder':
      ;({ targetFilePath, coverPath, tempCoverPath, pageCount, bundleSize, mtime } = await solveBookTypeFolder(filepath, tempPath, coverPathRoot))
      break
    case 'zip':
      try {
        ;({ targetFilePath, coverPath, tempCoverPath, pageCount, bundleSize, mtime } = await solveBookTypeArchive(filepath, tempPath, coverPathRoot))
      } catch (e) {
        console.warn(`7z cover extraction failed for ${filepath}; retrying with adm-zip: ${e?.message || e}`)
        ;({ targetFilePath, coverPath, tempCoverPath, pageCount, bundleSize, mtime } = await solveBookTypeZip(filepath, tempPath, coverPathRoot))
      }
      break
    case 'archive':
      ;({ targetFilePath, coverPath, tempCoverPath, pageCount, bundleSize, mtime } = await solveBookTypeArchive(filepath, tempPath, coverPathRoot))
      break
  }

  const coverBuffer = await fs.promises.readFile(tempCoverPath)
  const coverHash = createHash('sha1').update(coverBuffer).digest('hex')
  await sharp(coverBuffer, { failOnError: false })
    .resize(500, 707, {
      fit: 'contain',
      background: '#303133'
    })
    .toFile(coverPath)
  const targetHash = createHash('sha1')
    .update(await fs.promises.readFile(targetFilePath))
    .digest('hex')
  return { targetFilePath, targetHash, coverPath, pageCount, bundleSize, mtime, coverHash }
}

const getImageListByBook = async (filepath, type) => {
  switch (type) {
    case 'folder':
      return await getImageListFromFolder(filepath, VIEWER_PATH)
    case 'zip':
    case 'archive':
      return await getImageListFromArchive(filepath, VIEWER_PATH)
    default:
      return await getImageListFromArchive(filepath, VIEWER_PATH)
  }
}

const deleteImageFromBook = async (filename, filepath, type) => {
  switch (type) {
    case 'folder':
      return await deleteImageFromFolder(filename, filepath)
    case 'zip':
    case 'archive':
      return await deleteImageFromArchive(filename, filepath)
    default:
      return await deleteImageFromArchive(filename, filepath)
  }
}

module.exports = {
  getBookFilelist,
  geneCover,
  getImageListByBook,
  deleteImageFromBook
}

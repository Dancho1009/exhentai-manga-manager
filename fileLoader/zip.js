const fs = require('fs')
const path = require('path')
const { globSync } = require('glob')
const AdmZip = require('adm-zip')
const { nanoid } = require('nanoid')
const _ = require('lodash')
const { readEhviewerBuffer } = require('./ehviewer.js')

const pickEhviewerEntryName = (entryNames) => {
  const candidates = entryNames
    .map(entryName => ({
      original: entryName,
      normalized: String(entryName).replace(/\\/g, '/').replace(/^\.\/+/, '')
    }))
    .filter(({ normalized }) => normalized && !normalized.includes('__MACOSX') && path.posix.basename(normalized) === '.ehviewer')

  const rootCandidate = candidates.find(({ normalized }) => normalized === '.ehviewer')
  if (rootCandidate) return rootCandidate.original

  candidates.sort((a, b) => a.normalized.length - b.normalized.length || a.normalized.localeCompare(b.normalized))
  return candidates[0]?.original
}

const getZipFilelist = async (libraryPath) => {
  const list = globSync('**/*.@(zip|cbz)', {
    cwd: libraryPath,
    nocase: true,
    nodir: true,
    follow: true,
    absolute: true
  })
  return list
}

const solveBookTypeZip = async (filepath, TEMP_PATH, COVER_PATH) => {
  const tempFolder = path.join(TEMP_PATH, nanoid(8))
  const zip = new AdmZip(filepath)
  const zipFileList = zip.getEntries()
  const findZFile = (entryName) => {
    return _.find(zipFileList, zFile => zFile.entryName == entryName)
  }
  const fileList = zipFileList.map(zFile => zFile.entryName)
  let imageList = _.filter(fileList, filepath => _.includes(['.jpg', ',jpeg', '.png', '.webp', '.avif', '.gif'], path.extname(filepath).toLowerCase()))
  imageList = imageList.sort((a, b) => a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'}))

  let targetFile
  let targetFilePath
  let coverFile
  let tempCoverPath
  let coverPath
  if (imageList.length > 8) {
    targetFile = imageList[7]
    coverFile = imageList[0]
    zip.extractEntryTo(findZFile(targetFile), tempFolder, true, true)
    zip.extractEntryTo(findZFile(coverFile), tempFolder, true, true)
  } else if (imageList.length > 0) {
    targetFile = imageList[0]
    coverFile = imageList[0]
    zip.extractEntryTo(findZFile(targetFile), tempFolder, true, true)
  } else {
    throw new Error('compression package isnot include image')
  }

  targetFilePath = path.join(tempFolder, targetFile)
  tempCoverPath = path.join(tempFolder, coverFile)

  coverPath = path.join(COVER_PATH, nanoid() + '.webp')

  const fileStat = await fs.promises.stat(filepath)
  return {targetFilePath, tempCoverPath, coverPath, pageCount: imageList.length, bundleSize: fileStat?.size, mtime: fileStat?.mtime}
}

const getImageListFromZip = async (filepath, VIEWER_PATH) => {
  const zip = new AdmZip(filepath)
  const tempFolder = path.join(VIEWER_PATH, nanoid(8))
  zip.extractAllTo(tempFolder, true)
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

const getEhviewerDataFromZip = async (filepath) => {
  try {
    const zip = new AdmZip(filepath)
    const entryName = pickEhviewerEntryName(zip.getEntries().map(entry => entry.entryName))
    if (!entryName) return null

    const entry = zip.getEntry(entryName)
    if (!entry || entry.isDirectory) return null

    return readEhviewerBuffer(entry.getData())
  } catch (error) {
    console.error('Failed to read .ehviewer from zip:', error)
    return null
  }
}

module.exports = {
  getZipFilelist,
  solveBookTypeZip,
  getImageListFromZip,
  getEhviewerDataFromZip
}

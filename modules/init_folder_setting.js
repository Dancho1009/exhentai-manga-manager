const { app } = require('electron')
const fs = require('fs')
const path = require('path')
const { getRootPath } = require('./utils.js')


let STORE_PATH = app.getPath('userData')
if (!fs.existsSync(STORE_PATH)) {
  fs.mkdirSync(STORE_PATH)
}
const rootPath = getRootPath()
let isPortable = false
try {
  const dataPath = path.join(rootPath, 'data')
  fs.accessSync(dataPath)
  STORE_PATH = dataPath
  isPortable = true
} catch {
  try {
    fs.accessSync(path.join(rootPath, 'portable'))
    STORE_PATH = rootPath
    isPortable = true
  } catch {
    STORE_PATH = app.getPath('userData')
  }
}

const TEMP_PATH = path.join(STORE_PATH, 'tmp')
const COVER_PATH = path.join(STORE_PATH, 'cover')
const VIEWER_PATH = path.join(STORE_PATH, 'viewer')

const preparePath = () => {
  fs.mkdirSync(TEMP_PATH, { recursive: true })
  fs.mkdirSync(COVER_PATH, { recursive: true })
  fs.mkdirSync(VIEWER_PATH, { recursive: true })
}

const _mange_reader = `"${path.join(getRootPath(), 'resources/extraResources/manga_reader.exe')}"`

const normalizeMatchConcurrency = (value) => {
  const number = Number.parseInt(value, 10)
  return Number.isFinite(number) && number >= 1 ? number : 1
}

const prepareSetting = () => {
  let setting
  try {
    setting = JSON.parse(fs.readFileSync(path.join(STORE_PATH, 'setting.json'), { encoding: 'utf-8' }))
    let changed = false
    if (setting.imageExplorer === '"C:\\Windows\\explorer.exe"') {
      setting.imageExplorer = _mange_reader
      changed = true
    }
    const matchConcurrency = normalizeMatchConcurrency(setting.matchConcurrency)
    if (setting.matchConcurrency !== matchConcurrency) {
      setting.matchConcurrency = matchConcurrency
      changed = true
    }
    if (changed) {
      fs.writeFileSync(path.join(STORE_PATH, 'setting.json'), JSON.stringify(setting, null, '  '), { encoding: 'utf-8' })
    }
  } catch {
    setting = {
      proxy: undefined,
      library: app.getPath('downloads'),
      metadataPath: undefined,
      imageExplorer: _mange_reader,
      pageSize: 42,
      loadOnStart: false,
      igneous: '',
      ipb_pass_hash: '',
      ipb_member_id: '',
      star: '',
      showComment: true,
      requireGap: 3000,
      thumbnailColumn: 10,
      showTranslation: false,
      theme: 'light e-hentai',
      widthLimit: undefined,
      directEnter: 'detail',
      language: 'default',
      folderTreeWidth: '',
      advancedSearch: true,
      autoCheckUpdates: false,
      customOptions: '',
      defaultExpandTree: true,
      hidePageNumber: false,
      skipDeleteConfirm: false,
      displayTitle: 'japaneseTitle',
      keepReadingProgress: true,
      matchConcurrency: 1,
    }
    fs.writeFileSync(path.join(STORE_PATH, 'setting.json'), JSON.stringify(setting, null, '  '), { encoding: 'utf-8' })
  }
  return setting
}

const prepareCollectionList = () => {
  let collectionList
  try {
    collectionList = JSON.parse(fs.readFileSync(path.join(STORE_PATH, 'collectionList.json'), { encoding: 'utf-8' }))
  } catch {
    collectionList = []
    fs.writeFileSync(path.join(STORE_PATH, 'collectionList.json'), JSON.stringify(collectionList, null, '  '), { encoding: 'utf-8' })
  }
  return collectionList
}

module.exports = {
  STORE_PATH,
  isPortable,
  TEMP_PATH,
  COVER_PATH,
  VIEWER_PATH,
  prepareSetting,
  prepareCollectionList,
  preparePath,
  _mange_reader,
  normalizeMatchConcurrency,
}

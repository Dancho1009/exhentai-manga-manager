const { app, BrowserWindow, ipcMain, session, dialog, shell, screen, Menu, clipboard, nativeImage, Tray } = require('electron')
const path = require('path')
const fs = require('fs')
const { brotliDecompress } = require('zlib')
const { promisify, format } = require('util')
const _ = require('lodash')
const { nanoid } = require('nanoid')
const sharp = require('sharp')
const { exec } = require('child_process')
const { Worker } = require('worker_threads')
const { createHash } = require('crypto')
const sqlite3 = require('sqlite3')
const { open } = require('sqlite')
const fetch = require('node-fetch')
const { HttpsProxyAgent } = require('https-proxy-agent')
const windowStateKeeper = require('electron-window-state')
const express = require('express')
const { globSync } = require('glob')

const { prepareMangaModel, prepareMetadataModel } = require('./modules/database')
const {
  createBookDetailService,
  normalizeBookId,
  normalizeBookDetailContext
} = require('./modules/book_detail.js')
const { prepareTemplate } = require('./modules/prepare_menu.js')
const { getRootPath } = require('./modules/utils.js')
const { searchNhentai, getNhentaiMetadata, getNhentaiComments } = require('./modules/nhentai.js')
const {
  checkGallerySites,
  getGalleryPage: getEhentaiGalleryPage,
  getGalleryMetadata: getEhentaiGalleryMetadata,
  extractGalleryIdentity: extractEhentaiIdentity,
  getSiteFromUrl: getEhentaiSiteFromUrl,
  isIdentityWebAvailable,
  hasUncertainSiteStatus,
  buildCookie: buildEhentaiCookie,
  toManagerMetadata: toEhentaiManagerMetadata
} = require('./modules/ehentai.js')
const { EhentaiAvailabilityCache } = require('./modules/ehentai_availability_cache.js')
const { LibraryTaskCoordinator } = require('./modules/audit/task_coordinator.js')
const { AuditJobManager } = require('./modules/audit/job_manager.js')
const { executeApprovedActions } = require('./modules/audit/action_executor.js')
const { getBookFilelist, geneCover, getImageListByBook, deleteImageFromBook } = require('./fileLoader/index.js')
const { getEhviewerDataFromArchive } = require('./fileLoader/archive.js')
const { getEhviewerDataFromZip } = require('./fileLoader/zip.js')
const { readEhviewerFile } = require('./fileLoader/ehviewer.js')
const {
  STORE_PATH, isPortable,
  TEMP_PATH, COVER_PATH, VIEWER_PATH,
  prepareSetting, prepareCollectionList, preparePath,
  _mange_reader,
  normalizeMatchConcurrency: normalizeMatchConcurrencyFromSetting,
  normalizeScanConcurrency: normalizeScanConcurrencyFromSetting
} = require('./modules/init_folder_setting.js')
const { findSameFile } = require('./fileLoader/folder.js')

const normalizeConcurrency = (value) => {
  const number = Number.parseInt(value, 10)
  return Number.isFinite(number) && number >= 1 ? number : 1
}

const normalizeMatchConcurrency = (value) => {
  return typeof normalizeMatchConcurrencyFromSetting === 'function'
    ? normalizeMatchConcurrencyFromSetting(value)
    : normalizeConcurrency(value)
}

const normalizeScanConcurrency = (value) => {
  return typeof normalizeScanConcurrencyFromSetting === 'function'
    ? normalizeScanConcurrencyFromSetting(value)
    : normalizeConcurrency(value)
}

preparePath()
let setting = prepareSetting()
let collectionList = prepareCollectionList()
let tagTranslation

const withEhentaiAvailabilityCache = async task => {
  const cache = await EhentaiAvailabilityCache.open(path.join(STORE_PATH, 'audit'))
  try {
    return await task(cache)
  } finally {
    await cache.close()
  }
}

const Manga = prepareMangaModel(path.join(STORE_PATH, './database.sqlite'))
let metadataSqliteFile
if (setting.metadataPath) {
  metadataSqliteFile = path.join(setting.metadataPath, './metadata.sqlite')
} else {
  metadataSqliteFile = path.join(STORE_PATH, './metadata.sqlite')
}
let Metadata = prepareMetadataModel(metadataSqliteFile)
const bookDetailService = createBookDetailService({ Manga, getMetadata: () => Metadata })
const libraryTaskCoordinator = new LibraryTaskCoordinator()
const auditJobManager = new AuditJobManager({ storePath: STORE_PATH, coordinator: libraryTaskCoordinator })
const sendAuditState = state => {
  if (auditWindow && !auditWindow.isDestroyed()) auditWindow.webContents.send('audit:state', state)
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('audit:lock-state', state.lock)
  if (bookDetailWindow && !bookDetailWindow.isDestroyed()) bookDetailWindow.webContents.send('book-detail:lock-state', state.lock)
}
auditJobManager.on('state', sendAuditState)
auditJobManager.on('log', entry => {
  if (auditWindow && !auditWindow.isDestroyed()) auditWindow.webContents.send('audit:log', entry)
})
const getColumns = async (sequelize, tableName) => {
  const query = `PRAGMA table_info(${tableName})`
  const [results] = await sequelize.query(query)
  return results.map(column => column.name)
}
const databaseReady = (async () => {
  const columns = await getColumns(Manga.sequelize, 'Mangas')
  if (['hiddenBook', 'readCount'].some(c => !columns.includes(c))) {
    await Manga.sync({ alter: true })
  } else {
    await Manga.sync()
  }
  await Metadata.sync()
})()

const logFile = fs.createWriteStream(path.join(STORE_PATH, 'log.txt'), { flags: 'w' })
const logStdout = process.stdout
const logStderr = process.stderr

console.log = (...message) => {
  logFile.write(format(...message) + '\n')
  logStdout.write(format(...message) + '\n')
}

console.error = (...message) => {
  logFile.write(format(...message) + '\n')
  logStderr.write(format(...message) + '\n')
}

process
  .on('unhandledRejection', (reason, promise) => {
    console.log('Unhandled Rejection at:', promise, 'reason:', reason)
  })
  .on('uncaughtException', err => {
    console.log(err, 'Uncaught Exception thrown')
    process.exit(1)
  })

const sendMessageToWebContents = (message) => {
  console.log(message)
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('send-message', message)
}

let mainWindow
let auditWindow
let bookDetailWindow
let pendingBookDetailContext
let tray
let screenWidth
let sendImageLock = false
let appIsQuitting = false

const isWindowAvailable = win => Boolean(win && !win.isDestroyed())

const sendToWindow = (win, channel, payload) => {
  if (isWindowAvailable(win)) win.webContents.send(channel, payload)
}

const notifyBookChanged = async ({ bookId, type = 'updated', sourceWebContents = null }) => {
  const normalizedBookId = normalizeBookId(bookId)
  if (!normalizedBookId) return null
  const book = type === 'deleted' ? null : await bookDetailService.getEffectiveBookById(normalizedBookId)
  const payload = { type: book ? 'updated' : 'deleted', bookId: normalizedBookId, book }

  if (isWindowAvailable(mainWindow) && mainWindow.webContents !== sourceWebContents) {
    mainWindow.webContents.send('book-detail:book-changed', payload)
  }
  if (
    isWindowAvailable(bookDetailWindow) &&
    pendingBookDetailContext?.bookId === normalizedBookId
  ) {
    bookDetailWindow.webContents.send('book-detail:book-changed', payload)
  }
  return payload
}

const notifyLibraryChanged = ({ sourceWebContents = null } = {}) => {
  const payload = { changedAt: Date.now() }
  if (isWindowAvailable(mainWindow) && mainWindow.webContents !== sourceWebContents) {
    mainWindow.webContents.send('book-detail:library-changed', payload)
  }
  sendToWindow(bookDetailWindow, 'book-detail:library-changed', payload)
}

const openExternalHttpUrl = async value => {
  const parsedUrl = new URL(String(value || ''))
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('UNSUPPORTED_URL_PROTOCOL')
  await shell.openExternal(parsedUrl.toString())
  return true
}

const getThemeBackgroundColor = theme => {
  const classes = new Set(String(theme || '').split(/\s+/).filter(Boolean))
  if (classes.has('exhentai')) return '#34353b'
  if (classes.has('e-hentai')) return '#e2e0d2'
  if (classes.has('nhentai')) return '#0d0d0d'
  return classes.has('light') ? '#ffffff' : '#141414'
}

const createTray = () => {
  if (tray) return
  const iconPath = path.join(__dirname, 'public/icon.png')
  tray = new Tray(iconPath)
  tray.setToolTip('exhentai-manga-manager')
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
        mainWindow.minimize()
      } else if (mainWindow.isMinimized()) {
        mainWindow.restore()
        mainWindow.setSkipTaskbar(false)
        mainWindow.focus()
      } else {
        mainWindow.show()
        mainWindow.setSkipTaskbar(false)
        mainWindow.focus()
      }
    }
  })
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'show window',
      click: () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) {
            mainWindow.restore()
          } else {
            mainWindow.show()
          }
          mainWindow.setSkipTaskbar(false)
          mainWindow.focus()
        }
      }
    },
    {
      label: 'exit',
      click: async () => {
        appIsQuitting = true
        await auditJobManager.interruptForExit()
        if (auditWindow && !auditWindow.isDestroyed()) auditWindow.destroy()
        if (bookDetailWindow && !bookDetailWindow.isDestroyed()) bookDetailWindow.destroy()
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy()
        app.quit()
      }
    }
  ])
  tray.setContextMenu(contextMenu)
}

const createWindow = () => {
  const mainWindowState = windowStateKeeper({
    defaultWidth: 1560,
    defaultHeight: 1000
  })
  const win = new BrowserWindow({
    'x': mainWindowState.x,
    'y': mainWindowState.y,
    'width': mainWindowState.width,
    'height': mainWindowState.height,
    webPreferences: {
      webSecurity: app.isPackaged ? true : false,
      preload: path.join(__dirname, 'preload.js')
    },
    show: false
  })
  if (app.isPackaged) {
    win.loadFile('dist/index.html')
  } else {
    win.loadURL('http://localhost:5374')
  }
  mainWindowState.manage(win)
  win.setMenuBarVisibility(false)
  win.setAutoHideMenuBar(true)
  const menu = Menu.buildFromTemplate(prepareTemplate(win))
  Menu.setApplicationMenu(menu)
  win.webContents.on('did-finish-load', () => {
    const name = require('./package.json').name
    const version = require('./package.json').version
    win.setTitle(name + ' ' + version)
  })
  win.once('ready-to-show', () => {
    if (setting.minimizeOnStart) {
      if (setting.minimizeToTray) {
        createTray()
        win.hide()
        win.setSkipTaskbar(true)
      } else {
        win.minimize()
      }
    } else {
      win.show()
    }
  })
  win.on('close', (event) => {
    if (setting.closeToTray) {
      event.preventDefault()
      createTray()
      win.hide()
      win.setSkipTaskbar(true)
    }
  })
  win.on('minimize', (event) => {
    if (setting.minimizeToTray) {
      event.preventDefault()
      createTray()
      win.hide()
      win.setSkipTaskbar(true)
    }
  })
  win.on('restore', () => {
    win.show()
    win.setSkipTaskbar(false)
  })
  win.on('show', () => {
    win.setSkipTaskbar(false)
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  return win
}

const createAuditWindow = () => {
  if (auditWindow && !auditWindow.isDestroyed()) {
    auditWindow.show()
    auditWindow.focus()
    return auditWindow
  }
  const auditWindowState = windowStateKeeper({
    defaultWidth: 1320,
    defaultHeight: 860,
    file: 'audit-window-state.json'
  })
  const win = new BrowserWindow({
    x: auditWindowState.x,
    y: auditWindowState.y,
    width: auditWindowState.width,
    height: auditWindowState.height,
    minWidth: 760,
    minHeight: 600,
    webPreferences: {
      webSecurity: app.isPackaged,
      preload: path.join(__dirname, 'audit-preload.js')
    },
    show: false
  })
  auditWindow = win
  auditWindowState.manage(win)
  win.setMenuBarVisibility(false)
  win.setAutoHideMenuBar(true)
  if (app.isPackaged) win.loadFile('dist/audit.html')
  else win.loadURL('http://localhost:5374/audit.html')
  win.once('ready-to-show', () => win.show())
  win.webContents.on('did-finish-load', () => {
    win.setTitle('exhentai-manga-manager | Library Audit')
    win.webContents.send('audit:state', auditJobManager.getState())
  })
  let closePromptOpen = false
  win.on('close', event => {
    if (appIsQuitting || !['running', 'cancelling'].includes(auditJobManager.getState().status)) return
    event.preventDefault()
    if (closePromptOpen) return
    closePromptOpen = true
    dialog.showMessageBox(win, {
      type: 'question',
      title: '任务仍在进行',
      message: '异常检查仍在后台运行。隐藏窗口并继续任务吗？',
      buttons: ['隐藏并继续', '返回'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    }).then(result => {
      if (result.response === 0 && !win.isDestroyed()) win.hide()
    }).finally(() => {
      closePromptOpen = false
    })
  })
  win.on('closed', () => {
    if (auditWindow === win) auditWindow = null
  })
  return win
}

const sendPendingBookDetailContext = () => {
  if (!isWindowAvailable(bookDetailWindow) || !pendingBookDetailContext) return
  if (bookDetailWindow.webContents.isLoadingMainFrame()) return
  bookDetailWindow.webContents.send('book-detail:open', pendingBookDetailContext)
}

const createBookDetailWindow = () => {
  if (isWindowAvailable(bookDetailWindow)) {
    if (bookDetailWindow.isMinimized()) bookDetailWindow.restore()
    bookDetailWindow.show()
    bookDetailWindow.focus()
    sendPendingBookDetailContext()
    return bookDetailWindow
  }

  const detailWindowState = windowStateKeeper({
    defaultWidth: 1280,
    defaultHeight: 860,
    file: 'book-detail-window-state.json'
  })
  const win = new BrowserWindow({
    x: detailWindowState.x,
    y: detailWindowState.y,
    width: detailWindowState.width,
    height: detailWindowState.height,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: getThemeBackgroundColor(setting.theme),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: app.isPackaged,
      preload: path.join(__dirname, 'book-detail-preload.js')
    },
    show: false
  })
  bookDetailWindow = win
  detailWindowState.manage(win)
  win.setMenuBarVisibility(false)
  win.setAutoHideMenuBar(true)
  if (app.isPackaged) win.loadFile('dist/book-detail.html')
  else win.loadURL('http://localhost:5374/book-detail.html')
  win.once('ready-to-show', () => win.show())
  win.webContents.on('did-finish-load', () => {
    win.setTitle('exhentai-manga-manager | Book Detail')
    sendPendingBookDetailContext()
    win.webContents.send('book-detail:lock-state', libraryTaskCoordinator.getState())
  })
  win.on('closed', () => {
    if (bookDetailWindow === win) bookDetailWindow = null
  })
  return win
}

app.commandLine.appendSwitch('js-flags', '--max-old-space-size=65536')
// app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  await auditJobManager.initialize()
  const primaryDisplay = screen.getPrimaryDisplay()
  screenWidth = Math.floor(primaryDisplay.workAreaSize.width * primaryDisplay.scaleFactor)
  mainWindow = createWindow()
})
app.on('activate', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow()
  }
})

app.on('ready', async () => {
  if (setting.proxy) {
    await session.defaultSession.setProxy({
      mode: 'fixed_servers',
      proxyRules: setting.proxy
    })
  }
  // session.defaultSession.loadExtension(path.join(__dirname, './devtools'))
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', event => {
  if (appIsQuitting || !['running', 'cancelling'].includes(auditJobManager.getState().status)) return
  event.preventDefault()
  appIsQuitting = true
  auditJobManager.interruptForExit().finally(() => app.quit())
})

process.on('exit', () => {
  app.quit()
})

// base function
const loadBookListFromBrFile = async () => {
  try {
    const buffer = await fs.promises.readFile(path.join(STORE_PATH, 'bookList.json.br'))
    const decodeBuffer = await promisify(brotliDecompress)(buffer)
    return JSON.parse(decodeBuffer.toString())
  } catch {
    try {
      return JSON.parse(await fs.promises.readFile(path.join(STORE_PATH, 'bookList.json'), { encoding: 'utf-8' }))
    } catch {
      return []
    }
  }
}

const loadLegecyBookListFromFile = async () => {
  const bookList = await loadBookListFromBrFile()
  try {
    shell.trashItem(path.join(STORE_PATH, 'bookList.json.br'))
    shell.trashItem(path.join(STORE_PATH, 'bookList.json'))
  } catch {
    console.log('Remove Legecy BookList Failed')
  }
  return bookList
}

const loadBookListFromDatabase = async () => {
  let bookList = await Manga.findAll()
  bookList = bookList.map(b => b.toJSON())
  if (_.isEmpty(bookList)) {
    bookList = await loadLegecyBookListFromFile()
    await saveBookListToDatabase(bookList)
  }
  let metadataList = await Metadata.findAll()
  metadataList = metadataList.map(m => m.toJSON())
  const metadataMap = new Map(metadataList.map(metadata => [metadata.hash, metadata]))
  const hashGroups = _.groupBy(bookList, 'hash')
  const conflictingHashes = new Set(Object.entries(hashGroups)
    .filter(([, books]) => {
      if (books.length < 2) return false
      const identities = new Set(books.map(book => {
        const urlIdentity = String(book.url || '').match(/\/g\/(\d+)(?:\/([0-9a-z]+))?/i)
        if (urlIdentity) return `url:${urlIdentity[1]}:${urlIdentity[2] || ''}`
        const filenameIdentity = path.basename(book.filepath || '').match(/^(\d{4,})\b/)
        return filenameIdentity ? `file:${filenameIdentity[1]}` : ''
      }).filter(Boolean))
      return identities.size !== 1
    })
    .map(([hash]) => hash))
  const bookListLength = bookList.length
  for (let i = 0; i < bookListLength; i++) {
    const book = bookList[i]
    const findMetadata = metadataMap.get(book.hash)
    if (findMetadata && !conflictingHashes.has(book.hash)) {
      if (!libraryTaskCoordinator.getState().auditRunning && book.status === 'non-tag' && findMetadata.status !== 'non-tag') await Manga.update(findMetadata, { where: { id: book.id } })
      Object.assign(book, findMetadata)
    } else if (!findMetadata && !libraryTaskCoordinator.getState().auditRunning) {
      setProgressBar((i + 1) / bookListLength)
      await Metadata.upsert(book)
    }
  }
  setProgressBar(-1)
  return bookList
}

const saveBookListToDatabase = async (data) => {
  console.log('Empty Exist BookList and Saved New BookList')
  await Manga.destroy({ truncate: true })
  await Manga.bulkCreate(data)
}

const saveBookToDatabase = async (book) => {
  await Manga.update(book, { where: { id: book.id } })
  const hashBooks = await Manga.findAll({ where: { hash: book.hash }, raw: true })
  const identities = new Set(hashBooks.map(item => {
    const urlIdentity = String(item.url || '').match(/\/g\/(\d+)(?:\/([0-9a-z]+))?/i)
    if (urlIdentity) return `url:${urlIdentity[1]}:${urlIdentity[2] || ''}`
    const filenameIdentity = path.basename(item.filepath || '').match(/^(\d{4,})\b/)
    return filenameIdentity ? `file:${filenameIdentity[1]}` : ''
  }).filter(Boolean))
  if (hashBooks.length <= 1 || identities.size === 1) await Metadata.upsert(book)
  console.log(`Saved ${book.title}`)
}

const prepareImportSqliteCopy = async (sourcePath) => {
  const tempDir = path.join(TEMP_PATH, `import_sqlite_${nanoid(8)}`)
  const sqlitePath = path.join(tempDir, path.basename(sourcePath))
  await fs.promises.mkdir(tempDir, { recursive: true })
  await fs.promises.copyFile(sourcePath, sqlitePath)
  return { tempDir, sqlitePath }
}

const prepareImportSqliteIndexes = async (sqlitePath) => {
  const db = await open({
    filename: sqlitePath,
    driver: sqlite3.Database
  })

  try {
    await db.exec('CREATE INDEX IF NOT EXISTS idx_gallery_gid_token ON gallery(gid, token)')
  } finally {
    await db.close()
  }
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const rmWithRetry = async (targetPath, options, retryCount = 20) => {
  const retryableErrors = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY'])
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      await fs.promises.rm(targetPath, options)
      return
    } catch (error) {
      if (attempt >= retryCount || !retryableErrors.has(error?.code)) throw error
      await wait(Math.min(250 * (attempt + 1), 2000))
    }
  }
}

const cleanupScanTempFolder = async (tempPath) => {
  try {
    await rmWithRetry(tempPath, { recursive: true, force: true })
  } catch (error) {
    console.log(`Cleanup scan temp folder ${tempPath} failed because ${error}`)
  }
}

const splitImportBooks = (items, workerCount) => {
  const chunks = Array.from({ length: workerCount }, () => [])
  items.forEach((item, index) => {
    chunks[index % workerCount].push(item)
  })
  return chunks.filter(chunk => chunk.length > 0)
}

const runImportSqliteWorkers = async ({ sqlitePath, bookList }) => {
  const bookById = new Map(bookList.map(book => [book.id, book]))
  const importBookList = bookList
    .filter(book => book.status !== 'tagged')
    .map(book => _.pick(book, ['id', 'status', 'filepath', 'type', 'title', 'coverHash']))

  const processedCount = importBookList.length
  if (processedCount === 0) {
    setProgressBar(1)
    return {
      matchedCount: 0,
      processedCount: 0
    }
  }

  const concurrency = Math.min(normalizeMatchConcurrency(setting.matchConcurrency), processedCount)
  const chunks = splitImportBooks(importBookList, concurrency)
  const importCopy = await prepareImportSqliteCopy(sqlitePath)

  try {
    await prepareImportSqliteIndexes(importCopy.sqlitePath)

    return await new Promise((resolve, reject) => {
      let settled = false
      let doneWorkerCount = 0
      const result = {
        matchedCount: 0,
        processedCount
      }
      let saveQueue = Promise.resolve()
      const workerProgress = new Map()
      const workerDone = new Map()
      let lastProgressSentAt = 0
      const workers = chunks.map((chunk, workerId) => {
        workerProgress.set(workerId, 0)
        workerDone.set(workerId, false)
        return new Worker(path.join(__dirname, 'modules/import_sqlite_worker.js'), {
          workerData: {
            workerId,
            sqlitePath: importCopy.sqlitePath,
            bookList: chunk,
            tempPath: TEMP_PATH,
            sevenZipPath: path.join(getRootPath(), 'resources/extraResources/7z.exe')
          }
        })
      })

      const terminateWorkers = () => {
        workers.forEach(worker => worker.terminate().catch(() => {}))
      }

      const settleReject = (error, terminateWorker = true) => {
        if (settled) return
        settled = true
        if (terminateWorker) terminateWorkers()
        reject(error instanceof Error ? error : new Error(String(error)))
      }

      const settleResolve = () => {
        if (settled) return
        settled = true
        resolve(result)
      }

      const enqueueSave = (bookId, metadata) => {
        saveQueue = saveQueue.then(async () => {
          const book = bookById.get(bookId)
          if (!book) return
          _.assign(book, metadata, { status: 'tagged' })
          await saveBookToDatabase(book)
        })
        saveQueue.catch(error => settleReject(error))
      }

      const postImportProgress = (force = false) => {
        const now = Date.now()
        if (!force && now - lastProgressSentAt < 100) return
        lastProgressSentAt = now
        const completedCount = Array.from(workerProgress.values()).reduce((sum, count) => sum + count, 0)
        setProgressBar(processedCount ? completedCount / processedCount : 1)
      }

      const finishAfterSaves = () => {
        saveQueue
          .then(settleResolve)
          .catch(error => settleReject(error, false))
      }

      workers.forEach((worker, workerId) => {
        worker.on('message', message => {
          switch (message.type) {
            case 'matched':
              enqueueSave(message.bookId, message.metadata)
              break
            case 'progress':
              workerProgress.set(message.workerId ?? workerId, message.completedCount)
              postImportProgress(message.completedCount >= chunks[workerId].length)
              break
            case 'done':
              result.matchedCount += message.matchedCount
              doneWorkerCount += 1
              workerDone.set(workerId, true)
              workerProgress.set(message.workerId ?? workerId, message.processedCount)
              postImportProgress(doneWorkerCount >= workers.length)
              if (doneWorkerCount >= workers.length) finishAfterSaves()
              break
            case 'error':
              settleReject(new Error(message.error))
              break
          }
        })

        worker.on('error', error => settleReject(error, false))
        worker.on('exit', code => {
          if (settled) return
          if (code !== 0) {
            settleReject(new Error(`Import worker ${workerId} exited with code ${code}`), false)
          } else if (!workerDone.get(workerId)) {
            settleReject(new Error(`Import worker ${workerId} exited before completing`), false)
          }
        })
      })
    })
  } finally {
    await rmWithRetry(importCopy.tempDir, { recursive: true, force: true })
  }
}

const setProgressBar = (progress) => {
  mainWindow.setProgressBar(progress)
  mainWindow.webContents.send('send-action', {
    action: 'send-progress',
    progress
  })
}

const clearFolder = async (Folder) => {
  try {
    await fs.promises.rm(Folder, { recursive: true, force: true })
    await fs.promises.mkdir(Folder, { recursive: true })
  } catch (err) {
    console.log(err)
  }
}

const runWithConcurrency = async (items, concurrencyLimit, task) => {
  const workerCount = Math.min(normalizeScanConcurrency(concurrencyLimit), items.length)
  let nextIndex = 0
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      await task(items[index], index)
    }
  })
  const results = await Promise.allSettled(workers)
  const rejected = results.find(result => result.status === 'rejected')
  if (rejected) throw rejected.reason
}

const createSerialQueue = () => {
  let queue = Promise.resolve()
  return (task) => {
    const result = queue.then(task)
    queue = result.catch(() => {})
    return result
  }
}

const createScanProgressPoster = (totalCount) => {
  const intervalMs = 100
  let completedCount = 0
  let lastSentAt = 0

  return () => {
    completedCount += 1
    const now = Date.now()
    const force = completedCount >= totalCount
    if (!force && completedCount < totalCount && now - lastSentAt < intervalMs) return
    lastSentAt = now
    setProgressBar(totalCount ? completedCount / totalCount : 1)
  }
}

const withScanTempFolder = async (task) => {
  const tempPath = path.join(TEMP_PATH, `scan_${nanoid(8)}`)
  await fs.promises.mkdir(tempPath, { recursive: true })
  try {
    return await task(tempPath)
  } finally {
    await cleanupScanTempFolder(tempPath)
  }
}

const createBookFromCoverData = (filepath, type, coverData) => {
  const { targetFilePath, targetHash, coverPath, pageCount, bundleSize, mtime, coverHash } = coverData
  if (!targetFilePath || !coverPath) return null

  const hash = targetHash || createHash('sha1').update(fs.readFileSync(targetFilePath)).digest('hex')
  return {
    title: path.basename(filepath),
    coverPath,
    hash,
    filepath,
    type,
    id: nanoid(),
    pageCount,
    bundleSize,
    mtime: mtime.toJSON(),
    coverHash,
    status: 'non-tag',
    date: Date.now()
  }
}


// library and metadata
const handleLoadBookList = async scan => {
  if (scan) {
    sendMessageToWebContents('Start loading library')
    await clearFolder(TEMP_PATH)

    const bookList = await Manga.findAll({ raw: true })
    bookList.forEach(b => b.exist = false)

    let list = await getBookFilelist(setting.library)
    if (!_.isEmpty(setting.excludeFile)) {
      let excludeRe
      try {
        excludeRe = new RegExp(setting.excludeFile)
        list = _.filter(list, file => !excludeRe.test(file.filepath))
      } catch {
        console.log('Illegal regular expressions')
      }
    }
    const listLength = list.length
    sendMessageToWebContents(`Load ${listLength} book from library`)
    const saveQueue = createSerialQueue()
    const bookListQueue = createSerialQueue()
    const postScanProgress = createScanProgressPoster(listLength)

    const scanOneBook = async (bookFile, index) => {
      try {
        const { filepath, type } = bookFile
        const foundData = await bookListQueue(() => Promise.resolve(bookList.find(b => b.filepath === filepath)))
        if (foundData === undefined) {
          /*
          * check whether the file is the relocated only
          * return the existing data if and only if there is one match
          * */
          const existingManga = await findSameFile(filepath, type, Manga)
          if (existingManga) {
            await bookListQueue(async () => {
              // the file is relocated only, so no need to regenerate the cover
              const foundPrevBook = bookList.find(b => b.id === existingManga.id)
              if (!foundPrevBook) return
              // this is necessary otherwise it will be deleted in the next step
              foundPrevBook.exist = true
              // update the Mangas table in database.sqlite
              const newCoverPath = path.join(COVER_PATH, path.basename(foundPrevBook.coverPath))
              foundPrevBook.coverPath = newCoverPath
              await saveQueue(() => Manga.update(
                { filepath: filepath, coverPath: newCoverPath },
                { where: { id: existingManga.id } }
              ))
            })
          } else {
            // this is the new file, so generate the cover
            const newBook = await withScanTempFolder(async (tempPath) => {
              const coverData = await geneCover(filepath, type, { tempPath })
              return createBookFromCoverData(filepath, type, coverData)
            })
            if (newBook) {
              newBook.exist = true
              await bookListQueue(async () => {
                bookList.push(newBook)
                await saveQueue(() => Manga.create(newBook))
              })
            }
          }
        } else {
          await bookListQueue(async () => {
            foundData.exist = true
            if (isPortable) {
              const newCoverPath = path.join(COVER_PATH, path.basename(foundData.coverPath))
              if (foundData.coverPath !== newCoverPath) {
                foundData.coverPath = newCoverPath
                await saveQueue(() => Manga.update({ coverPath: newCoverPath }, { where: { id: foundData.id } }))
              }
            }
          })
        }
      } catch (e) {
        sendMessageToWebContents(`Load ${bookFile.filepath} failed because ${e}, ${index + 1} of ${listLength}`)
      } finally {
        postScanProgress()
      }
    }

    await runWithConcurrency(list, setting.scanConcurrency, scanOneBook)
    await clearFolder(TEMP_PATH)

    const existData = bookList.filter(b => b.exist === true)
    try {
      const coverList = await fs.promises.readdir(COVER_PATH)
      const existCoverList = existData.map(b => b.coverPath)
      const removeCoverList = _.difference(coverList.map(p => path.join(COVER_PATH, p)), existCoverList)
      for (const coverPath of removeCoverList) {
        await fs.promises.rm(coverPath)
      }
    } catch (err) {
      console.log(err)
    }
    const removeData = bookList.filter(b => b.exist === false)
    for (const book of removeData) {
      await Manga.destroy({ where: { id: book.id } })
    }
    setProgressBar(-1)
  }
  return await loadBookListFromDatabase()
}

ipcMain.handle('load-book-list', async (event, scan) => {
  return scan
    ? await libraryTaskCoordinator.runMutation('scan-library', () => handleLoadBookList(true))
    : await handleLoadBookList(false)
})

const handleForceGeneBookList = async () => {
  await Manga.destroy({ truncate: true })
  await clearFolder(TEMP_PATH)
  await clearFolder(COVER_PATH)
  sendMessageToWebContents('Start loading library')
  let list = await getBookFilelist(setting.library)
  if (!_.isEmpty(setting.excludeFile)) {
    let excludeRe
    try {
      excludeRe = new RegExp(setting.excludeFile)
      list = _.filter(list, file => !excludeRe.test(file.filepath))
    } catch {
      console.log('Illegal regular expressions')
    }
  }
  const listLength = list.length
  sendMessageToWebContents(`Load ${listLength} book from library`)
  const saveQueue = createSerialQueue()
  const postScanProgress = createScanProgressPoster(listLength)

  const rebuildOneBook = async (bookFile, index) => {
    try {
      const { filepath, type } = bookFile
      const newBook = await withScanTempFolder(async (tempPath) => {
        const coverData = await geneCover(filepath, type, { tempPath })
        return createBookFromCoverData(filepath, type, coverData)
      })
      if (newBook) {
        await saveQueue(() => Manga.create(newBook))
      }
    } catch (e) {
      sendMessageToWebContents(`Load ${bookFile.filepath} failed because ${e}, ${index + 1} of ${listLength}`)
    } finally {
      postScanProgress()
    }
  }

  await runWithConcurrency(list, setting.scanConcurrency, rebuildOneBook)
  await clearFolder(TEMP_PATH)

  setProgressBar(-1)
  return await loadBookListFromDatabase()
}

ipcMain.handle('force-gene-book-list', async () => {
  return await libraryTaskCoordinator.runMutation('rebuild-library', handleForceGeneBookList)
})

const handlePatchLocalMetadata = async () => {
  const bookList = await loadBookListFromDatabase()
  const bookListLength = bookList.length
  await clearFolder(TEMP_PATH)
  await clearFolder(COVER_PATH)

  for (let i = 0; i < bookListLength; i++) {
    try {
      const book = bookList[i]
      let { filepath, type } = book
      if (!type) type = 'archive'
      const { targetFilePath, targetHash, coverPath, pageCount, bundleSize, mtime, coverHash } = await geneCover(filepath, type)
      if (targetFilePath && coverPath) {
        const hash = targetHash || createHash('sha1').update(fs.readFileSync(targetFilePath)).digest('hex')
        _.assign(book, { type, coverPath, hash, pageCount, bundleSize, mtime: mtime.toJSON(), coverHash })
        await saveBookToDatabase(book)
      }
      if ((i + 1) % 50 === 0) await clearFolder(TEMP_PATH)
      setProgressBar(i / bookListLength)
    } catch (e) {
      sendMessageToWebContents(`Patch ${bookList[i].filepath} failed because ${e}`)
    }
  }

  await clearFolder(TEMP_PATH)
  setProgressBar(-1)
  return bookList
}

ipcMain.handle('patch-local-metadata', async () => {
  return await libraryTaskCoordinator.runMutation('patch-local-metadata', handlePatchLocalMetadata)
})

const handlePatchLocalMetadataByBook = async book => {
  let { filepath, type } = book
  if (!type) type = 'archive'
  try {
    const { targetFilePath, targetHash, coverPath, pageCount, bundleSize, mtime, coverHash } = await geneCover(filepath, type)
    if (targetFilePath && coverPath) {
      const hash = targetHash || createHash('sha1').update(fs.readFileSync(targetFilePath)).digest('hex')
      await clearFolder(TEMP_PATH)
      return Promise.resolve({ coverPath, hash, pageCount, bundleSize, mtime: mtime.toJSON(), coverHash })
    }
  } catch (e) {
    sendMessageToWebContents(`Patch ${book.filepath} failed because ${e}`)
    await clearFolder(TEMP_PATH)
    return Promise.reject()
  }
}

async function getEhviewerDataManually(dir) {
  try {
    const filePath = path.join(dir, '.ehviewer')
    if (fs.existsSync(filePath)) {
      return await readEhviewerFile(filePath)
    }
    return null
  } catch (error) {
    console.error('Failed to read .ehviewer file:', error)
    return null
  }
}

async function resolveBookTypeFromPath(filepath) {
  try {
    const stat = await fs.promises.stat(filepath)
    if (stat.isDirectory()) return 'folder'
  } catch (error) {
    console.error('Failed to resolve book type from path:', error)
    return null
  }

  const ext = path.extname(filepath).toLowerCase()
  if (['.zip', '.cbz'].includes(ext)) return 'zip'
  if (['.rar', '.cbr', '.7z', '.cb7'].includes(ext)) return 'archive'
  return null
}

async function getEhviewerDataByPath(filepath, type) {
  let resolvedType = type
  if (!resolvedType) {
    resolvedType = await resolveBookTypeFromPath(filepath)
  }

  switch (resolvedType) {
    case 'folder':
      return await getEhviewerDataManually(filepath)
    case 'zip':
      return await getEhviewerDataFromZip(filepath)
    case 'archive':
      return await getEhviewerDataFromArchive(filepath, TEMP_PATH)
    default:
      return null
  }
}

ipcMain.handle('get-ehviewer-data', async (event, targetPath) => {
  return await getEhviewerDataByPath(targetPath)
})

ipcMain.handle('patch-local-metadata-by-book', async (event, book) => {
  return await libraryTaskCoordinator.runMutation('patch-local-metadata-by-book', () => handlePatchLocalMetadataByBook(book))
})

ipcMain.handle('nhentai-search', async (event, { title, filepath }) => {
  return await searchNhentai({ title, filepath, setting })
})

ipcMain.handle('nhentai-metadata', async (event, { id, url, filepath, title }) => {
  return await getNhentaiMetadata({ id, url, filepath, title, setting, storePath: STORE_PATH })
})

ipcMain.handle('nhentai-comments', async (event, { id, url, filepath, title, page, perPage }) => {
  return await getNhentaiComments({ id, url, filepath, title, page, perPage, setting })
})

ipcMain.handle('ehentai:get-availability', async (event, request = {}) => {
  const identity = request.gid && request.token
    ? { gid: request.gid, token: request.token }
    : extractEhentaiIdentity(request.url)
  if (!identity) throw new Error('INVALID_EHENTAI_URL')
  return await withEhentaiAvailabilityCache(cache => checkGallerySites({
    ...identity,
    preferredSite: request.preferredSite || getEhentaiSiteFromUrl(request.url),
    strategy: request.strategy === 'both' ? 'both' : 'fallback',
    force: Boolean(request.force),
    setting,
    cache
  }))
})

ipcMain.handle('ehentai:get-metadata', async (event, request = {}) => {
  return await withEhentaiAvailabilityCache(cache => getEhentaiGalleryMetadata({
    url: request.url,
    gid: request.gid,
    token: request.token,
    preferredSite: request.preferredSite,
    forceAvailability: Boolean(request.forceAvailability),
    setting,
    cache
  }))
})

ipcMain.handle('ehentai:get-page', async (event, request = {}) => {
  return await getEhentaiGalleryPage({ url: request.url, setting })
})

ipcMain.handle('get-ex-webpage', async (event, { url, cookie }) => {
  const requestCookie = /(?:e-hentai\.org|exhentai\.org)/i.test(String(url || ''))
    ? buildEhentaiCookie(setting)
    : cookie
  if (setting.proxy) {
    return await fetch(url, {
      headers: {
        Cookie: requestCookie
      },
      agent: new HttpsProxyAgent(setting.proxy)
    })
    .then(async res => {
      const result = await res.text()
      if (!result) throw new Error('Empty response, maybe the cookie is expired')
      return result
    })
    .catch(e => {
      sendMessageToWebContents(`Get ex page failed because ${e}`)
    })
  } else {
    return await fetch(url, {
      headers: {
        Cookie: requestCookie
      }
    })
    .then(async res => {
      const result = await res.text()
      if (!result) throw new Error('Empty response, maybe the cookie is expired')
      return result
    })
    .catch(e => {
      sendMessageToWebContents(`Get ex page failed because ${e}`)
    })
  }
})

ipcMain.handle('post-data-ex', async (event, { url, data }) => {
  if (setting.proxy) {
    return await fetch(url, {
      method: 'POST',
      body: JSON.stringify(data),
      headers: {
        'Content-Type': 'application/json'
      },
      agent: new HttpsProxyAgent(setting.proxy)
    })
    .then(res => res.text())
    .catch(e => {
      sendMessageToWebContents(`Get ex data failed because ${e}`)
    })
  } else {
    return await fetch(url, {
      method: 'POST',
      body: JSON.stringify(data),
      headers: {
        'Content-Type': 'application/json'
      }
    })
    .then(res => res.text())
    .catch(e => {
      sendMessageToWebContents(`Get ex data failed because ${e}`)
    })
  }
})

ipcMain.handle('save-book', async (event, book) => {
  return await libraryTaskCoordinator.runMutation('save-book', () => saveBookToDatabase(book))
})

ipcMain.handle('increment-read-count', async (event, bookId) => {
  if (!bookId) return false
  await Manga.increment('readCount', { by: 1, where: { id: bookId } })
  return true
})

// home
ipcMain.handle('get-folder-tree', async (event, filePathList) => {
  const librarySplitPathsLength = setting.library.split(path.sep).length - 1
  const folderList = [...new Set(filePathList.map(filepath => path.dirname(filepath)))]
  const bookPathSplitList = folderList.sort().map(fp => fp.split(path.sep).slice(librarySplitPathsLength))
  const folderTreeObject = {}
  for (const folders of bookPathSplitList) {
    _.set(folderTreeObject, folders.map(f => '_' + f), {})
  }
  const resolveTree = (preRoot, tree, initFolder) => {
    _.forIn(tree, (node, label) => {
      const trueLabel = label.slice(1)
      if (_.isEmpty(node)) {
        preRoot.push({
          label: trueLabel,
          value: trueLabel,
          folderPath: [...initFolder, trueLabel].slice(1).join(path.sep),
        })
      } else {
        preRoot.push({
          label: trueLabel,
          value: trueLabel,
          folderPath: [...initFolder, trueLabel].slice(1).join(path.sep),
          children: resolveTree([], node, [...initFolder, trueLabel]),
        })
      }
    })
    return preRoot
  }
  return resolveTree([], folderTreeObject, [])
})

ipcMain.handle('load-collection-list', async (event, arg) => {
  return collectionList
})

const saveCollectionListToFile = async list => {
  collectionList = list
  const targetPath = path.join(STORE_PATH, 'collectionList.json')
  const tempPath = path.join(STORE_PATH, 'collectionList.json.tmp')
  await fs.promises.writeFile(tempPath, JSON.stringify(list, null, '  '), { encoding: 'utf-8' })
  return await fs.promises.rename(tempPath, targetPath)
}

ipcMain.handle('save-collection-list', async (event, list) => {
  return await libraryTaskCoordinator.runMutation('save-collection-list', () => saveCollectionListToFile(list))
})

// detail
ipcMain.handle('book-detail:open-window', async (event, request = {}) => {
  await databaseReady
  const context = normalizeBookDetailContext(request)
  const book = await bookDetailService.getEffectiveBookById(context.bookId)
  if (!book) throw new Error('BOOK_NOT_FOUND')
  pendingBookDetailContext = context
  createBookDetailWindow()
  return { success: true, context }
})

ipcMain.handle('book-detail:get-bootstrap', async () => ({
  setting,
  locale: app.getLocale(),
  translation: tagTranslation || {},
  lock: libraryTaskCoordinator.getState()
}))

ipcMain.handle('book-detail:get-context', async () => pendingBookDetailContext || null)

ipcMain.handle('book-detail:get-book', async (event, bookId) => {
  await databaseReady
  const book = await bookDetailService.getEffectiveBookById(bookId)
  if (book && isWindowAvailable(bookDetailWindow) && event.sender === bookDetailWindow.webContents) {
    const title = String(book.title_jpn || book.title || path.basename(book.filepath || '') || 'Book Detail')
    bookDetailWindow.setTitle(`${title.slice(0, 100)} | exhentai-manga-manager`)
  }
  return book
})

ipcMain.handle('book-detail:get-tag-catalog', async () => {
  await databaseReady
  return await bookDetailService.getTagCatalog()
})

ipcMain.handle('book-detail:navigate', async (event, request = {}) => {
  const context = normalizeBookDetailContext(request)
  pendingBookDetailContext = context
  return context
})

ipcMain.handle('book-detail:close-window', async () => {
  if (isWindowAvailable(bookDetailWindow)) bookDetailWindow.close()
  return true
})

ipcMain.handle('book-detail:request-main-action', async (event, request = {}) => {
  const action = String(request.action || '')
  const allowedActions = new Set(['openContentView', 'openThumbnailView', 'openLocalBook', 'searchFromTag'])
  if (!allowedActions.has(action)) throw new Error('UNSUPPORTED_BOOK_DETAIL_ACTION')
  const bookId = normalizeBookId(request.bookId)
  if (action !== 'searchFromTag' && !bookId) throw new Error('INVALID_BOOK_ID')
  const payload = action === 'searchFromTag'
    ? {
        tag: String(request.payload?.tag || '').slice(0, 512),
        cat: String(request.payload?.cat || '').slice(0, 128)
      }
    : undefined
  const message = { action, bookId, payload }

  if (!isWindowAvailable(mainWindow)) mainWindow = createWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.setSkipTaskbar(false)
  mainWindow.focus()
  if (mainWindow.webContents.isLoadingMainFrame()) {
    mainWindow.webContents.once('did-finish-load', () => mainWindow.webContents.send('book-detail:main-action', message))
  } else {
    mainWindow.webContents.send('book-detail:main-action', message)
  }
  return true
})

ipcMain.handle('open-url', async (event, url) => {
  return await openExternalHttpUrl(url)
})

ipcMain.handle('show-file', async (event, filepath) => {
  shell.showItemInFolder(filepath)
})

ipcMain.handle('use-new-cover', async (event, filepath) => {
  return await libraryTaskCoordinator.runMutation('use-new-cover', async () => {
    const copyTempCoverPath = path.join(TEMP_PATH, nanoid(8) + path.extname(filepath))
    const coverPath = path.join(COVER_PATH, nanoid() + path.extname(filepath))
    try {
      await fs.promises.copyFile(filepath, copyTempCoverPath)
      await sharp(copyTempCoverPath, { failOnError: false })
      .resize(500, 707, {
        fit: 'contain',
        background: '#303133'
      })
      .toFile(coverPath)
      return coverPath
    } catch (e) {
      sendMessageToWebContents(`Generate cover from ${filepath} failed because ${e}`)
    }
  })
})

ipcMain.handle('open-local-book', async (event, filepath) => {
  if (setting.imageExplorer) {
    exec(`${setting.imageExplorer} "${filepath}"`)
  } else {
    shell.openPath(filepath)
  }
})

ipcMain.handle('get-default-manga-reader', async (event, arg) => {
  return _mange_reader
})

ipcMain.handle('delete-local-book', async (event, filepath) => {
  return await libraryTaskCoordinator.runMutation('delete-local-book', async () => {
    if (filepath.startsWith(setting.library)) {
    try {
      const stats = await fs.promises.stat(filepath)
      if (stats.isDirectory()) {
        const imageFiles = globSync('*.@(jpg|jpeg|png|webp|avif|gif)', {
          cwd: filepath,
          nocase: true,
          absolute: true
        })

        for (const imageFile of imageFiles) {
          try {
            await shell.trashItem(imageFile)
          } catch {
            await fs.promises.rm(imageFile, { force: true })
          }
        }

        const remainingFiles = await fs.promises.readdir(filepath)
        if (remainingFiles.length === 0) {
          await shell.trashItem(filepath)
        }
      } else {
        await shell.trashItem(filepath)
      }
    } catch (e) {
      sendMessageToWebContents(`Delete ${filepath} failed because ${e}`)
    }
    await Manga.destroy({ where: { filepath: filepath } })
    }
  })
})

ipcMain.handle('move-local-book', async (event, oldPath, folderArr) => {
  return await libraryTaskCoordinator.runMutation('move-local-book', async () => {
    try {
    const pathSep = require('path').sep
    const folderPath = Array.isArray(folderArr) && folderArr.length > 0 ? folderArr.join(pathSep) : ''
    const newFilePath = path.join(path.dirname(setting.library), folderPath, path.basename(oldPath))
    if (oldPath !== newFilePath) {
      await fs.promises.rename(oldPath, newFilePath)
      sendMessageToWebContents(`Move ${oldPath} to ${newFilePath} successfully`)
      return newFilePath
    } else {
      sendMessageToWebContents(`Move ${oldPath} failed because the new path is the same as the old path`)
      return false
    }
    } catch (e) {
      sendMessageToWebContents(`Move ${oldPath} failed because ${e}`)
      return false
    }
  })
})

// viewer
ipcMain.handle('load-manga-image-list', async (event, book) => {
  await clearFolder(VIEWER_PATH)

  const { filepath, type, id: bookId } = book
  const list = await getImageListByBook(filepath, type)

  sendImageLock = true
  ;(async () => {
    // 384 is the default 4K screen width divided by the default number of thumbnail columns
    const thumbnailWidth = _.isFinite(screenWidth / setting.thumbnailColumn) ? Math.floor(screenWidth / setting.thumbnailColumn) : 384
    const widthLimit = _.isNumber(setting.widthLimit) ? Math.ceil(setting.widthLimit) : screenWidth
    for (let index = 1; index <= list.length; index++) {
      if (sendImageLock) {
        let imageFilepath = list[index - 1].absolutePath
        const extname = path.extname(imageFilepath)
        if (imageFilepath.search(/[%#]/) >= 0 || type === 'folder') {
          const newFilepath = path.join(VIEWER_PATH, `rename_${nanoid(8)}${extname}`)
          await fs.promises.copyFile(imageFilepath, newFilepath)
          imageFilepath = newFilepath
        }
        let { width, height } = await sharp(imageFilepath, { failOnError: false }).metadata()
        if (widthLimit !== 0 && width > widthLimit) {
          height = Math.floor(height * (widthLimit / width))
          width = widthLimit
          const resizedFilepath = path.join(VIEWER_PATH, `resized_${nanoid(8)}.jpg`)
          switch (extname) {
            case '.gif':
              break
            default:
              await sharp(imageFilepath, { failOnError: false })
                .resize({ width })
                .toFile(resizedFilepath)
              imageFilepath = resizedFilepath
              break
          }
        }
        mainWindow.webContents.send('manga-image', {
          id: `${bookId}_${index}`,
          index,
          relativePath: list[index - 1].relativePath,
          filepath: imageFilepath,
          width, height,
          total: list.length
        })
        if (setting.viewerType !== 'comicread') {
          ;(async () => {
            let thumbnailPath = path.join(VIEWER_PATH, `thumb_${nanoid(8)}.jpg`)
            switch (extname) {
              case '.gif':
                thumbnailPath = imageFilepath
                break
              default:
                await sharp(imageFilepath, { failOnError: false })
                  .resize({ width: thumbnailWidth })
                  .toFile(thumbnailPath)
                break
            }
            mainWindow.webContents.send('manga-thumbnail-image', {
              id: `${bookId}_${index}`,
              thumbId: `thumb_${bookId}_${index}`,
              index,
              relativePath: list[index - 1].relativePath,
              filepath: imageFilepath,
              thumbnailPath,
              total: list.length
            })
          })()
        }
      }
    }
  })()

  return list
})

ipcMain.handle('release-sendimagelock', () => {
  sendImageLock = false
})

ipcMain.handle('delete-image', async (event, filename, filepath, type) => {
  return await libraryTaskCoordinator.runMutation('delete-image', () => deleteImageFromBook(filename, filepath, type))
})

// setting
ipcMain.handle('select-folder', async (event, title) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title,
    properties: ['openDirectory']
  })
  if (!result.canceled) {
    return result.filePaths[0]
  } else {
    return undefined
  }
})

ipcMain.handle('select-file', async (event, title, filters) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title,
    properties: ['openFile'],
    filters
  })
  if (!result.canceled) {
    return result.filePaths[0]
  } else {
    return undefined
  }
})

ipcMain.handle('load-setting', async (event, arg) => {
  return setting
})

ipcMain.handle('save-setting', async (event, receiveSetting) => {
  return await libraryTaskCoordinator.runMutation('save-setting', async () => {
  receiveSetting.matchConcurrency = normalizeMatchConcurrency(receiveSetting.matchConcurrency)
  receiveSetting.scanConcurrency = normalizeScanConcurrency(receiveSetting.scanConcurrency)
  if (receiveSetting.proxy) {
    await session.defaultSession.setProxy({
      mode: 'fixed_servers',
      proxyRules: receiveSetting.proxy
    })
  }
  if (receiveSetting.metadataPath !== setting.metadataPath) {
    Metadata = prepareMetadataModel(path.join(receiveSetting.metadataPath, './metadata.sqlite'))
    await Metadata.sync()
  }
  if (receiveSetting.enabledLANBrowsing !== setting.enabledLANBrowsing) {
    if (receiveSetting.enabledLANBrowsing) {
      enableLANBrowsing()
    } else {
      if (LANBrowsingInstance?.listening) {
        LANBrowsingInstance.close(() => {
          sendMessageToWebContents('LAN browsing closed')
        })
      }
    }
  }
  if (receiveSetting.startOnLogin !== setting.startOnLogin) {
    app.setLoginItemSettings({
      openAtLogin: receiveSetting.startOnLogin
    })
  }
  setting = receiveSetting
  sendToWindow(bookDetailWindow, 'book-detail:setting-changed', setting)
  if (isWindowAvailable(bookDetailWindow)) bookDetailWindow.setBackgroundColor(getThemeBackgroundColor(setting.theme))
  if (tray && !setting.minimizeToTray && !setting.closeToTray) {
    tray.destroy()
    tray = null
  }
  const targetPath = path.join(STORE_PATH, 'setting.json')
  const tempPath = path.join(STORE_PATH, 'setting.json.tmp')
  await fs.promises.writeFile(tempPath, JSON.stringify(setting, null, '  '), { encoding: 'utf-8' })
    return await fs.promises.rename(tempPath, targetPath)
  })
})

ipcMain.handle('export-database', async (event, folder) => {
  if (folder !== STORE_PATH && folder !== setting.metadataPath) {
    await fs.promises.copyFile(path.join(STORE_PATH, 'collectionList.json'), path.join(folder, 'collectionList.json'))
    await fs.promises.copyFile(metadataSqliteFile, path.join(folder, 'metadata.sqlite'))
    return true
  } else {
    sendMessageToWebContents('Export failed because the target folder is the same as the source folder')
    return false
  }
})

ipcMain.handle('import-database', async (event, arg) => {
  return await libraryTaskCoordinator.runMutation('import-database', async () => {
    const { collectionListPath, metadataSqlitePath } = arg
    if (collectionListPath && metadataSqlitePath) {
      await Metadata.sequelize.close()
      await fs.promises.copyFile(collectionListPath, path.join(STORE_PATH, 'collectionList.json'))
      await fs.promises.copyFile(metadataSqlitePath, metadataSqliteFile)
      app.relaunch()
      app.exit(0)
    } else {
      sendMessageToWebContents('Import failed because the source folder is empty')
    }
  })
})

ipcMain.handle('import-sqlite', async (event, bookList, sqlitePath) => {
  return await libraryTaskCoordinator.runMutation('import-sqlite', async () => {
  if (!sqlitePath) {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'SQLite', extensions: ['sqlite'] }]
    })
    if (result.canceled) {
      return {
        success: false,
        canceled: true
      }
    }
    sqlitePath = result.filePaths[0]
  }

  if (sqlitePath) {
    try {
      const workerResult = await runImportSqliteWorkers({
        sqlitePath,
        bookList
      })
      setProgressBar(-1)
      return {
        success: true,
        bookList,
        matchedCount: workerResult.matchedCount,
        processedCount: workerResult.processedCount
      }
    } catch (e) {
      console.log(e)
      setProgressBar(-1)
      sendMessageToWebContents(`Import api_dump.sqlite failed because ${e.message || e}`)
      return {
        success: false,
        error: e.message || String(e)
      }
    }
  }

    return {
      success: false,
      canceled: true
    }
  })
})

// audit workbench
const getMainRendererState = async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { recentRead: [], viewerReadingProgress: [] }
  try {
    return await mainWindow.webContents.executeJavaScript(`(() => {
      const parse = (key) => {
        try { return JSON.parse(localStorage.getItem(key) || '[]') } catch { return [] }
      }
      return { recentRead: parse('recentRead'), viewerReadingProgress: parse('viewerReadingProgress') }
    })()`)
  } catch {
    return { recentRead: [], viewerReadingProgress: [] }
  }
}

ipcMain.handle('audit:open-window', async () => {
  createAuditWindow()
  return auditJobManager.getState()
})

ipcMain.handle('audit:get-state', async () => auditJobManager.getState())
ipcMain.handle('audit:get-report', async () => await auditJobManager.getReport())
ipcMain.handle('audit:get-review', async () => await auditJobManager.getReview())
ipcMain.handle('audit:get-book-preview', async (event, bookId) => {
  await databaseReady
  const normalizedBookId = String(bookId || '').trim()
  if (!normalizedBookId || normalizedBookId.length > 128) return null
  const manga = await Manga.findByPk(normalizedBookId)
  if (!manga) return null
  const raw = manga.toJSON()
  const shared = raw.hash ? await Metadata.findByPk(raw.hash) : null
  const effective = { ...raw, ...(shared?.toJSON() || {}) }
  return {
    id: raw.id,
    title: effective.title || raw.title || '',
    title_jpn: effective.title_jpn || raw.title_jpn || '',
    coverPath: raw.coverPath || null
  }
})

ipcMain.handle('audit:start', async (event, request = {}) => {
  await databaseReady
  const mode = ['deep', 'online'].includes(request.mode) ? request.mode : 'quick'
  const deepScope = ['changed', 'anomalies', 'all'].includes(request.deepScope) ? request.deepScope : 'anomalies'
  const onlineScope = ['conflicts', 'urls', 'ehviewer'].includes(request.onlineScope) ? request.onlineScope : 'conflicts'
  const onlineBookIds = Array.isArray(request.onlineBookIds)
    ? [...new Set(request.onlineBookIds
      .filter(value => typeof value === 'string' || typeof value === 'number')
      .map(value => String(value).trim())
      .filter(value => value && value.length <= 128))].slice(0, 20000)
    : []
  return await auditJobManager.start({
    mode,
    deepScope,
    onlineScope,
    onlineBookIds,
    forceOnline: Boolean(request.forceOnline),
    library: setting.library,
    databasePath: path.join(STORE_PATH, 'database.sqlite'),
    metadataPath: metadataSqliteFile,
    auditStorePath: path.join(STORE_PATH, 'audit'),
    excludeFile: setting.excludeFile,
    sevenZipPath: path.join(getRootPath(), 'resources/extraResources/7z.exe'),
    ehentaiSetting: {
      proxy: setting.proxy,
      requireGap: setting.requireGap,
      igneous: setting.igneous,
      ipb_pass_hash: setting.ipb_pass_hash,
      ipb_member_id: setting.ipb_member_id,
      star: setting.star
    }
  })
})

ipcMain.handle('audit:cancel', async () => await auditJobManager.cancel())
ipcMain.handle('audit:save-review', async (event, review) => await auditJobManager.saveReview(review || {}))

ipcMain.handle('audit:execute-approved', async (event, request = {}) => {
  const defaultQuarantine = path.join(path.dirname(setting.library), 'DedupeReview')
  const quarantineRoot = request.quarantineRoot || defaultQuarantine
  const rendererState = await getMainRendererState()
  const result = await executeApprovedActions({
    jobManager: auditJobManager,
    coordinator: libraryTaskCoordinator,
    Manga,
    Metadata,
    databasePath: path.join(STORE_PATH, 'database.sqlite'),
    metadataPath: metadataSqliteFile,
    collectionList,
    saveCollectionList: saveCollectionListToFile,
    library: setting.library,
    quarantineRoot,
    rendererState,
    verifyRepairAction: async action => await withEhentaiAvailabilityCache(async cache => {
      const candidateIdentity = extractEhentaiIdentity(action.newUrl)
      if (!candidateIdentity) return { valid: false, error: 'INVALID_REPAIR_CANDIDATE_URL' }
      const candidate = await checkGallerySites({
        ...candidateIdentity,
        preferredSite: getEhentaiSiteFromUrl(action.newUrl) || 'exhentai',
        strategy: 'both',
        force: true,
        setting,
        cache
      })
      if (!isIdentityWebAvailable(candidate)) return { valid: false, error: 'REPAIR_CANDIDATE_UNAVAILABLE' }
      const currentIdentity = extractEhentaiIdentity(action.currentUrl)
      const identityChanged = currentIdentity && (
        currentIdentity.gid !== candidateIdentity.gid || currentIdentity.token !== candidateIdentity.token
      )
      if (identityChanged) {
        const current = await checkGallerySites({
          ...currentIdentity,
          preferredSite: getEhentaiSiteFromUrl(action.currentUrl) || 'exhentai',
          strategy: 'both',
          force: true,
          setting,
          cache
        })
        if (isIdentityWebAvailable(current) || hasUncertainSiteStatus(current)) {
          return { valid: false, error: 'CURRENT_GALLERY_IS_AVAILABLE_OR_UNCERTAIN' }
        }
      }
      const metadataResult = await getEhentaiGalleryMetadata({
        ...candidateIdentity,
        preferredSite: candidate.preferredSite,
        forceAvailability: false,
        setting,
        cache
      })
      if (metadataResult.gdata.status !== 'available') return { valid: false, error: 'REPAIR_GDATA_UNAVAILABLE' }
      return {
        valid: true,
        newUrl: metadataResult.preferredUrl,
        metadata: toEhentaiManagerMetadata(metadataResult.gdata.metadata)
      }
    })
  })
  collectionList = result.collectionList
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('audit:library-changed', { rendererState: result.rendererState })
  }
  return result
})

ipcMain.handle('audit:show-file', async (event, filepath) => {
  if (filepath) shell.showItemInFolder(filepath)
})

ipcMain.handle('audit:open-url', async (event, url) => {
  return await openExternalHttpUrl(url)
})

ipcMain.handle('audit:select-quarantine', async (event, defaultPath) => {
  const result = await dialog.showOpenDialog(auditWindow || mainWindow, {
    title: '选择隔离目录',
    defaultPath: defaultPath || path.dirname(setting.library),
    properties: ['openDirectory', 'createDirectory']
  })
  return result.canceled ? null : result.filePaths[0]
})


// tools

ipcMain.handle('set-progress-bar', async (event, progress) => {
  setProgressBar(progress)
})

ipcMain.handle('get-locale', async (event, arg) => {
  return app.getLocale()
})

ipcMain.handle('copy-image-to-clipboard', async (event, filepath) => {
  clipboard.writeImage(nativeImage.createFromPath(filepath))
})

ipcMain.handle('copy-text-to-clipboard', async (event, text) => {
  clipboard.writeText(text)
})

ipcMain.handle('read-text-from-clipboard', async () => {
  return clipboard.readText()
})

ipcMain.handle('update-window-title', async (event, title) => {
  const name = require('./package.json').name
  const version = require('./package.json').version
  if (title) {
    mainWindow.setTitle(name + ' ' + version + ' | ' + title)
  } else {
    mainWindow.setTitle(name + ' ' + version)
  }
})

ipcMain.handle('switch-fullscreen', async (event, arg) => {
  mainWindow.setFullScreen(!mainWindow.isFullScreen())
})

ipcMain.on('get-path-sep', async (event, arg) => {
  event.returnValue = path.sep
})


// 初始化Express
const LANBrowsing = express()
const port = 23786
const sortkey_map = {
  "date_added": {
    key: "date",
    type: "number"
  },
  "date_modified": {
    key: "mtime",
    type: "date"
  },
  "date_posted": {
    key: "posted",
    type: "number"
  },
  "size": {
    key: "bundleSize",
    type: "number"
  },
  "rating": {
    key: "rating",
    type: "number"
  },
  "read_count": {
    key: "readCount",
    type: "number"
  },
  "random": {}
}

// 设置静态文件夹
const staticFilePath = path.resolve(STORE_PATH, 'public')
fs.mkdirSync(staticFilePath, { recursive: true })
LANBrowsing.use('/static', express.static(staticFilePath))

let mangas = []

// sort
function compareItems(a, b, sortKey, ascending = false) {
  const sortConfig = sortkey_map[sortKey]
  if (!sortConfig) {
    throw new Error(`Invalid sort key: ${sortKey}`)
  }

  const { key, type } = sortConfig

  let valA = a[key]
  let valB = b[key]

  if (type === "number") {
    valA = Number(valA) || 0
    valB = Number(valB) || 0
  } else if (type === "date") {
    valA = new Date(valA).getTime() || 0
    valB = new Date(valB).getTime() || 0
  } else {
    valA = String(valA || "")
    valB = String(valB || "")
  }

  if (valA < valB) return ascending ? -1 : 1
  if (valA > valB) return ascending ? 1 : -1
  return 0
}

// 格式化标签
const formatTags = (tags) => {
  return Object.entries(tags)
    .map(([key, values]) => values.map(value => setting.showTranslation ? `${tagTranslation?.[key]?.name || key}:${tagTranslation?.[key]?.[value]?.name || value}` : `${key}:${value}`).join(', '))
    .join(', ')
}

ipcMain.handle('update-tag-translation', async (event, _tagTranslation) => {
  tagTranslation = _tagTranslation
  sendToWindow(bookDetailWindow, 'book-detail:translation-changed', tagTranslation || {})
})

LANBrowsing.get('/api/search', async (req, res) => {
  try {
    const filter = req.query.filter || ''
    const start = parseInt(req.query.start, 10) || 0
    const length = parseInt(req.query.length, 10) || 200
    // 默认使用阅读次数排序, 来匹配 mihon 热门不带 sortby
    let sortKey = req.query.sortby || 'read_count'
    let showAll = false
    if (sortKey.includes("_all")) {
      sortKey = sortKey.replace("_all", "")
      showAll = true
    }

    // 读取并搜索数据库
    mangas = await loadBookListFromDatabase()
    let filterMangas
    if (filter) {
      filterMangas = mangas.filter(manga => {
        return JSON.stringify(_.pick(manga, ['title', 'title_jpn', 'status', 'category', 'filepath', 'url'])).toLowerCase().includes(filter.toLowerCase())
        || formatTags(manga.tags).toLowerCase().includes(filter.toLowerCase())
      })
    } else {
      filterMangas = mangas
    }

    if (sortKey !== 'random') {
      filterMangas = filterMangas.sort((a, b) => compareItems(a, b, sortKey))
    } else {
      filterMangas = _.shuffle(filterMangas)
    }
    filterMangas = showAll ? filterMangas : filterMangas.slice(start, start + length)

    // 格式化响应数据
    const responseData = filterMangas.map(manga => ({
      arcid: manga.hash,
      extension: path.extname(manga.filepath),
      filename: path.basename(manga.filepath),
      isnew: 'true',
      lastreadtime: 0,
      pagecount: manga.pageCount,
      progress: 0,
      size: manga.filesize,
      summary: null,
      tags: manga.tags ? formatTags(manga.tags) : '',
      title: `${manga.title_jpn && manga.title ? `${manga.title_jpn} || ${manga.title}` : manga.title}`,
      category: manga.category,
      url: manga.url
    }))
    const hash = createHash('md5').update(JSON.stringify(responseData)).digest('hex')
    res.json({
      data: responseData,
      hash,
      draw: 0,
      recordsFiltered: responseData.length,
      recordsTotal: filterMangas.length
    })
  } catch (error) {
    res.status(500).send(error.message)
  }
})

LANBrowsing.get('/api/search/random', async (req, res) => {
  try {
    // 从数据库中随机获取指定数量的 Manga 记录
    const count = parseInt(req.query.count, 10) || 1
    const randomMangas = _.sampleSize(await loadBookListFromDatabase(), count)

    const responseData = randomMangas.map(manga => ({
      arcid: manga.hash,
      extension: path.extname(manga.filepath),
      filename: path.basename(manga.filepath),
      isnew: 'true',
      lastreadtime: 0,
      pagecount: manga.pageCount,
      progress: 0,
      size: manga.filesize,
      summary: null,
      tags: manga.tags ? formatTags(manga.tags) : '',
      title: `${manga.title_jpn && manga.title ? `${manga.title_jpn} || ${manga.title}` : manga.title}`,
      category: manga.category,
    }))

    res.json({
      data: responseData
    })
  } catch (error) {
    console.error('Failed to fetch random Manga:', error)
    res.status(500).send('Internal Server Error')
  }
})

LANBrowsing.get('/api/archives/:hash/metadata', async (req, res) => {
  try {
    const mangaHash = req.params.hash

    // 从数据库找到对应的漫画
    if (_.isEmpty(mangas)) mangas = await loadBookListFromDatabase()
    const manga = await mangas.find(manga => manga.hash === mangaHash)

    if (!manga) {
      return res.status(404).send('Manga not found')
    }

    // 构造响应数据
    const responseMetadata = {
      arcid: manga.hash,
      extension: path.extname(manga.filepath),
      filename: path.basename(manga.filepath),
      isnew: 'true',
      lastreadtime: 0,
      pagecount: manga.pageCount,
      progress: 0,
      size: manga.filesize,
      summary: null,
      tags: manga.tags ? formatTags(manga.tags) : '',
      title: `${manga.title_jpn && manga.title ? `${manga.title_jpn} || ${manga.title}` : manga.title}`,
      category: manga.category,
    }

    res.json(responseMetadata)
  } catch (error) {
    res.status(500).send(error.message)
  }
})

// 处理封面图片请求
LANBrowsing.get('/api/archives/:hash/thumbnail', async (req, res) => {
  const hash = req.params.hash
  const manga = await Manga.findOne({where: {hash: hash}})
  if (!manga || !manga.coverPath) {
    return res.status(404).send('Cover not found')
  }
  const coverFilePath = path.join(staticFilePath, path.basename(manga.coverPath))
  await fs.promises.copyFile(manga.coverPath, coverFilePath)
  if (fs.existsSync(coverFilePath)) {
    res.sendFile(coverFilePath)
  } else {
    res.status(404).send('Cover file not found')
  }
})

let existBook = {
  hash: null,
  imageList: []
}

// 处理章节列表请求
LANBrowsing.get('/api/archives/:hash/files', async (req, res) => {
  try {
    const mangaHash = req.params.hash

    // 从数据库找到对应的漫画
    const manga = await Manga.findOne({where: {hash: mangaHash}})

    if (!manga) {
      return res.status(404).send('Manga not found')
    }

    await clearFolder(VIEWER_PATH)
    await clearFolder(staticFilePath)
    const imageList = await getImageListByBook(manga.filepath, manga.type)

    existBook = {
      hash: manga.hash,
      imageList: imageList.map(p => p.absolutePath)
    }
    // 构造响应数据
    const responseFiles = {
      job: Date.now(), // 示例中的 job 可以是一个随机数或时间戳
      pages: imageList.map((file, index) => `/api/archives/${manga.hash}/page?path=${index + 1}`)
    }

    res.json(responseFiles)
  } catch (error) {
    res.status(500).send(error.message)
  }
})

// 处理章节图片请求
LANBrowsing.get('/api/archives/:hash/page', async (req, res) => {
  const hash = req.params.hash
  const page = parseInt(req.query.path, 10)
  if (isNaN(page) || page < 1) {
    return res.status(400).send('Invalid page number')
  }

  const manga = await Manga.findOne({where: {hash: hash}})
  if (!manga || !manga.filepath) {
    return res.status(404).send('File not found')
  }

  // 获取章节图片列表
  try {
    let imageList
    if (manga.hash === existBook.hash) {
      imageList = existBook.imageList
    } else {
      await clearFolder(VIEWER_PATH)
      await clearFolder(staticFilePath)
      imageList = await getImageListByBook(manga.filepath, manga.type)
      imageList = imageList.map(p => p.absolutePath)
      existBook.hash = manga.hash
      existBook.imageList = imageList
    }
    const imageFilePath = imageList[page - 1]
    if (!imageFilePath) {
      return res.status(404).send('Image not found')
    }

    // 重命名并复制图片文件到静态文件夹
    const imageFileName = `${manga.hash}_${page}${path.extname(imageFilePath)}`
    const imageFile = path.join(staticFilePath, imageFileName)
    await fs.promises.copyFile(imageFilePath, imageFile)

    // 发送图片文件
    if (fs.existsSync(imageFile)) {
      res.sendFile(imageFile)
    } else {
      res.status(404).send('Image file not found')
    }
  } catch (err) {
    console.error(err)
    res.status(500).send('Error processing file')
  }
})

// 处理webview请求
LANBrowsing.get('/reader', async (req, res) => {
  const id = req.query.id
  const manga = await Manga.findOne({where: {hash: id}})

  // 重定向至manga.url
  if (manga && manga.url) {
    res.redirect(manga.url.replace('exhentai', 'e-hentai'))
  } else {
    res.status(404).send('Manga not found')
  }
})

LANBrowsing.get('/', (req, res) => {
  switch (setting.language) {
    case 'en-US':
      res.redirect('https://github.com/SchneeHertz/exhentai-manga-manager/wiki/LAN-Browsing')
      break
    case 'zh-CN':
    case 'zh-TW':
    default:
      res.redirect('https://github.com/SchneeHertz/exhentai-manga-manager/wiki/%E5%B1%80%E5%9F%9F%E7%BD%91%E6%B5%8F%E8%A7%88')
      break
  }
})

let LANBrowsingInstance
// 启动Express服务器
const enableLANBrowsing = () => {
  if (LANBrowsingInstance?.listening) {
    LANBrowsingInstance.close(() => {
      LANBrowsingInstance = LANBrowsing.listen(port, '0.0.0.0', () => {
        sendMessageToWebContents(`LAN browsing restart and listening at http://0.0.0.0:${port}`)
      })
    })
  } else {
    LANBrowsingInstance = LANBrowsing.listen(port, '0.0.0.0', () => {
      sendMessageToWebContents(`LAN browsing listening at http://0.0.0.0:${port}`)
    })
  }
}

ipcMain.handle('enable-LAN-browsing', async (event, arg) => {
  enableLANBrowsing()
})

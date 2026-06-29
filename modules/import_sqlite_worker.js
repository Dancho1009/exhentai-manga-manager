const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const { parentPort, workerData } = require('worker_threads')
const sqlite3 = require('sqlite3')
const { open } = require('sqlite')
const _ = require('lodash')
const { nanoid } = require('nanoid')

const { getEhviewerDataFromZip } = require('../fileLoader/zip.js')
const { readEhviewerFile } = require('../fileLoader/ehviewer.js')
const { readEhviewerBuffer } = require('../fileLoader/ehviewer.js')

const { sqlitePath, bookList, concurrency, tempPath, sevenZipPath } = workerData

const normalizeMatchConcurrency = (value) => {
  const number = Number.parseInt(value, 10)
  return Number.isFinite(number) && number >= 1 ? number : 1
}

const runWithConcurrency = async (items, concurrencyLimit, task) => {
  const workerCount = Math.min(normalizeMatchConcurrency(concurrencyLimit), items.length)
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

const spawnPromise = (commmand, argument, timeoutMs = 30 * 1000) => {
  return new Promise((resolve, reject) => {
    const spawned = spawn(commmand, argument)
    const output = []
    const timeout = setTimeout(() => {
      spawned.kill()
      reject(new Error('7z return timeout'))
    }, timeoutMs)

    spawned.on('error', data => {
      clearTimeout(timeout)
      reject(data)
    })
    spawned.on('exit', code => {
      clearTimeout(timeout)
      if (code === 0) {
        resolve(Buffer.concat(output).toString())
      } else {
        reject(new Error('close code is ' + code))
      }
    })
    spawned.stdout.on('data', data => {
      output.push(data)
    })
  })
}

const pickEhviewerEntryName = (entryNames) => {
  const candidates = entryNames
    .map(entryName => String(entryName).replace(/\\/g, '/').replace(/^\.\/+/, ''))
    .filter(entryName => entryName && !entryName.includes('__MACOSX') && path.posix.basename(entryName) === '.ehviewer')

  const rootCandidate = candidates.find(entryName => entryName === '.ehviewer')
  if (rootCandidate) return rootCandidate

  candidates.sort((a, b) => a.length - b.length || a.localeCompare(b))
  return candidates[0]
}

const getEhviewerDataFromArchive = async (filepath) => {
  const tempFolder = path.join(tempPath, nanoid(8))
  try {
    const output = await spawnPromise(sevenZipPath, ['l', filepath, '-slt', '-sccUTF-8', '-p123456'])
    let pathlist = _.filter(output.split(/\r\n/), s => _.startsWith(s, 'Path'))
    pathlist = pathlist.map(p => {
      const match = /(?<== ).*$/.exec(p)
      return match ? match[0] : ''
    })

    const targetEntry = pickEhviewerEntryName(pathlist)
    if (!targetEntry) return null

    await spawnPromise(sevenZipPath, ['x', '-o' + tempFolder, '-p123456', '--', filepath, targetEntry])
    const extractedFilePath = path.join(tempFolder, targetEntry)
    const fileContent = await fs.promises.readFile(extractedFilePath)
    return readEhviewerBuffer(fileContent)
  } catch {
    return null
  } finally {
    try {
      await fs.promises.rm(tempFolder, { recursive: true, force: true })
    } catch {
    }
  }
}

const resolveBookTypeFromPath = async (filepath) => {
  try {
    const stat = await fs.promises.stat(filepath)
    if (stat.isDirectory()) return 'folder'
  } catch {
    return null
  }

  const ext = path.extname(filepath).toLowerCase()
  if (['.zip', '.cbz'].includes(ext)) return 'zip'
  if (['.rar', '.cbr', '.7z', '.cb7'].includes(ext)) return 'archive'
  return null
}

const getEhviewerDataManually = async (dir) => {
  try {
    const filePath = path.join(dir, '.ehviewer')
    if (fs.existsSync(filePath)) {
      return await readEhviewerFile(filePath)
    }
    return null
  } catch {
    return null
  }
}

const getEhviewerDataByPath = async (filepath, type) => {
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
      return await getEhviewerDataFromArchive(filepath)
    default:
      return null
  }
}

const normalizeMetadata = (metadata) => {
  const re = /'/g
  metadata.tags = {
    language: metadata.language ? JSON.parse(metadata.language.replace(re, '\"')) : undefined,
    parody: metadata.parody ? JSON.parse(metadata.parody.replace(re, '\"')) : undefined,
    character: metadata.character ? JSON.parse(metadata.character.replace(re, '\"')) : undefined,
    group: metadata.group ? JSON.parse(metadata.group.replace(re, '\"')) : undefined,
    artist: metadata.artist ? JSON.parse(metadata.artist.replace(re, '\"')) : undefined,
    male: metadata.male ? JSON.parse(metadata.male.replace(re, '\"')) : undefined,
    female: metadata.female ? JSON.parse(metadata.female.replace(re, '\"')) : undefined,
    mixed: metadata.mixed ? JSON.parse(metadata.mixed.replace(re, '\"')) : undefined,
    other: metadata.other ? JSON.parse(metadata.other.replace(re, '\"')) : undefined,
    cosplayer: metadata.cosplayer ? JSON.parse(metadata.cosplayer.replace(re, '\"')) : undefined,
    rest: metadata.rest ? JSON.parse(metadata.rest.replace(re, '\"')) : undefined,
  }
  metadata.filecount = +metadata.filecount
  metadata.rating = +metadata.rating
  metadata.posted = +metadata.posted
  metadata.filesize = +metadata.filesize
  metadata.url = `https://exhentai.org/g/${metadata.gid}/${metadata.token}/`
  return _.pick(metadata, ['tags', 'title', 'title_jpn', 'filecount', 'rating', 'posted', 'filesize', 'category', 'url'])
}

const matchBook = async (db, book) => {
  let metadata
  const ehviewerData = await getEhviewerDataByPath(book.filepath, book.type)
  const { gid, token } = ehviewerData || {}
  if (gid && token) {
    metadata = await db.get('SELECT * FROM gallery WHERE gid = ? AND token = ?', [gid, token])
  }
  if (metadata === undefined) {
    const filename = path.parse(book.title).name
    metadata = await db.get(`SELECT * FROM gallery WHERE torrents LIKE ?
                                                    OR title LIKE ?
                                                    OR title_jpn LIKE ?
                                                    OR thumb LIKE ?`,
      `%${filename}%`,
      `%${filename}%`,
      `%${filename}%`,
      `%${book.coverHash}%`
    )
  }

  if (!metadata) return null
  return normalizeMetadata(metadata)
}

const postProgress = (completedCount, processedCount) => {
  parentPort.postMessage({
    type: 'progress',
    progress: processedCount ? completedCount / processedCount : 1
  })
}

const createProgressPoster = (processedCount) => {
  const intervalMs = 100
  let lastSentAt = 0
  return (completedCount, force = false) => {
    const now = Date.now()
    if (!force && completedCount < processedCount && now - lastSentAt < intervalMs) return
    lastSentAt = now
    postProgress(completedCount, processedCount)
  }
}

;(async () => {
  const pendingBookList = bookList.filter(book => book.status !== 'tagged')
  const processedCount = pendingBookList.length
  let matchedCount = 0
  let completedCount = 0
  const postThrottledProgress = createProgressPoster(processedCount)
  const db = await open({
    filename: sqlitePath,
    driver: sqlite3.Database
  })

  try {
    await runWithConcurrency(pendingBookList, concurrency, async (book) => {
      try {
        const metadata = await matchBook(db, book)
        if (metadata) {
          matchedCount += 1
          parentPort.postMessage({
            type: 'matched',
            bookId: book.id,
            metadata
          })
        }
      } finally {
        completedCount += 1
        postThrottledProgress(completedCount, completedCount >= processedCount)
      }
    })
    parentPort.postMessage({
      type: 'done',
      matchedCount,
      processedCount
    })
  } finally {
    await db.close()
  }
})().catch(error => {
  parentPort.postMessage({
    type: 'error',
    error: error.message || String(error)
  })
})

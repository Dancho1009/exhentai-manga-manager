const path = require('path')

const MAX_BOOK_ID_LENGTH = 128
const MAX_NAVIGATION_ITEMS = 20000

const normalizeBookId = value => {
  const bookId = String(value || '').trim()
  if (!bookId || bookId.length > MAX_BOOK_ID_LENGTH) return null
  return bookId
}

const normalizeBookDetailContext = request => {
  const bookId = normalizeBookId(request?.bookId)
  if (!bookId) throw new Error('INVALID_BOOK_ID')

  const navigationIds = []
  const seen = new Set()
  for (const value of Array.isArray(request?.navigationIds) ? request.navigationIds : []) {
    const id = normalizeBookId(value)
    if (!id || seen.has(id)) continue
    seen.add(id)
    navigationIds.push(id)
    if (navigationIds.length >= MAX_NAVIGATION_ITEMS) break
  }
  if (!seen.has(bookId)) {
    if (navigationIds.length >= MAX_NAVIGATION_ITEMS) navigationIds.pop()
    navigationIds.unshift(bookId)
  }

  return { bookId, navigationIds }
}

const createBookDetailWindowRegistry = ({ isWindowAvailable = win => Boolean(win && !win.isDestroyed?.()) } = {}) => {
  const entries = new Map()

  const prune = () => {
    for (const [windowId, entry] of entries) {
      if (!isWindowAvailable(entry.window)) entries.delete(windowId)
    }
  }

  const getWindowId = win => Number.isInteger(win?.id) ? win.id : null

  const register = (win, context) => {
    const windowId = getWindowId(win)
    if (windowId === null) throw new Error('INVALID_BOOK_DETAIL_WINDOW')
    const entry = { window: win, context }
    entries.set(windowId, entry)
    return entry
  }

  const unregister = win => {
    const windowId = getWindowId(win)
    if (windowId === null) return false
    return entries.delete(windowId)
  }

  const getByWindow = win => {
    prune()
    const windowId = getWindowId(win)
    return windowId === null ? null : entries.get(windowId) || null
  }

  const getBySender = sender => {
    prune()
    for (const entry of entries.values()) {
      if (entry.window.webContents === sender) return entry
    }
    return null
  }

  const findByBookId = bookId => {
    prune()
    const normalizedBookId = normalizeBookId(bookId)
    if (!normalizedBookId) return null
    for (const entry of entries.values()) {
      if (entry.context?.bookId === normalizedBookId) return entry
    }
    return null
  }

  const updateContextBySender = (sender, context) => {
    const entry = getBySender(sender)
    if (!entry) return null
    entry.context = context
    return entry
  }

  const forEachWindow = callback => {
    prune()
    for (const entry of entries.values()) callback(entry.window, entry)
  }

  const broadcast = (channel, payload, { excludeSender = null } = {}) => {
    forEachWindow(win => {
      if (win.webContents !== excludeSender) win.webContents.send(channel, payload)
    })
  }

  const destroyAll = () => {
    forEachWindow(win => win.destroy())
    entries.clear()
  }

  return {
    get size() {
      prune()
      return entries.size
    },
    register,
    unregister,
    getByWindow,
    getBySender,
    findByBookId,
    updateContextBySender,
    forEachWindow,
    broadcast,
    destroyAll
  }
}

const getBookIdentity = book => {
  const urlIdentity = String(book?.url || '').match(/\/g\/(\d+)(?:\/([0-9a-z]+))?/i)
  if (urlIdentity) return `url:${urlIdentity[1]}:${urlIdentity[2] || ''}`
  const filenameIdentity = path.basename(book?.filepath || '').match(/^(\d{4,})\b/)
  return filenameIdentity ? `file:${filenameIdentity[1]}` : ''
}

const hasConflictingHashIdentities = books => {
  if (!Array.isArray(books) || books.length < 2) return false
  const identities = new Set(books.map(getBookIdentity).filter(Boolean))
  return identities.size !== 1
}

const mergeEffectiveBook = ({ manga, metadata, hashPeers = [] }) => {
  if (!manga) return null
  if (!metadata || hasConflictingHashIdentities(hashPeers)) return { ...manga }
  return { ...manga, ...metadata, id: manga.id, filepath: manga.filepath, coverPath: manga.coverPath }
}

const appendTags = (catalog, tags) => {
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return
  for (const [namespace, values] of Object.entries(tags)) {
    if (!Array.isArray(values)) continue
    if (!catalog.has(namespace)) catalog.set(namespace, new Set())
    const target = catalog.get(namespace)
    for (const value of values) {
      const tag = String(value || '').trim()
      if (tag) target.add(tag)
    }
  }
}

const toPlainRow = row => row?.toJSON ? row.toJSON() : { ...row }

const matchesBookSearch = (book, request = {}) => {
  if (request.readCount !== undefined) {
    return Number(book?.readCount || 0) === Number(request.readCount)
  }
  if (request.pageDiff) {
    return Number.isInteger(book?.filecount) &&
      Number.isInteger(book?.pageCount) &&
      Math.abs(book.filecount - book.pageCount) > 5
  }

  const rawTag = String(request.tag || '').trim()
  const namespace = String(request.cat || '').trim()
  if (!rawTag) return false

  if (!namespace && rawTag.startsWith('cat:')) {
    return String(book?.category || '') === rawTag.slice(4)
  }
  if (!namespace && ['non-tag', 'tagged', 'tag-failed'].includes(rawTag)) {
    return book?.status === rawTag
  }
  if (namespace) {
    return Array.isArray(book?.tags?.[namespace]) && book.tags[namespace].includes(rawTag)
  }
  return Object.values(book?.tags || {}).some(values => Array.isArray(values) && values.includes(rawTag))
}

const createBookDetailService = ({ Manga, getMetadata }) => {
  let tagCatalogCache = null

  const getEffectiveBooks = async () => {
    const Metadata = getMetadata()
    const [mangaRows, metadataRows] = await Promise.all([
      Manga.findAll({ raw: true }),
      Metadata.findAll({ raw: true })
    ])
    const mangas = mangaRows.map(toPlainRow)
    const metadataMap = new Map(metadataRows.map(row => {
      const metadata = toPlainRow(row)
      return [metadata.hash, metadata]
    }))
    const hashPeers = new Map()
    for (const manga of mangas) {
      if (!manga.hash) continue
      if (!hashPeers.has(manga.hash)) hashPeers.set(manga.hash, [])
      hashPeers.get(manga.hash).push(manga)
    }
    return mangas.map(manga => mergeEffectiveBook({
      manga,
      metadata: manga.hash ? metadataMap.get(manga.hash) : null,
      hashPeers: manga.hash ? hashPeers.get(manga.hash) : []
    }))
  }

  const getEffectiveBookById = async value => {
    const bookId = normalizeBookId(value)
    if (!bookId) return null
    const mangaModel = await Manga.findByPk(bookId)
    if (!mangaModel) return null

    const manga = mangaModel.toJSON ? mangaModel.toJSON() : { ...mangaModel }
    if (!manga.hash) return manga

    const Metadata = getMetadata()
    const [metadataModel, hashPeers] = await Promise.all([
      Metadata.findByPk(manga.hash),
      Manga.findAll({ where: { hash: manga.hash }, raw: true })
    ])
    const metadata = metadataModel?.toJSON ? metadataModel.toJSON() : metadataModel
    return mergeEffectiveBook({ manga, metadata, hashPeers })
  }

  const getTagCatalog = async ({ force = false } = {}) => {
    if (tagCatalogCache && !force) return tagCatalogCache
    const Metadata = getMetadata()
    const [mangaRows, metadataRows] = await Promise.all([
      Manga.findAll({ attributes: ['tags'], raw: true }),
      Metadata.findAll({ attributes: ['tags'], raw: true })
    ])
    const catalog = new Map()
    for (const row of [...mangaRows, ...metadataRows]) appendTags(catalog, row.tags)
    tagCatalogCache = Object.fromEntries(
      [...catalog.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([namespace, values]) => [namespace, [...values].sort((a, b) => a.localeCompare(b))])
    )
    return tagCatalogCache
  }

  const invalidateTagCatalog = () => {
    tagCatalogCache = null
  }

  const searchEffectiveBooks = async request => {
    const books = await getEffectiveBooks()
    return books.filter(book => matchesBookSearch(book, request))
  }

  return { getEffectiveBookById, getEffectiveBooks, getTagCatalog, searchEffectiveBooks, invalidateTagCatalog }
}

module.exports = {
  MAX_NAVIGATION_ITEMS,
  normalizeBookId,
  normalizeBookDetailContext,
  createBookDetailWindowRegistry,
  getBookIdentity,
  hasConflictingHashIdentities,
  mergeEffectiveBook,
  matchesBookSearch,
  createBookDetailService
}

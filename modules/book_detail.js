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

const createBookDetailService = ({ Manga, getMetadata }) => {
  let tagCatalogCache = null

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

  return { getEffectiveBookById, getTagCatalog, invalidateTagCatalog }
}

module.exports = {
  MAX_NAVIGATION_ITEMS,
  normalizeBookId,
  normalizeBookDetailContext,
  getBookIdentity,
  hasConflictingHashIdentities,
  mergeEffectiveBook,
  createBookDetailService
}

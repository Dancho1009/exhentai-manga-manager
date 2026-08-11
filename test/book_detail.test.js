const test = require('node:test')
const assert = require('node:assert/strict')

const {
  MAX_NAVIGATION_ITEMS,
  createBookDetailService,
  normalizeBookDetailContext,
  hasConflictingHashIdentities,
  mergeEffectiveBook,
  matchesBookSearch
} = require('../modules/book_detail.js')

test('normalizes and deduplicates book detail navigation context', () => {
  const context = normalizeBookDetailContext({
    bookId: ' 42 ',
    navigationIds: ['1', '42', '1', '', null, '3']
  })
  assert.deepEqual(context, { bookId: '42', navigationIds: ['1', '42', '3'] })
})

test('rejects invalid book detail ids and caps navigation size', () => {
  assert.throws(() => normalizeBookDetailContext({ bookId: '' }), /INVALID_BOOK_ID/)
  const navigationIds = Array.from({ length: MAX_NAVIGATION_ITEMS + 50 }, (_, index) => String(index + 1))
  const context = normalizeBookDetailContext({ bookId: '1', navigationIds })
  assert.equal(context.navigationIds.length, MAX_NAVIGATION_ITEMS)
  const inserted = normalizeBookDetailContext({ bookId: 'missing', navigationIds })
  assert.equal(inserted.navigationIds.length, MAX_NAVIGATION_ITEMS)
  assert.equal(inserted.navigationIds[0], 'missing')
})

test('detects conflicting identities among books sharing a hash', () => {
  assert.equal(hasConflictingHashIdentities([
    { filepath: '3865827-a.zip', url: 'https://exhentai.org/g/3865827/token/' },
    { filepath: '3865827-b.zip', url: 'https://e-hentai.org/g/3865827/token/' }
  ]), false)
  assert.equal(hasConflictingHashIdentities([
    { filepath: '3865827-a.zip', url: 'https://exhentai.org/g/3865827/token/' },
    { filepath: '3892327-b.zip', url: 'https://exhentai.org/g/3892327/other/' }
  ]), true)
})

test('merges shared metadata only when the hash identity is unambiguous', () => {
  const manga = { id: '7', hash: 'abc', filepath: 'book.zip', coverPath: 'cover.webp', title: 'local' }
  const metadata = { hash: 'abc', title: 'shared', filepath: 'wrong.zip', coverPath: 'wrong.webp' }
  const merged = mergeEffectiveBook({
    manga,
    metadata,
    hashPeers: [
      { filepath: '3865827-a.zip', url: 'https://exhentai.org/g/3865827/token/' },
      { filepath: '3865827-b.zip', url: 'https://e-hentai.org/g/3865827/token/' }
    ]
  })
  assert.equal(merged.title, 'shared')
  assert.equal(merged.filepath, 'book.zip')
  assert.equal(merged.coverPath, 'cover.webp')

  const conflicted = mergeEffectiveBook({
    manga,
    metadata,
    hashPeers: [
      { filepath: '3865827-a.zip', url: 'https://exhentai.org/g/3865827/token/' },
      { filepath: '3892327-b.zip', url: 'https://exhentai.org/g/3892327/other/' }
    ]
  })
  assert.equal(conflicted.title, 'local')
})

test('book detail service resolves effective data and builds a compact tag catalog', async () => {
  const manga = {
    id: '7',
    hash: 'abc',
    filepath: '3865827-book.zip',
    coverPath: 'cover.webp',
    title: 'local',
    tags: { artist: ['local-artist'] }
  }
  const Manga = {
    findByPk: async id => id === manga.id ? { toJSON: () => ({ ...manga }) } : null,
    findAll: async options => options.attributes
      ? [{ tags: manga.tags }]
      : [{ ...manga, url: 'https://exhentai.org/g/3865827/token/' }]
  }
  const metadataModel = {
    findByPk: async hash => hash === manga.hash
      ? { toJSON: () => ({ hash, title: 'shared', tags: { language: ['chinese'] } }) }
      : null,
    findAll: async () => [{ tags: { artist: ['shared-artist'], language: ['chinese'] } }]
  }
  const service = createBookDetailService({ Manga, getMetadata: () => metadataModel })

  const book = await service.getEffectiveBookById(manga.id)
  assert.equal(book.title, 'shared')
  assert.equal(book.filepath, manga.filepath)

  const catalog = await service.getTagCatalog()
  assert.deepEqual(catalog.artist, ['local-artist', 'shared-artist'])
  assert.deepEqual(catalog.language, ['chinese'])
})

test('matches the local detail-window filters used by cards and tags', () => {
  const book = {
    category: 'Doujinshi',
    status: 'tagged',
    readCount: 3,
    pageCount: 20,
    filecount: 30,
    tags: { artist: ['alice'], female: ['glasses'] }
  }
  assert.equal(matchesBookSearch(book, { tag: 'alice', cat: 'artist' }), true)
  assert.equal(matchesBookSearch(book, { tag: 'glasses' }), true)
  assert.equal(matchesBookSearch(book, { tag: 'cat:Doujinshi' }), true)
  assert.equal(matchesBookSearch(book, { tag: 'tagged' }), true)
  assert.equal(matchesBookSearch(book, { readCount: 3 }), true)
  assert.equal(matchesBookSearch(book, { pageDiff: true }), true)
  assert.equal(matchesBookSearch(book, { tag: 'bob', cat: 'artist' }), false)
})

test('searches effective metadata without leaking conflicting shared hash data', async () => {
  const mangas = [
    { id: '1', hash: 'shared', filepath: '10001-a.zip', title: 'local-a', tags: {} },
    { id: '2', hash: 'shared', filepath: '20002-b.zip', title: 'local-b', tags: { artist: ['local-b'] } },
    { id: '3', hash: 'clean', filepath: '30003-c.zip', title: 'local-c', tags: {} }
  ]
  const metadata = [
    { hash: 'shared', title: 'wrong-shared', tags: { artist: ['shared-artist'] } },
    { hash: 'clean', title: 'merged-c', tags: { artist: ['target-artist'] } }
  ]
  const Manga = {
    findAll: async () => mangas,
    findByPk: async () => null
  }
  const Metadata = {
    findAll: async () => metadata,
    findByPk: async () => null
  }
  const service = createBookDetailService({ Manga, getMetadata: () => Metadata })

  const result = await service.searchEffectiveBooks({ tag: 'target-artist', cat: 'artist' })
  assert.deepEqual(result.map(book => book.id), ['3'])
  assert.equal(result[0].title, 'merged-c')

  const conflictedResult = await service.searchEffectiveBooks({ tag: 'shared-artist', cat: 'artist' })
  assert.deepEqual(conflictedResult, [])
})

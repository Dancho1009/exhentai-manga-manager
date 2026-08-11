const test = require('node:test')
const assert = require('node:assert/strict')

const {
  MAX_NAVIGATION_ITEMS,
  createBookDetailService,
  createBookDetailWindowRegistry,
  normalizeBookDetailContext,
  hasConflictingHashIdentities,
  mergeEffectiveBook,
  matchesBookSearch
} = require('../modules/book_detail.js')

const createFakeDetailWindow = id => {
  let destroyed = false
  const messages = []
  return {
    id,
    messages,
    webContents: {
      send: (channel, payload) => messages.push({ channel, payload })
    },
    isDestroyed: () => destroyed,
    destroy: () => { destroyed = true }
  }
}

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

test('book detail window registry keeps contexts isolated across windows', () => {
  const registry = createBookDetailWindowRegistry()
  const firstWindow = createFakeDetailWindow(1)
  const secondWindow = createFakeDetailWindow(2)
  const firstContext = normalizeBookDetailContext({ bookId: 'book-1', navigationIds: ['book-1', 'book-2'] })
  const secondContext = normalizeBookDetailContext({ bookId: 'book-2', navigationIds: ['book-2', 'book-3'] })
  registry.register(firstWindow, firstContext)
  registry.register(secondWindow, secondContext)

  assert.equal(registry.size, 2)
  assert.equal(registry.getBySender(firstWindow.webContents).context.bookId, 'book-1')
  assert.equal(registry.getBySender(secondWindow.webContents).context.bookId, 'book-2')
  assert.equal(registry.findByBookId('book-2').window, secondWindow)

  const navigated = normalizeBookDetailContext({ bookId: 'book-3', navigationIds: ['book-1', 'book-3'] })
  registry.updateContextBySender(firstWindow.webContents, navigated)
  assert.equal(registry.getBySender(firstWindow.webContents).context.bookId, 'book-3')
  assert.equal(registry.getBySender(secondWindow.webContents).context.bookId, 'book-2')
})

test('book detail window registry broadcasts to every window except the source', () => {
  const registry = createBookDetailWindowRegistry()
  const firstWindow = createFakeDetailWindow(1)
  const secondWindow = createFakeDetailWindow(2)
  registry.register(firstWindow, { bookId: 'book-1', navigationIds: ['book-1'] })
  registry.register(secondWindow, { bookId: 'book-2', navigationIds: ['book-2'] })

  registry.broadcast('book-detail:book-changed', { bookId: 'book-2' }, { excludeSender: firstWindow.webContents })
  assert.deepEqual(firstWindow.messages, [])
  assert.deepEqual(secondWindow.messages, [{ channel: 'book-detail:book-changed', payload: { bookId: 'book-2' } }])

  secondWindow.destroy()
  assert.equal(registry.size, 1)
  registry.destroyAll()
  assert.equal(firstWindow.isDestroyed(), true)
  assert.equal(registry.size, 0)
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

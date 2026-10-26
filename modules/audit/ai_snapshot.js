const { loadDatabaseSnapshot } = require('./library_snapshot.js')
const { mergeEffectiveBook } = require('../book_detail.js')
const { parseBookSemantics } = require('./dedupe_title.js')
const { summarizeBook } = require('./dedupe_analyzer.js')
const { stableId } = require('./utils.js')

// Semantic discovery only reads database metadata; it does not walk NAS archives.
const loadAiBooks = async ({ databasePath, metadataPath }) => {
  const snapshot = await loadDatabaseSnapshot(databasePath, metadataPath)
  if (snapshot.databaseIntegrity !== 'ok' || snapshot.metadataIntegrity !== 'ok') throw new Error('AI_DATABASE_INVALID')
  const metadata = new Map(snapshot.metadataRows.map(row => [row.hash, row]))
  const peers = new Map()
  for (const book of snapshot.books) {
    if (!peers.has(book.hash)) peers.set(book.hash, [])
    peers.get(book.hash).push(book)
  }
  return snapshot.books.map(raw => {
    const wrapped = { raw, effective: mergeEffectiveBook({ manga: raw, metadata: metadata.get(raw.hash), hashPeers: peers.get(raw.hash) }) }
    wrapped.semantic = parseBookSemantics(wrapped)
    return summarizeBook(wrapped)
  }).sort((a, b) => a.id.localeCompare(b.id))
}

// This is the cache identity for one book's AI semantic interpretation. Keep
// every field that can change the normalization request here; local content
// evidence is handled separately by the pair cache and dedupe worker.
const snapshotFields = (book, semantic) => [book.id, book.filepath, book.type, book.size, book.mtimeMs,
  book.metadataFingerprint, book.title, book.title_jpn, book.tags, semantic, book.hash, book.rawUrl, book.url,
  book.actualPageCount, book.declaredPageCount]
const bookSnapshotKey = book => {
  const semantic = { ...book.semantic }
  delete semantic.version
  return stableId('ai-book-input-v3', ...snapshotFields(book, semantic))
}
// Version 3 cache entries used the whole local parser output in their key.
// Reconstruct it only for unchanged, non-list titles during one-time migration.
const legacyBookSnapshotKey = book => {
  if (book.semantic?.chapterCoverage?.kind === 'list' || book.semantic?.volumeCoverage?.kind === 'list') return null
  const semantic = { ...book.semantic, version: 3 }
  delete semantic.chapterCoverage
  delete semantic.volumeCoverage
  semantic.titleParts = (semantic.titleParts || []).map(part => {
    const previous = { ...part }
    delete previous.chapterCoverage
    delete previous.volumeCoverage
    return previous
  })
  return stableId('ai-book-input-v2', ...snapshotFields(book, semantic))
}

module.exports = { loadAiBooks, bookSnapshotKey, legacyBookSnapshotKey }

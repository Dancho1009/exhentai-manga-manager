const path = require('path')
const { normalizePath, stableId } = require('./utils.js')

const summarizeBook = wrapped => ({
  id: wrapped.raw.id,
  filepath: wrapped.raw.filepath,
  type: wrapped.raw.type,
  size: wrapped.actual?.size ?? wrapped.raw.bundleSize,
  mtimeMs: wrapped.actual?.mtimeMs ?? null,
  title: wrapped.effective.title || wrapped.raw.title || path.basename(wrapped.raw.filepath),
  url: wrapped.effective.url || null,
  status: wrapped.effective.status || wrapped.raw.status,
  readCount: Number(wrapped.raw.readCount || 0),
  mark: Boolean(wrapped.raw.mark),
  hiddenBook: Boolean(wrapped.raw.hiddenBook),
  hash: wrapped.raw.hash,
  coverHash: wrapped.raw.coverHash,
  pageCount: wrapped.raw.pageCount
})

const scoreKeeper = wrapped => {
  let score = 0
  if (wrapped.effective.status === 'tagged') score += 100
  if (wrapped.effective.url) score += 50
  if (wrapped.raw.mark) score += 20
  if (!wrapped.raw.hiddenBook) score += 5
  score += Math.min(Number(wrapped.raw.readCount || 0), 20)
  return score
}

const createDuplicateGroup = (kind, wrappedItems, evidence, eligible, reviewReason, actionable = true) => {
  const sorted = [...wrappedItems].sort((left, right) => scoreKeeper(right) - scoreKeeper(left) || left.raw.filepath.localeCompare(right.raw.filepath))
  const items = sorted.map(summarizeBook)
  const suggestedKeepId = items[0]?.id || null
  const potentialBytes = items.filter(item => item.id !== suggestedKeepId).reduce((sum, item) => sum + Number(item.size || 0), 0)
  return {
    id: stableId('duplicate', kind, items.map(item => item.id).sort()),
    kind,
    severity: kind === 'exact-archive' || kind === 'metadata-shadow-conflict' || kind === 'duplicate-database-path'
      ? 'high'
      : eligible ? 'medium' : 'high',
    eligible,
    actionable,
    reviewReason: reviewReason || null,
    suggestedKeepId,
    potentialBytes,
    evidence,
    items
  }
}

const groupBy = (items, keySelector) => {
  const groups = new Map()
  for (const item of items) {
    const key = keySelector(item)
    if (key === null || key === undefined || key === '') continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  return groups
}

const analyzeBookRelations = wrappedBooks => {
  const groups = []
  for (const [pathKey, items] of groupBy(wrappedBooks, item => normalizePath(item.raw.filepath))) {
    if (items.length < 2) continue
    groups.push(createDuplicateGroup(
      'duplicate-database-path',
      items,
      { normalizedPath: pathKey, bookIds: items.map(item => item.raw.id) },
      false,
      '多个 Manga 记录指向同一路径，需要人工确认数据库记录',
      false
    ))
  }
  for (const [hash, items] of groupBy(wrappedBooks, item => item.raw.hash)) {
    if (items.length < 2) continue
    const rawUrls = [...new Set(items.map(item => item.raw.url).filter(Boolean))]
    const effectiveUrls = [...new Set(items.map(item => item.effective.url).filter(Boolean))]
    const conflict = rawUrls.length > 1 || effectiveUrls.length > 1 || items.some(item => item.raw.url && item.effective.url && item.raw.url !== item.effective.url)
    groups.push(createDuplicateGroup(
      conflict ? 'metadata-shadow-conflict' : 'shared-hash-review',
      items,
      { hash, rawUrls, effectiveUrls },
      false,
      conflict ? '共享 hash 的作品存在来源冲突，不能自动隔离' : '多个作品共享抽样 hash，需要人工确认是否重复',
      false
    ))
  }
  return groups
}

module.exports = {
  groupBy,
  summarizeBook,
  createDuplicateGroup,
  analyzeBookRelations
}

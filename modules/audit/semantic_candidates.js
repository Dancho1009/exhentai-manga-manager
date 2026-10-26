const { parseTags } = require('./utils.js')
const { normalizeTitle, parseTitleParts } = require('./dedupe_title.js')
const { ordinalCoverage, bookCoverageRelation } = require('./part_coverage.js')

const distinct = values => [...new Set(values.filter(Boolean))]
const list = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
const ordinalKey = value => value && Number.isFinite(value.start) ? `${value.start}:${value.end ?? ''}` : null
const oneOrdinal = (parts, field) => {
  const values = new Map(parts.filter(part => ordinalKey(part[field])).map(part => [ordinalKey(part[field]), part[field]]))
  return values.size === 1 ? [...values.values()][0] : null
}
const titleVariants = value => distinct([value, ...String(value || '').split(/[|｜]/)].map(normalizeTitle))
const publicationKey = value => {
  if (!value?.name || !(value.issue || value.date)) return null
  const original = parseTitleParts(`${value.name} ${value.issue ? 'Vol.' + value.issue : value.date}`).publications[0]
  const period = String(value.issue || value.date).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
  const number = value.issue && period.match(/^(\d+)(?:\s*[-~～–—]\s*(\d+))?$/)
  return `${original?.nameKey || normalizeTitle(value.name)}:${value.issue ? 'issue' : 'date'}:${number ? number.slice(1).filter(value => value !== undefined).map(Number).join('-') : period}`
}
const describe = book => {
  const semantic = book.semantic || {}, inferred = book.aiSemantic || {}, tags = parseTags(book.tags)
  const parts = [book.title, book.title_jpn].filter(Boolean).map(value => parseTitleParts(value))
  for (const part of semantic.titleParts || []) if (part?.body && !parts.some(existing => existing.key === part.key)) parts.push(part)
  // A validated AI field may explicitly be unknown. Do not restore a local
  // interpretation that the semantic result has replaced with null.
  const publications = Object.hasOwn(inferred, 'publication') ? inferred.publication ? [inferred.publication] : []
    : [...(semantic.publications || []), ...parts.flatMap(part => part.publications || [])]
  const wholeIssues = publications.filter(item => item.kind === 'whole-issue')
  const authors = distinct([...list(semantic.artists), ...list(tags.artist), ...list(tags.group), ...parts.map(part => part.creator), ...list(inferred.authors)].map(normalizeTitle))
  const rawTitles = distinct(parts.flatMap(part => titleVariants(part.body + (part.qualifiers || []).map(value => `(${value})`).join(''))))
  const aiTitles = distinct([
    ...titleVariants(inferred.workTitle),
    // Aliases may retain the original chapter suffix. Keep the exact alias
    // and a supplemental local retrieval variant; neither supplies ordinals.
    ...list(inferred.titleAliases).flatMap(value => [...titleVariants(value), ...titleVariants(parseTitleParts(value).body)])
  ])
  const effectiveCoverage = field => {
    if (wholeIssues.length) return null
    const local = semantic[`${field}Coverage`] || parts.map(part => part[`${field}Coverage`]).find(Boolean)
    if (local?.kind === 'list') return local
    return Object.hasOwn(inferred, field) ? ordinalCoverage(inferred[field]) : local || null
  }
  return { id: String(book.id), authors, rawTitles, aiTitles,
    seriesTitles: distinct([inferred.seriesTitle].filter(Boolean).flatMap(titleVariants)),
    chapter: wholeIssues.length ? null : Object.hasOwn(inferred, 'chapter') ? inferred.chapter : semantic.chapter || oneOrdinal(parts, 'chapter') || null,
    volume: wholeIssues.length ? null : Object.hasOwn(inferred, 'volume') ? inferred.volume : semantic.volume || oneOrdinal(parts, 'volume') || null,
    chapterCoverage: effectiveCoverage('chapter'), volumeCoverage: effectiveCoverage('volume'),
    wholeIssue: wholeIssues.length > 0, issueKeys: distinct(wholeIssues.map(publicationKey)) }
}

// aiSemantic is the matching single-book entry returned by
// validateRelationResult(). It supplies retrieval names and semantic fields;
// it never changes local metadata or deterministic duplicate evidence.
function * iterateSemanticCandidateChunks(books, { task = 'dedupe', chunkSize = 256 } = {}) {
  if (!Array.isArray(books) || !['dedupe', 'series'].includes(task) || !Number.isInteger(chunkSize) || chunkSize < 1) throw new Error('INVALID_SEMANTIC_CANDIDATE_REQUEST')
  const descriptions = books.map(describe).sort((left, right) => left.id.localeCompare(right.id))
  if (descriptions.some(item => !item.id || item.id === 'undefined') || new Set(descriptions.map(item => item.id)).size !== descriptions.length) throw new Error('INVALID_SEMANTIC_BOOK_IDS')
  const index = new Map()
  const add = (key, reason, book) => {
    if (!key) return
    const identity = `${reason}:${key}`
    if (!index.has(identity)) index.set(identity, { id: index.size, reason, members: [] })
    const bucket = index.get(identity)
    bucket.members.push(book)
    book.buckets ||= new Map()
    book.buckets.set(bucket.id, bucket.reason)
  }
  for (const book of descriptions) {
    if (book.wholeIssue) {
      if (task === 'dedupe') for (const key of book.issueKeys) add(key, 'same-publication-issue', book)
      continue
    }
    // Raw and normalized names share an index so a translated title can match
    // a peer's original title without a common author spelling.
    for (const key of distinct([...book.rawTitles, ...book.aiTitles])) add(key, 'work-title-alias', book)
    if (task === 'series') {
      for (const key of distinct([...book.rawTitles, ...book.seriesTitles])) add(key, 'series-title', book)
    }
  }
  let chunk = [], comparisons = 0
  for (const bucket of index.values()) {
    for (let leftIndex = 0; leftIndex < bucket.members.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < bucket.members.length; rightIndex++) {
        // Yield even when every combination is rejected, so the caller can
        // service cancellation and UI events without truncating the search.
        if (++comparisons % 2048 === 0) { yield chunk; chunk = [] }
        const left = bucket.members[leftIndex], right = bucket.members[rightIndex]
        if (left.id === right.id) continue
        const scope = bookCoverageRelation(left, right)
        if (task === 'dedupe' && scope === 'disjoint') continue
        const shared = [...left.buckets].filter(([id]) => right.buckets.has(id))
        // Emit once, from the first shared bucket. All reasons are known now;
        // no quadratic global pair map is needed for deduplication.
        if (shared[0][0] !== bucket.id) continue
        const authorOverlap = left.authors.some(author => right.authors.includes(author))
        const reasons = [bucket.reason, ...(authorOverlap ? ['author-or-author-alias'] : []),
          ...(['left_contains_right', 'right_contains_left'].includes(scope) ? ['work-part-containment'] : []),
          ...(scope === 'overlap' ? ['work-part-overlap'] : []),
          ...(['chapter', 'volume'].some(field => Boolean(left[field]) !== Boolean(right[field])) ? ['work-ordinal-unmarked'] : []),
          ...shared.slice(1).map(([, reason]) => reason)]
        const [leftId, rightId] = [left.id, right.id].sort()
        chunk.push({ leftId, rightId, reasons: distinct(reasons) })
        if (chunk.length >= chunkSize) { yield chunk; chunk = [] }
      }
    }
  }
  if (chunk.length) yield chunk
}

const collectSemanticCandidates = (books, options) => ({
  pairs: [...iterateSemanticCandidateChunks(books, options)].flat(), truncated: false
})

module.exports = { collectSemanticCandidates, iterateSemanticCandidateChunks }

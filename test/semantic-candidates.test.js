const test = require('node:test')
const assert = require('node:assert/strict')
const { collectSemanticCandidates, iterateSemanticCandidateChunks } = require('../modules/audit/semantic_candidates.js')
const book = (id, title, extra = {}) => ({ id, title, tags: { artist: ['Creator'] }, ...extra })
const ids = result => result.pairs.map(pair => [pair.leftId, pair.rightId])

test('semantic discovery recalls missing ordinals without restoring series links to deterministic dedupe', () => {
  const books = [book('a', 'Title'), book('b', 'Title Ch.1'), book('c', 'Title 第2話')]
  const dedupe = collectSemanticCandidates(books)
  assert.deepEqual(ids(dedupe), [['a', 'b'], ['a', 'c']])
  assert.ok(dedupe.pairs.every(pair => pair.reasons.includes('work-ordinal-unmarked')))
  assert.deepEqual(ids(collectSemanticCandidates(books, { task: 'series' })), [['a', 'b'], ['a', 'c'], ['b', 'c']])
  assert.equal(books[0].semantic, undefined)
})

test('AI discovery requests overlapping and contained chapters but skips disjoint chapters', () => {
  const books = [book('a', 'Title Ch.1-3'), book('b', 'Title Ch.2'), book('c', 'Title Ch.4'),
    book('d', 'Title 1+2+3話')]
  const found = collectSemanticCandidates(books)
  assert.ok(ids(found).some(pair => pair.join(':') === 'a:b'))
  assert.ok(ids(found).some(pair => pair.join(':') === 'a:d'))
  assert.ok(!ids(found).some(pair => pair.join(':') === 'a:c'))
})

test('bilingual aliases and normalized creator/work names recall across scripts', () => {
  const books = [book('a', '[Alice] Moon Flower 第1話 | 月花 第1話', { tags: { artist: ['Alice'] } }),
    book('b', '[アリス] 月花 Ch.1', { tags: { artist: ['アリス'] } })]
  assert.deepEqual(ids(collectSemanticCandidates(books)), [['a', 'b']])
  const unrelatedSpelling = [book('a', 'Moonlit Blossom', { tags: { artist: ['Alice'] },
    aiSemantic: { workTitle: '月花', titleAliases: ['Moonlit Blossom'], authors: ['アリス'] } }),
  book('b', '月花', { tags: { artist: ['アリス'] }, aiSemantic: { workTitle: '月花', titleAliases: ['Moon Flower'], authors: ['アリス'] } })]
  const result = collectSemanticCandidates(unrelatedSpelling)
  assert.deepEqual(ids(result), [['a', 'b']])
  assert.ok(result.pairs[0].reasons.includes('author-or-author-alias'))
  assert.deepEqual(collectSemanticCandidates([book('a', 'Moonlit Blossom'), book('b', '月花')]).pairs, [])
})

test('AI canonical series names discover different titles in an independent series pipeline', () => {
  const books = [book('a', 'Moonlit Beginning', { aiSemantic: { seriesTitle: 'Moon Flower' } }),
    book('b', '夜明け', { aiSemantic: { seriesTitle: 'Moon Flower' } })]
  assert.deepEqual(collectSemanticCandidates(books).pairs, [])
  assert.deepEqual(ids(collectSemanticCandidates(books, { task: 'series' })), [['a', 'b']])
})

test('published-in issues do not become work ordinals or connect unrelated story chapters', () => {
  const books = [book('a', '[ぐすたふ] 君は輝く月花のように (コミックメガストア Vol.13)'),
    book('b', '[ぐすたふ] 君は輝く月花のように 第3話 (コミックメガストア Vol.16)'),
    book('c', '[ぐすたふ] 君は輝く月花のように 第4話 (コミックメガストア Vol.19)')]
  assert.deepEqual(ids(collectSemanticCandidates(books)), [['a', 'b'], ['a', 'c']])
  assert.equal(collectSemanticCandidates(books, { task: 'series' }).pairs.length, 3)
})

test('same-issue magazine editions remain candidates while different issues never become work-series candidates', () => {
  const books = [book('a', 'Dascomi Vol.35 [Chinese] [Colorized]'), book('b', 'ダスコミ Vol.35 [DL版]'), book('c', 'Dascomi Vol.38')]
  const dedupe = collectSemanticCandidates(books)
  assert.deepEqual(ids(dedupe), [['a', 'b']])
  assert.ok(dedupe.pairs[0].reasons.includes('same-publication-issue'))
  assert.deepEqual(collectSemanticCandidates(books, { task: 'series' }).pairs, [])
  const unknownMagazine = [book('d', 'Obscure Press Vol.1', { aiSemantic: { publication: { kind: 'whole-issue', name: 'Obscure Press', issue: '1', date: null } } }),
    book('e', 'Obscure Press Vol.2', { aiSemantic: { publication: { kind: 'whole-issue', name: 'Obscure Press', issue: '2', date: null } } })]
  assert.deepEqual(collectSemanticCandidates(unknownMagazine, { task: 'series' }).pairs, [])
})

test('candidate iteration covers more than ten thousand pairs without request or comparison cutoffs', () => {
  const books = Array.from({ length: 145 }, (_, index) => book(String(index).padStart(3, '0'), 'Same Title',
    { aiSemantic: { workTitle: 'Same Title', seriesTitle: 'Same Title', titleAliases: ['Another Alias'] } }))
  const full = collectSemanticCandidates(books, { maxPairs: 3, task: 'series' })
  assert.equal(full.pairs.length, 10440)
  assert.equal(full.truncated, false)
  assert.equal(new Set(full.pairs.map(pair => JSON.stringify([pair.leftId, pair.rightId]))).size, 10440)
  assert.ok(full.pairs.every(pair => pair.reasons.includes('series-title') && pair.reasons.includes('work-title-alias')))
  assert.deepEqual(full, collectSemanticCandidates([...books].reverse(), { task: 'series', maxPairs: 0 }))
  const chunks = [...iterateSemanticCandidateChunks(books, { chunkSize: 113, task: 'series' })]
  assert.ok(chunks.every(chunk => chunk.length <= 113))
  assert.deepEqual(chunks.flat(), full.pairs)
  const distinctChapters = Array.from({ length: 145 }, (_, index) => book(String(index), `Title Ch.${index}`))
  const rejectedChunks = [...iterateSemanticCandidateChunks(distinctChapters)]
  assert.ok(rejectedChunks.length > 0, 'Rejected combinations yield control without truncating the scan')
  const rejected = collectSemanticCandidates(distinctChapters, { maxPairs: 1 })
  assert.equal(rejected.pairs.length, 0)
  assert.equal(rejected.truncated, false)
  assert.deepEqual(collectSemanticCandidates([book('a', 'Single')]), { pairs: [], truncated: false })
})

test('no candidate relation marks content eligible or mutates original evidence', () => {
  const books = [book('a', 'Title', { semantic: { chapter: null }, contentProof: 'proof-a' }), book('b', 'Title', { contentProof: 'proof-b' })]
  const before = JSON.stringify(books)
  const result = collectSemanticCandidates(books)
  assert.equal(result.pairs.length, 1)
  assert.deepEqual(Object.keys(result.pairs[0]).sort(), ['leftId', 'reasons', 'rightId'])
  assert.equal(JSON.stringify(books), before)
})

test('validated AI ordinals override obsolete local values and explicit null remains unknown', () => {
  const books = [book('a', 'Moon Vol.13', { semantic: { chapter: { start: 1, end: null }, volume: { start: 13, end: null } },
    aiSemantic: { workTitle: '月花', chapter: { start: 3, end: null }, volume: null, publication: null } }),
  book('b', '月花 第3話', { semantic: { volume: { start: 16, end: null } },
    aiSemantic: { workTitle: '月花', chapter: { start: 3, end: null }, volume: null, publication: null } }),
  book('c', 'Another translation', { aiSemantic: { workTitle: '月花', chapter: null, volume: null, publication: null } }),
  book('d', 'A different part', { aiSemantic: { workTitle: '月花', chapter: { start: 4, end: null }, volume: null, publication: null } })]
  const before = JSON.stringify(books)
  const pairs = ids(collectSemanticCandidates(books))
  assert.deepEqual(pairs, [['a', 'b'], ['a', 'c'], ['b', 'c'], ['c', 'd']])
  assert.equal(JSON.stringify(books), before)
})

test('AI publication semantics replace local magazine guesses instead of merging incompatible meanings', () => {
  const publication = (kind, issue) => ({ kind, name: 'Obscure Press', issue, date: null })
  const books = [book('a', 'Dascomi Vol.35', { aiSemantic: { workTitle: 'A story', chapter: { start: 3, end: null }, volume: null, publication: publication('embedded', '35') } }),
    book('b', 'A story 第3話', { aiSemantic: { workTitle: 'A story', chapter: { start: 3, end: null }, volume: null, publication: null } })]
  assert.deepEqual(ids(collectSemanticCandidates(books)), [['a', 'b']])
  const withoutPublication = books.map(value => ({ ...value, aiSemantic: { ...value.aiSemantic, publication: null } }))
  assert.deepEqual(ids(collectSemanticCandidates(withoutPublication)), [['a', 'b']])
  const wholeIssues = [book('a', 'Obscure Press Vol.1', { aiSemantic: { publication: publication('whole-issue', '035') } }),
    book('b', 'Obscure Press Vol.2', { aiSemantic: { publication: publication('whole-issue', '35') } }),
    book('c', 'Obscure Press Vol.3', { aiSemantic: { publication: publication('whole-issue', '38') } })]
  assert.deepEqual(ids(collectSemanticCandidates(wholeIssues)), [['a', 'b']], 'work volumes cannot reject editions of the same whole issue')
  assert.deepEqual(collectSemanticCandidates(wholeIssues, { task: 'series' }).pairs, [])
})

test('AI whole-issue publications with unknown periods never create a work candidate from their name', () => {
  const books = ['a', 'b'].map(id => book(id, 'Obscure Press', { aiSemantic: { workTitle: 'Obscure Press',
    seriesTitle: 'Obscure Press', publication: { kind: 'whole-issue', name: 'Obscure Press', issue: null, date: null } } }))
  assert.deepEqual(collectSemanticCandidates(books).pairs, [])
  assert.deepEqual(collectSemanticCandidates(books, { task: 'series' }).pairs, [])
})

test('normalized work names are consumed as structured names without another local ordinal parse', () => {
  const books = [book('a', 'An obscure original name', { aiSemantic: { workTitle: 'Ch.1', chapter: null, volume: null } }),
    book('b', 'An unrelated translated spelling', { aiSemantic: { workTitle: 'Ch.1', chapter: null, volume: null } })]
  assert.deepEqual(ids(collectSemanticCandidates(books)), [['a', 'b']])
})

test('AI magazine date periods and issue labels do not share a duplicate bucket merely because their text matches', () => {
  const books = [book('a', 'Obscure issue range', { aiSemantic: { publication: { kind: 'whole-issue', name: 'Obscure Press', issue: '2026-10', date: null } } }),
    book('b', 'Obscure calendar issue', { aiSemantic: { publication: { kind: 'whole-issue', name: 'Obscure Press', issue: null, date: '2026-10' } } })]
  assert.deepEqual(collectSemanticCandidates(books).pairs, [])
})

test('AI original-title aliases retain chapter-stripped retrieval without replacing structured ordinals', () => {
  const books = [book('a', 'An original romanized name', { aiSemantic: { workTitle: 'A separate canonical title',
    titleAliases: ['Moon Flower Ch.3'], chapter: null, volume: null, publication: null } }),
  book('b', 'Moon Flower Ch.3')]
  assert.deepEqual(ids(collectSemanticCandidates(books)), [['a', 'b']])
  assert.ok(collectSemanticCandidates(books).pairs[0].reasons.includes('work-ordinal-unmarked'))
})

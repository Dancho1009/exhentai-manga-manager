const test = require('node:test')
const assert = require('node:assert/strict')
const { buildSeriesReport, collectPublicationRelations } = require('../modules/audit/series_analyzer.js')

const publication = (issue, extra = {}) => ({ kind: 'whole-issue', name: 'Obscure Press', issue, date: null, ...extra })
const book = (id, aiSemantic, extra = {}) => ({ id, title: 'A name outside the local parser', aiSemantic, ...extra })
const relation = (leftId, rightId, kind = 'same_series_different_part') => ({ leftId, rightId, relation: kind, reason: 'AI semantic relationship', evidenceRefs: [] })

test('AI identifies publication periods unknown to the local parser without making a story series', () => {
  const books = [book('a', { publication: publication('13'), chapter: null, volume: null }),
    book('b', { publication: publication('16'), chapter: null, volume: null }),
    book('c', { publication: publication('19'), chapter: null, volume: null })]
  const before = JSON.stringify(books)
  const relations = collectPublicationRelations(books)
  assert.deepEqual(relations.map(value => [value.leftId, value.rightId, value.relation]), [
    ['a', 'b', 'same_publication_different_issue'], ['b', 'c', 'same_publication_different_issue']])
  assert.match(relations[0].reason, /AI 刊物语义/)
  const report = buildSeriesReport({ books, relations: [...relations, relation('a', 'b')] })
  assert.deepEqual(report.groups, [])
  assert.equal(report.publicationRelations.length, 2)
  assert.equal(report.uncertainRelations.length, 1)
  assert.equal(JSON.stringify(books), before)
})

test('AI publication periods take precedence over conflicting local metadata and retain warnings', () => {
  const books = [book('a', { publication: publication('13'), uncertainties: ['Local issue 35 conflicts with the supplied publication.'] },
    { semantic: { publications: [publication('35')] } }),
  book('b', { publication: publication('16') })]
  const relations = collectPublicationRelations(books)
  assert.equal(relations.length, 1)
  assert.match(relations[0].reason, /13 与 16/)
  assert.match(relations[0].reason, /待确认：a: Local issue 35/)
})

test('AI publication null or embedded publication does not resurrect a local whole-issue classification', () => {
  for (const inferredPublication of [null, publication('13', { kind: 'embedded' })]) {
    const books = [book('a', { publication: inferredPublication, seriesTitle: 'Moon Flower', chapter: { start: 1, end: null }, volume: null },
      { semantic: { publications: [publication('35')] } }),
    book('b', { publication: null, seriesTitle: 'Moon Flower', chapter: { start: 2, end: null }, volume: null })]
    assert.deepEqual(collectPublicationRelations(books), [])
    assert.equal(buildSeriesReport({ books, relations: [relation('a', 'b')] }).groups.length, 1)
  }
})

test('series ordering uses validated AI ordinals, including unknown, and carries local conflict warnings', () => {
  const books = [book('a', { publication: null, seriesTitle: 'Moon Flower', chapter: null, volume: null,
    uncertainties: ['Local chapter 1 does not establish an AI part number.'] }, { semantic: { chapter: { start: 1, end: null }, volume: { start: 99, end: null } } }),
  book('b', { publication: null, seriesTitle: 'Moon Flower', chapter: { start: 2, end: null }, volume: null },
    { semantic: { chapter: { start: 20, end: null }, volume: { start: 1, end: null } } }),
  book('c', { publication: null, seriesTitle: 'Moon Flower', chapter: { start: 1, end: null }, volume: null },
    { semantic: { chapter: { start: 30, end: null }, volume: { start: 2, end: null } } })]
  const report = buildSeriesReport({ books, relations: [relation('a', 'b'), relation('b', 'c')] })
  assert.deepEqual(report.groups[0].members.map(value => value.id), ['c', 'b', 'a'])
  assert.ok(report.groups[0].uncertainties.some(value => value.includes('Local chapter 1')))
  assert.ok(report.groups[0].uncertainties.some(value => value.includes('a: 作品卷话未标注，未推断为第1话')))
})

test('AI textual issue names remain publication relationships without inventing numeric chronology', () => {
  const books = [book('a', { publication: publication('春号') }), book('b', { publication: publication('夏号') }),
    book('c', { publication: publication('春号') })]
  const relations = collectPublicationRelations(books)
  assert.equal(relations.length, 1)
  assert.equal(relations[0].relation, 'same_publication_different_issue')
  assert.match(relations[0].reason, /春号|夏号/)
  assert.deepEqual(collectPublicationRelations([...books].reverse()), relations)
})

test('publication issue numbers normalize without a local title recognition gate and stay distinct from date periods', () => {
  const books = [book('a', { publication: publication('０１') }), book('b', { publication: publication('2') }),
    book('c', { publication: publication('1') }), book('d', { publication: publication(null, { date: '2026-10' }) })]
  const relations = collectPublicationRelations(books)
  assert.deepEqual(relations.map(value => [value.leftId, value.rightId]), [['a', 'b']])
})

test('incomplete AI semantic entries retain the existing local fallback', () => {
  const books = [book('a', { workTitle: 'A name' }, { semantic: { publications: [publication('13')] } }),
    book('b', undefined, { semantic: { publications: [publication('16')] } })]
  assert.equal(collectPublicationRelations(books).length, 1)
})

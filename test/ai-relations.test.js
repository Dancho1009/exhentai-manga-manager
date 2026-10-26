const test = require('node:test')
const assert = require('node:assert/strict')
const { AI_PROMPT_VERSION, AI_RELATION_SCHEMA, AI_CLASSIFICATION_SCHEMA, AI_SYSTEM_PROMPT, AI_NORMALIZE_SYSTEM_PROMPT, AI_CLASSIFY_SYSTEM_PROMPT, buildRelationRequest, validateRelationResult } = require('../modules/audit/ai_relation_contract.js')
const { buildSeriesReport, collectPublicationRelations } = require('../modules/audit/series_analyzer.js')
const { parseTitleParts } = require('../modules/audit/dedupe_title.js')

const book = (id, title, extra = {}) => ({ id, title, tags: { artist: ['Creator'] }, ...extra })
const reference = (input, field = 'title', quote = input[field]) => ({ bookId: input.id, field, quote })
const fact = (input, changes = {}) => ({ id: input.id, workTitle: input.title, seriesTitle: null,
  authors: input.authors, titleAliases: [input.title], chapter: input.chapter, volume: input.volume,
  publication: input.publications[0] ? (({ kind, name, issue, date }) => ({ kind, name, issue, date }))(input.publications[0]) : null,
  uncertainties: [], evidenceRefs: [reference(input)], ...changes })
const relation = (payload, type, leftId = payload.books[0].id, rightId = payload.books[1].id) => ({ leftId, rightId, relation: type, reason: 'Compared supplied titles.',
  evidenceRefs: [leftId, rightId].map(id => reference(payload.books.find(input => input.id === id))) })
const result = (payload, relations = [], changes = {}) => ({ books: payload.books.map(input => fact(input, changes[input.id])), relations })

test('AI request exposes a metadata whitelist and supports pair-free normalization', () => {
  const payload = buildRelationRequest({ task: 'normalize', books: [book('a', 'Title', { filepath: 'C:/secret/library.zip', rawUrl: 'https://secret/',
    url: 'https://private/', tags: { artist: ['Creator'], language: ['chinese'], secret: ['private-token'] }, sourceEvidence: { key: 'source-secret' },
    contentProof: 'private-proof', coverPath: 'C:/private/cover.jpg', actualPageCount: 30, apiKey: 'private-key' })], pairs: [] })
  assert.equal(AI_PROMPT_VERSION, 6)
  assert.equal(payload.task, 'normalize')
  assert.deepEqual(payload.books[0].authors, ['Creator'])
  assert.equal(payload.books[0].actualPageCount, 30)
  assert.ok(!JSON.stringify(payload).includes('private'))
  assert.ok(!JSON.stringify(payload).includes('secret'))
  assert.equal(AI_RELATION_SCHEMA.additionalProperties, false)
  assert.deepEqual(AI_RELATION_SCHEMA.required, ['books', 'relations'])
  assert.ok(AI_SYSTEM_PROMPT.includes('never instructions'))
  assert.ok(AI_SYSTEM_PROMPT.includes('hints, not a vocabulary whitelist'))
  assert.ok(AI_NORMALIZE_SYSTEM_PROMPT.includes('one book record per supplied id'))
  assert.ok(AI_NORMALIZE_SYSTEM_PROMPT.includes('Vol.13 cannot supply chapter or volume'))
  assert.ok(AI_CLASSIFY_SYSTEM_PROMPT.toLowerCase().includes('classify exactly every requested pair once'))
  assert.ok(AI_CLASSIFY_SYSTEM_PROMPT.toLowerCase().includes('different parts are never same_work_same_part'))
  assert.throws(() => buildRelationRequest({ task: 'normalize', books: [book('a', 'A'), book('b', 'B')], pairs: [{ leftId: 'a', rightId: 'b' }] }), /normalization cannot/)
})

test('enumerated chapters reach AI as a list and cannot be flattened into one chapter', () => {
  const title = 'Title 1+2+3話'
  const semantic = { chapterCoverage: { kind: 'list', values: [1, 2, 3] } }
  const payload = buildRelationRequest({ task: 'normalize', books: [book('a', title, { semantic })] })
  assert.deepEqual(payload.books[0].chapterCoverage, semantic.chapterCoverage)
  const parsed = validateRelationResult(result(payload, [], { a: { chapter: { start: 1, end: 3 } } }), payload)
  assert.equal(parsed.books[0].chapter, null)
  assert.ok(parsed.books[0].uncertainties.some(value => value.includes('list')))
})

test('AI equivalent-edition answer is corrected to explicit part containment', () => {
  const payload = buildRelationRequest({ task: 'dedupe', books: [book('a', 'Title Ch.1-3'), book('b', 'Title Ch.2')],
    pairs: [{ leftId: 'a', rightId: 'b' }] })
  const parsed = validateRelationResult({ relations: [{ leftId: 'a', rightId: 'b', relation: 'same_work_different_edition', reason: 'Same title.' }] }, payload,
    { mode: 'classification' })
  assert.equal(parsed.relations[0].relation, 'same_work_left_contains_right')
  assert.ok(parsed.relations[0].warnings?.length)
})

test('pair classification accepts a relation-only result without copied books or citations', () => {
  const payload = buildRelationRequest({ task: 'dedupe', books: [book('a', 'Title'), book('b', 'Title')], pairs: [{ leftId: 'a', rightId: 'b' }] })
  assert.equal(AI_CLASSIFICATION_SCHEMA.additionalProperties, false)
  assert.deepEqual(AI_CLASSIFICATION_SCHEMA.required, ['relations'])
  const parsed = validateRelationResult({ relations: [{ leftId: 'a', rightId: 'b', relation: 'same_work_same_part', reason: 'The requested pair describes one work part.' }] }, payload, { mode: 'classification' })
  assert.deepEqual(parsed, { relations: [{ leftId: 'a', rightId: 'b', relation: 'same_work_same_part', reason: 'The requested pair describes one work part.' }] })
  assert.throws(() => validateRelationResult({ relations: [{ leftId: 'a', rightId: 'b', relation: 'same_work_same_part', reason: 'ok', evidenceRefs: [] }] }, payload, { mode: 'classification' }), /relation fields/)
  assert.throws(() => validateRelationResult({ relations: [{ leftId: 'a', rightId: 'c', relation: 'same_work_same_part', reason: 'ok' }] }, payload, { mode: 'classification' }), /unrequested/)
})

test('pair classification keeps local semantic conflicts as review warnings without requiring citations', () => {
  const payload = buildRelationRequest({ task: 'dedupe', books: [book('a', 'Title Ch.1'), book('b', 'Title Ch.2')], pairs: [{ leftId: 'a', rightId: 'b' }] })
  const parsed = validateRelationResult({ relations: [{ leftId: 'a', rightId: 'b', relation: 'same_work_same_part', reason: 'The model found the same work.' }] }, payload, { mode: 'classification' })
  assert.deepEqual(parsed.relations[0].warnings, ['AI same-work relation conflicts with locally parsed work ordinals.'])
  assert.deepEqual(validateRelationResult(parsed, payload, { mode: 'classification' }), parsed, 'Generated warnings remain valid on cache replay')
})

test('pair evidence sends only local equality and source status, never raw hashes, paths or source identities', () => {
  const payload = buildRelationRequest({ task: 'dedupe', books: [
    book('a', 'Title', { archiveSha256: 'private-archive', contentProof: 'private-proof-a', filepath: 'C:/private/library.zip',
      sourceEvidence: { status: 'known', key: 'ehentai:12345:private-source-token' } }),
    book('b', 'Title', { archiveSha256: 'private-archive', contentProof: 'private-proof-b',
      sourceEvidence: { status: 'known', key: 'ehentai:12345:private-source-token' } }),
    book('c', 'Title', { sourceEvidence: { status: 'conflict', key: 'ehentai:12345:private-source-token', sources: ['private-source-url'] } })
  ], pairs: [{ leftId: 'a', rightId: 'b', localEvidence: { archiveEqual: false, fakeSecret: 'private-input' } }, { leftId: 'a', rightId: 'c' }] })
  assert.deepEqual(payload.pairs[0].localEvidence, { archiveEqual: true, contentProofEqual: false, sourceIdentityEqual: true,
    leftSourceStatus: 'known', rightSourceStatus: 'known' })
  assert.deepEqual(payload.pairs[1].localEvidence, { archiveEqual: null, contentProofEqual: null, sourceIdentityEqual: null,
    leftSourceStatus: 'known', rightSourceStatus: 'conflict' })
  assert.ok(!JSON.stringify(payload).includes('private'))
  assert.ok(!JSON.stringify(payload).includes('12345'))
  assert.ok(AI_SYSTEM_PROMPT.includes('Never override an equal archive or content proof'))
})

test('pair requests carry whitelisted prior AI hints without turning them into original evidence', () => {
  const aiSemantic = { workTitle: '整理后的作品名', seriesTitle: '系列名', authors: ['AI Author'], titleAliases: ['Alias'],
    chapter: { start: 3, end: null, private: 'private-ordinal' }, volume: null,
    publication: { kind: 'embedded', name: '新刊名', issue: '春号', date: null, account_token: 'private-publication' },
    uncertainties: ['Earlier AI warning.'], filepath: 'C:/private/archive.zip', access_token: 'private-token',
    evidenceRefs: [{ quote: 'private-ref' }], unknown: 'private-field' }
  const books = [book('a', '作品 第三話 (新刊名 春号)', { aiSemantic }), book('b', '同作品')]
  const before = JSON.stringify(books)
  const payload = buildRelationRequest({ task: 'dedupe', books, pairs: [{ leftId: 'a', rightId: 'b' }] })
  assert.deepEqual(payload.books[0].aiHints, { workTitle: '整理后的作品名', seriesTitle: '系列名', authors: ['AI Author'], titleAliases: ['Alias'],
    chapter: { start: 3, end: null }, volume: null, publication: { kind: 'embedded', name: '新刊名', issue: '春号', date: null }, uncertainties: ['Earlier AI warning.'] })
  assert.equal(payload.books[0].chapter, null, 'Original locally parsed fields are kept distinct from AI hints')
  assert.ok(!Object.hasOwn(payload.books[1], 'aiHints'))
  assert.ok(!JSON.stringify(payload).includes('private'))
  assert.equal(JSON.stringify(books), before)
  assert.ok(!Object.hasOwn(buildRelationRequest({ task: 'normalize', books }).books[0], 'aiHints'))
  assert.throws(() => validateRelationResult(result(payload, [], { a: { evidenceRefs: [{ bookId: 'a', field: 'aiHints', quote: '整理后的作品名' }] } }), payload), /reference target/)
  assert.throws(() => validateRelationResult(result(payload, [], { a: { evidenceRefs: [reference(payload.books[0], 'title', '整理后的作品名')] } }), payload), /not supplied evidence/)
})

test('validated and cached results remain schema-valid when pair requests contain local evidence', () => {
  const payload = buildRelationRequest({ task: 'dedupe', books: [book('a', 'Title'), book('b', 'Title')], pairs: [{ leftId: 'a', rightId: 'b' }] })
  const parsed = validateRelationResult(result(payload, [relation(payload, 'same_work_same_part')]), payload)
  assert.ok(!Object.hasOwn(parsed.relations[0], 'localEvidence'))
  assert.deepEqual(validateRelationResult(parsed, payload), parsed)
  const incomplete = validateRelationResult({ books: [], relations: [] }, payload)
  assert.deepEqual(validateRelationResult(incomplete, payload), incomplete)
})

test('magazine source is distinct from an unmarked chapter and explicit story chapter', () => {
  const payload = buildRelationRequest({ task: 'series', books: [
    book('a', '[ぐすたふ] 君は輝く月花のように (コミックメガストア Vol.13) [中国翻訳]'),
    book('b', '[ぐすたふ] 君は輝く月花のように 第3話 (コミックメガストア Vol.16) [中国翻訳]')
  ], pairs: [{ leftId: 'a', rightId: 'b' }] })
  const before = JSON.stringify(payload)
  assert.equal(payload.books[0].chapter, null)
  assert.equal(payload.books[0].volume, null)
  assert.equal(payload.books[0].publications[0].issue, '13')
  assert.deepEqual(payload.books[1].chapter, { start: 3, end: null })
  const parsed = validateRelationResult(result(payload, [relation(payload, 'same_series_different_part')]), payload)
  assert.equal(parsed.books[0].chapter, null)
  assert.equal(parsed.books[1].publication.issue, '16')
  assert.equal(JSON.stringify(payload), before)
  assert.equal(validateRelationResult(result(payload, [], { a: { chapter: { start: 1, end: null } } }), payload).books[0].chapter.start, 1,
    'The receiver checks the source citation and shape rather than repeating the AI interpretation')
})

test('local whole-magazine conflicts remain reviewable uncertainties rather than failed responses', () => {
  const payload = buildRelationRequest({ task: 'series', books: [book('a', 'Dascomi Vol.35 [Colorized]'), book('b', 'ダスコミ Vol.38 [DL版]')],
    pairs: [{ leftId: 'a', rightId: 'b' }] })
  assert.equal(payload.books[0].volume, null)
  const parsed = validateRelationResult(result(payload, [relation(payload, 'same_publication_different_issue')]), payload)
  assert.equal(parsed.relations[0].relation, 'same_publication_different_issue')
  const series = validateRelationResult(result(payload, [relation(payload, 'same_series_different_part')]), payload)
  assert.ok(series.books.every(book => book.uncertainties.some(value => value.includes('whole magazine'))))
  const sameWork = validateRelationResult(result(payload, [relation(payload, 'same_work_same_part')]), payload)
  assert.ok(sameWork.books.every(book => book.uncertainties.some(value => value.includes('magazine issues'))))
  const story = validateRelationResult(result(payload, [], { a: { seriesTitle: 'Dascomi' } }), payload)
  assert.ok(story.books[0].uncertainties.some(value => value.includes('whole magazine')))
  const differentIssue = validateRelationResult(result(payload, [], { a: { publication: { kind: 'whole-issue', name: 'Dascomi', issue: '99', date: null } } }), payload)
  assert.ok(differentIssue.books[0].uncertainties.some(value => value.includes('local publication')))
  assert.deepEqual(validateRelationResult(differentIssue, payload), differentIssue)
})

test('COMIC ExE bare issue citations validate against their original source without inventing work ordinals', () => {
  const title = '[Napo] Koi no Rank Match - Make Love Rank match!! | 恋之排位决斗战 (COMIC ExE 60) [Chinese] [软蒲汉化组] [Digital]'
  const payload = buildRelationRequest({ task: 'dedupe', books: [book('a', title), book('b', title)], pairs: [{ leftId: 'a', rightId: 'b' }] })
  assert.equal(payload.books[0].publications[0].issue, '60')
  assert.equal(payload.books[0].volume, null)
  for (const quote of [title, '(COMIC ExE 60)', 'COMIC ExE 60']) {
    const parsed = validateRelationResult(result(payload, [relation(payload, 'same_work_same_part')], {
      a: { evidenceRefs: [reference(payload.books[0], 'title', quote)] }
    }), payload)
    assert.equal(parsed.books[0].publication.name, 'COMIC ExE')
    assert.equal(parsed.books[0].publication.issue, '60')
    assert.deepEqual(validateRelationResult(parsed, payload), parsed)
  }
  const serialized = JSON.stringify(payload.books[0].publications)
  assert.equal(validateRelationResult(result(payload, [], { a: { evidenceRefs: [reference(payload.books[0], 'publications', serialized)] } }), payload).books[0].publication.issue, '60')
  for (const publication of [
    { kind: 'embedded', name: 'COMIC ExE', issue: '6', date: null },
    { kind: 'embedded', name: 'COMIC ExE', issue: '61', date: null },
    { kind: 'whole-issue', name: 'COMIC ExE', issue: '60', date: null }
  ]) {
    const reviewable = validateRelationResult(result(payload, [], { a: { publication } }), payload)
    assert.ok(reviewable.books[0].uncertainties.some(value => value.includes('local publication')))
  }
  assert.equal(validateRelationResult(result(payload, [], { a: { evidenceRefs: [reference(payload.books[0], 'title', 'COMIC ExE')] } }), payload).books[0].publication.issue, '60',
    'A real quote is not subjected to a second semantic regex')
})

test('new publication names, nonnumeric issues and Chinese/Japanese work numbers need no local parser recognition', () => {
  const payload = buildRelationRequest({ task: 'normalize', books: [
    book('a', '作品 第三話 (完全新しい誌名 春季増刊号)'),
    book('b', '另一部作品 卷之貳 上篇 (未收录刊物 甲辰年春号)'),
    book('c', 'Uncatalogued Review Special Ω'),
    book('d', 'Chronicle Part IV')
  ] })
  assert.ok(payload.books.every(book => !book.chapter && !book.volume && book.publications.length === 0))
  const interpreted = result(payload, [], {
    a: { chapter: { start: 3, end: null }, publication: { kind: 'embedded', name: '完全新しい誌名', issue: '春季増刊号', date: null } },
    b: { volume: { start: 2, end: null }, publication: { kind: 'embedded', name: '未收录刊物', issue: '甲辰年春号', date: null } },
    c: { publication: { kind: 'whole-issue', name: 'Uncatalogued Review', issue: 'Special Ω', date: null } },
    d: { chapter: { start: 4, end: null } }
  })
  const parsed = validateRelationResult(interpreted, payload)
  assert.equal(parsed.books[0].chapter.start, 3)
  assert.equal(parsed.books[1].volume.start, 2)
  assert.equal(parsed.books[2].publication.issue, 'Special Ω')
  assert.equal(parsed.books[3].chapter.start, 4)
  assert.ok(parsed.books.every(book => book.uncertainties.length === 0), 'Unknown local formats are not treated as semantic conflicts')
  assert.deepEqual(validateRelationResult(parsed, payload), parsed)
  assert.throws(() => validateRelationResult(result(payload, [], { a: { ...interpreted.books[0], evidenceRefs: [] } }), payload), /book claims lack evidence/)
  assert.throws(() => validateRelationResult(result(payload, [], { a: { ...interpreted.books[0], evidenceRefs: [reference(payload.books[0], 'title', 'Invented issue')] } }), payload), /not supplied evidence/)
})

test('ordinal fields retain structural and exact structured-source validation', () => {
  const payload = buildRelationRequest({ task: 'normalize', books: [book('a', 'Title Ch.01'), book('b', 'Title (Unknown Magazine Vol.13)')], pairs: [] })
  const parsed = validateRelationResult(result(payload, [], { a: { evidenceRefs: [reference(payload.books[0], 'chapter', '{"start":1,"end":null}')] } }), payload)
  assert.deepEqual(parsed.books[0].chapter, { start: 1, end: null })
  assert.equal(validateRelationResult(result(payload, [], { b: { volume: { start: 13, end: null } } }), payload).books[1].volume.start, 13)
  assert.throws(() => validateRelationResult(result(payload, [], { a: { chapter: { start: 1, end: 0 } } }), payload), /chapter range/)
})

test('structured ordinal references accept layout and single-part equivalents without changing their evidence', () => {
  for (const field of ['chapter', 'volume']) {
    const payload = buildRelationRequest({ task: 'normalize', books: [book('a', field === 'chapter' ? 'Title Ch.03' : 'Title Vol.03')] })
    const before = JSON.stringify(payload)
    for (const quote of ['{ "start": 3, "end": null }', '{\n"end": 3,\n"start": 3\n}']) {
      const parsed = validateRelationResult(result(payload, [], { a: { [field]: { start: 3, end: 3 },
        evidenceRefs: [reference(payload.books[0], field, quote)] } }), payload)
      assert.deepEqual(parsed.books[0][field], { start: 3, end: null })
      assert.equal(parsed.books[0].evidenceRefs[0].quote, '{"start":3,"end":null}')
      assert.deepEqual(validateRelationResult(parsed, payload), parsed)
    }
    for (const quote of ['{"start":4,"end":null}', '{"start":"3","end":null}', '{"start":3}',
      '{"start":3,"end":null,"extra":true}', '3', 'null', 'chapter 3']) {
      assert.throws(() => validateRelationResult(result(payload, [], { a: { evidenceRefs: [reference(payload.books[0], field, quote)] } }), payload),
        error => error.code === 'AI_RESULT_INVALID' && error.validation.reason === 'EVIDENCE_MISMATCH')
    }
    assert.equal(JSON.stringify(payload), before)
  }
  const unknown = buildRelationRequest({ task: 'normalize', books: [book('a', 'Title')] })
  assert.throws(() => validateRelationResult(result(unknown, [], { a: { chapter: { start: 1, end: null },
    evidenceRefs: [reference(unknown.books[0], 'chapter', '{"start":1,"end":null}')] } }), unknown), /not supplied evidence/)
})

test('structured publication citations compare JSON values rather than key order or serialization layout', () => {
  const payload = buildRelationRequest({ task: 'normalize', books: [book('a', '作品 (COMIC ExE 60)')] })
  const source = payload.books[0].publications[0]
  const reordered = { rawText: source.rawText, date: source.date, issue: source.issue, name: source.name, kind: source.kind }
  for (const quote of [JSON.stringify(reordered, null, 2), JSON.stringify([reordered], null, 2)]) {
    const parsed = validateRelationResult(result(payload, [], { a: { evidenceRefs: [reference(payload.books[0], 'publications', quote)] } }), payload)
    assert.equal(parsed.books[0].publication.issue, '60')
    assert.deepEqual(validateRelationResult(parsed, payload), parsed)
  }
  for (const quote of [JSON.stringify({ ...reordered, issue: '61' }), JSON.stringify({ ...reordered, token: 'fake' }),
    JSON.stringify({ name: source.name }), 'COMIC Unknown', 'not-json']) {
    assert.throws(() => validateRelationResult(result(payload, [], { a: { evidenceRefs: [reference(payload.books[0], 'publications', quote)] } }), payload), /not supplied evidence/)
  }
})

test('publication text quoted from supplied magazine metadata is valid evidence', () => {
  const original = '[ぺい] 清らかな関係 (COMIC 快楽天ビースト 2023年4月号) [中国翻訳] [DL版]'
  const quote = 'COMIC 快楽天ビースト 2023年4月号'
  const payload = buildRelationRequest({ task: 'normalize', books: [book('a', 'Kiyorakana Kankei', { title_jpn: original })], pairs: [] })
  const value = result(payload, [], { a: { evidenceRefs: [reference(payload.books[0], 'publications', quote)] } })
  const parsed = validateRelationResult(value, payload)
  const refs = parsed.books[0].evidenceRefs
  assert.equal(refs[0].field, 'publications')
  assert.equal(JSON.parse(refs[0].quote)[0].rawText, quote)
  assert.doesNotThrow(() => validateRelationResult(parsed, payload), 'Canonical evidence remains cache replay compatible')
  value.books[0].evidenceRefs[0].quote = 'COMIC 快楽天ビースト 2024年4月号'
  assert.throws(() => validateRelationResult(value, payload), /not supplied evidence/)
})

test('publication excerpts present only in original titles retain their actual evidence field', () => {
  const quote = '未知季刊 春の別冊'
  const payload = buildRelationRequest({ task: 'normalize', books: [book('a', `作品 (${quote})`, { semantic: { publications: [] } })], pairs: [] })
  payload.books[0].publications = []
  const parsed = validateRelationResult(result(payload, [], { a: { evidenceRefs: [reference(payload.books[0], 'publications', quote)] } }), payload)
  assert.deepEqual(parsed.books[0].evidenceRefs, [{ bookId: 'a', field: 'title', quote }])
  payload.books[0].publications = [{ kind: 'embedded', name: 'Another Magazine', issue: '99', date: null, rawText: 'Another Magazine Vol.99' }]
  const corrected = validateRelationResult(result(payload, [], { a: {
    publication: { kind: 'embedded', name: '未知季刊', issue: null, date: null },
    evidenceRefs: [reference(payload.books[0], 'publications', quote)]
  } }), payload)
  assert.deepEqual(corrected.books[0].evidenceRefs, [{ bookId: 'a', field: 'title', quote }])
  assert.deepEqual(validateRelationResult(corrected, payload), corrected)
})

test('publication evidence accepts an exact subset of supplied publication aliases only', () => {
  const payload = buildRelationRequest({ task: 'normalize', books: [book('a', '作品', { semantic: { publications: [
    { kind: 'embedded', name: 'COMIC Alpha', issue: null, date: '2024-01', rawText: 'COMIC Alpha 2024-01' },
    { kind: 'embedded', name: 'COMIC Beta', issue: null, date: '2024-01', rawText: 'COMIC Beta 2024-01' }
  ] } })], pairs: [] })
  const publications = payload.books[0].publications
  assert.equal(publications.length, 2)
  const subset = JSON.stringify([publications[1]], null, 2)
  const parsed = validateRelationResult(result(payload, [], { a: { evidenceRefs: [reference(payload.books[0], 'publications', subset)] } }), payload)
  assert.deepEqual(JSON.parse(parsed.books[0].evidenceRefs[0].quote), [publications[1]])
  for (const quote of [JSON.stringify([{ ...publications[1], name: 'Invented' }]), JSON.stringify([{ ...publications[1], issue: '99' }]), '[]']) {
    assert.throws(() => validateRelationResult(result(payload, [], { a: { evidenceRefs: [reference(payload.books[0], 'publications', quote)] } }), payload), /not supplied evidence/)
  }
})

test('single-part normalization is shared by requests, ranges and pair checks while source conflicts remain visible', () => {
  const payload = buildRelationRequest({ task: 'dedupe', books: [
    book('a', 'Title Ch.3', { title_jpn: 'Title Ch.3-3' }), book('b', 'Title Ch.3-3', { semantic: { chapter: { start: 3, end: 3 } } })
  ], pairs: [{ leftId: 'a', rightId: 'b' }] })
  assert.deepEqual(payload.books.map(value => value.chapter), [{ start: 3, end: null }, { start: 3, end: null }])
  assert.equal(payload.books[0].ordinalConflict, false)
  const parsed = validateRelationResult(result(payload, [relation(payload, 'same_work_same_part')]), payload)
  assert.deepEqual(validateRelationResult(parsed, payload), parsed)
  const range = buildRelationRequest({ task: 'normalize', books: [book('a', 'Title Ch.3.5-5')] })
  assert.deepEqual(validateRelationResult(result(range), range).books[0].chapter, { start: 3.5, end: 5 })
  const disputed = validateRelationResult(result(range, [], { a: { chapter: { start: 3.5, end: null } } }), range)
  assert.ok(disputed.books[0].uncertainties.some(value => value.includes('AI chapter differs')))
  for (const changes of [{ title_jpn: 'Title Ch.4' }, { semantic: { ordinalConflict: true } }]) {
    const conflicting = buildRelationRequest({ task: 'normalize', books: [book('a', 'Title Ch.3', changes)] })
    assert.equal(conflicting.books[0].ordinalConflict, true)
    const normalized = validateRelationResult(result(conflicting, [], { a: { chapter: null, uncertainties: ['Other uncertainty.'] } }), conflicting)
    assert.ok(normalized.books[0].uncertainties.includes('Local title sources contain conflicting work ordinals.'))
    assert.deepEqual(validateRelationResult(normalized, conflicting), normalized)
  }
  const kanji = buildRelationRequest({ task: 'normalize', books: [book('a', 'Title 第三話')] })
  assert.equal(validateRelationResult(result(kanji), kanji).books[0].chapter, null)
  assert.equal(validateRelationResult(result(kanji, [], { a: { chapter: { start: 3, end: null } } }), kanji).books[0].chapter.start, 3)
})

test('only optional blank text becomes null, with normalized results valid on cache replay', () => {
  const payload = buildRelationRequest({ task: 'dedupe', books: [book('a', 'Title'), book('b', 'Title')], pairs: [{ leftId: 'a', rightId: 'b' }] })
  const normalized = validateRelationResult(result(payload, [], { a: { workTitle: ' ', seriesTitle: '\n\t',
    publication: { kind: 'embedded', name: 'Title', issue: ' ', date: '' } } }), payload)
  assert.equal(normalized.books[0].workTitle, null)
  assert.equal(normalized.books[0].seriesTitle, null)
  assert.equal(normalized.books[0].publication.issue, null)
  assert.equal(normalized.books[0].publication.date, null)
  assert.deepEqual(validateRelationResult(normalized, payload), normalized)
  for (const change of [{ id: '' }, { authors: [''] }, { publication: { kind: 'embedded', name: ' ', issue: null, date: null } },
    { evidenceRefs: [reference(payload.books[0], 'title', ' ')] }]) {
    assert.throws(() => validateRelationResult(result(payload, [], { a: change }), payload), /AI_RESULT_INVALID/)
  }
  assert.throws(() => validateRelationResult(result(payload, [{ ...relation(payload, 'unknown'), reason: '' }]), payload), /reason text/)
})

test('publication dates retain standard output validation without requiring local source format recognition', () => {
  const payload = buildRelationRequest({ task: 'normalize', books: [book('a', 'COMIC Test 2023年9月号')] })
  for (const date of ['2023年9月', '2023-09', '2023/9', '2023.09', '２０２３年９月']) {
    const normalized = validateRelationResult(result(payload, [], { a: { publication: { kind: 'whole-issue', name: 'COMIC Test', issue: null, date } } }), payload)
    assert.equal(normalized.books[0].publication.date, '2023-09')
    assert.deepEqual(validateRelationResult(normalized, payload), normalized)
  }
  for (const date of ['2023-00', '2023-13', '9月', '09/2023', '2023-09-01', '2023年9月1日', '2023-9 trailing']) {
    assert.throws(() => validateRelationResult(result(payload, [], { a: { publication: { kind: 'whole-issue', name: 'COMIC Test', issue: null, date } } }), payload),
      error => error.validation.reason === 'INVALID_DATE' && error.validation.path === 'books[0].publication.date')
  }
  assert.equal(validateRelationResult(result(payload, [], { a: { evidenceRefs: [reference(payload.books[0], 'title', 'COMIC Test')] } }), payload).books[0].publication.date, '2023-09')
  const unrelated = buildRelationRequest({ task: 'normalize', books: [book('a', 'COMIC Alpha 2023年9月 / COMIC Beta 2024年10月')] })
  assert.equal(validateRelationResult(result(unrelated, [], { a: { publication: { kind: 'whole-issue', name: 'COMIC Alpha', issue: null, date: '2024-10' } } }), unrelated).books[0].publication.date, '2024-10')
  const magazine = buildRelationRequest({ task: 'normalize', books: [book('a', 'Dascomi Vol.35')] })
  assert.equal(validateRelationResult(result(magazine, [], { a: { evidenceRefs: [reference(magazine.books[0], 'title', 'Dascomi')] } }), magazine).books[0].publication.issue, '35')
})

test('validation diagnostics identify safe member and field paths', () => {
  const payload = buildRelationRequest({ task: 'normalize', books: [book('a', 'Title')] })
  assert.throws(() => validateRelationResult(result(payload, [], { a: { chapter: { start: 3, end: 2 } } }), payload), error => {
    assert.equal(error.code, 'AI_RESULT_INVALID')
    assert.deepEqual(error.validation, { reason: 'INVALID_VALUE', path: 'books[0].chapter', bookId: 'a' })
    return true
  })
})

test('known local conflicts remain bounded and stable when the AI already supplied a full warning list', () => {
  const payload = buildRelationRequest({ task: 'normalize', books: [book('a', 'Title Ch.2', { title_jpn: 'Title Ch.4' })] })
  // The conflicting source set has no single aggregate; use an explicit local
  // hint to exercise an AI/local value disagreement as well as source conflict.
  payload.books[0].chapter = { start: 2, end: null }
  const parsed = validateRelationResult(result(payload, [], { a: { chapter: { start: 3, end: null },
    uncertainties: Array.from({ length: 64 }, (_, index) => 'AI uncertainty ' + index) } }), payload)
  assert.equal(parsed.books[0].chapter.start, 3)
  assert.equal(parsed.books[0].uncertainties.length, 64)
  assert.ok(parsed.books[0].uncertainties.some(value => value.includes('AI chapter differs')))
  assert.ok(parsed.books[0].uncertainties.includes('Local title sources contain conflicting work ordinals.'))
  assert.deepEqual(validateRelationResult(parsed, payload), parsed)
})

test('accepting AI semantics preserves field types, enum values, ordinal ranges and required original citations', () => {
  const payload = buildRelationRequest({ task: 'normalize', books: [book('a', '新刊物 特別号 第三話')] })
  for (const change of [
    { chapter: { start: -1, end: null } }, { chapter: { start: '3', end: null } }, { chapter: { start: 3, end: 2 } },
    { volume: { start: 3, end: null, extra: true } },
    { publication: { kind: 'magazine', name: '新刊物', issue: '特別号', date: null } },
    { publication: { kind: 'embedded', name: '新刊物', issue: 3, date: null } },
    { publication: { kind: 'embedded', name: '新刊物', issue: '特別号', date: '2023-13' } },
    { chapter: { start: 3, end: null }, evidenceRefs: [] }
  ]) assert.throws(() => validateRelationResult(result(payload, [], { a: change }), payload), error => error.code === 'AI_RESULT_INVALID')
})

test('missing books and requested relations remain explicitly unknown', () => {
  const payload = buildRelationRequest({ task: 'dedupe', books: [book('a', 'Title'), book('b', 'Title')], pairs: [{ leftId: 'a', rightId: 'b' }] })
  const parsed = validateRelationResult({ books: [], relations: [] }, payload)
  assert.equal(parsed.books.length, 2)
  assert.equal(parsed.books[0].chapter, null)
  assert.ok(parsed.books[0].uncertainties.length)
  assert.equal(parsed.relations[0].relation, 'unknown')
})

test('reject invented IDs, unsupported quotes, unknown properties, unrequested and reversed duplicate pairs', () => {
  const payload = buildRelationRequest({ task: 'dedupe', books: [book('a', 'Title'), book('b', 'Title'), book('c', 'Other')],
    pairs: [{ leftId: 'a', rightId: 'b' }, { leftId: 'a', rightId: 'c' }] })
  assert.throws(() => validateRelationResult(result(payload, [], { a: { id: 'invented' } }), payload), /unknown or duplicate book/)
  assert.throws(() => validateRelationResult(result(payload, [], { a: { evidenceRefs: [{ bookId: 'b', field: 'title', quote: 'Title' }] } }), payload), /reference target/)
  assert.throws(() => validateRelationResult(result(payload, [], { a: { evidenceRefs: [{ bookId: 'a', field: 'title', quote: 'Invented' }] } }), payload), /not supplied evidence/)
  assert.throws(() => validateRelationResult({ ...result(payload), groupIsDuplicate: true }, payload), /result fields/)
  assert.throws(() => validateRelationResult(result(payload, [relation(payload, 'same_work_same_part', 'b', 'c')]), payload), /unrequested/)
  assert.throws(() => validateRelationResult(result(payload, [relation(payload, 'same_work_same_part'), relation(payload, 'unrelated', 'b', 'a')]), payload), /repeated relation/)
  assert.throws(() => validateRelationResult(result(payload, [{ ...relation(payload, 'same_work_same_part'), evidenceRefs: [reference(payload.books[0])] }]), payload), /both members/)
  assert.throws(() => validateRelationResult(result(payload, [{ ...relation(payload, 'same_work_same_part'), relation: 'all_duplicate' }]), payload), /relation enum/)
})

test('reject pair or transitive series contradictions without overriding local content evidence', () => {
  const payload = buildRelationRequest({ task: 'series', books: [book('a', 'Title Ch.1', { contentProof: 'same-local-proof' }),
    book('b', 'Title Ch.2', { contentProof: 'same-local-proof' }), book('c', 'Title Ch.3')],
  pairs: [{ leftId: 'a', rightId: 'b' }, { leftId: 'b', rightId: 'c' }, { leftId: 'a', rightId: 'c' }] })
  assert.equal(validateRelationResult(result(payload, [relation(payload, 'same_work_same_part')]), payload).relations[0].relation, 'same_work_same_part')
  const withoutContent = buildRelationRequest({ task: 'dedupe', books: [book('a', 'Title Ch.1'), book('b', 'Title Ch.2')], pairs: [{ leftId: 'a', rightId: 'b' }] })
  const disagreement = validateRelationResult(result(withoutContent, [relation(withoutContent, 'same_work_same_part')]), withoutContent)
  assert.ok(disagreement.books.every(book => book.uncertainties.some(value => value.includes('locally parsed work ordinals'))))
  assert.throws(() => validateRelationResult(result(payload, [relation(payload, 'same_series_different_part'),
    relation(payload, 'same_series_different_part', 'b', 'c'), relation(payload, 'unrelated', 'a', 'c')]), payload), /contradictory series relations/)
  const unnumbered = buildRelationRequest({ task: 'dedupe', books: [book('a', 'Title'), book('b', 'Title'), book('c', 'Title')], pairs: payload.pairs })
  assert.throws(() => validateRelationResult(result(unnumbered, [relation(unnumbered, 'same_work_same_part'),
    relation(unnumbered, 'same_work_different_edition', 'b', 'c'), relation(unnumbered, 'same_series_different_part', 'a', 'c')]), unnumbered), /contradictory same-work/)
})

test('AI publication interpretations remain reviewable when local names differ', () => {
  const payload = buildRelationRequest({ task: 'normalize', books: [book('a', 'Obscure Press Vol.17')] })
  const parsed = validateRelationResult(result(payload, [], { a: { volume: null, publication: { kind: 'whole-issue', name: 'Obscure Press', issue: '17', date: null } } }), payload)
  assert.equal(parsed.books[0].publication.issue, '17')
  const different = buildRelationRequest({ task: 'series', books: [book('a', 'COMIC Alpha Vol.1'), book('b', 'COMIC Beta Vol.2')], pairs: [{ leftId: 'a', rightId: 'b' }] })
  const reviewable = validateRelationResult(result(different, [relation(different, 'same_publication_different_issue')]), different)
  assert.equal(reviewable.relations[0].relation, 'same_publication_different_issue')
  assert.ok(reviewable.books.every(book => book.uncertainties.some(value => value.includes('local'))))
})

test('A/B duplicate suggestions never imply that C belongs to an equal-content subgroup', () => {
  const books = [book('a', 'Title'), book('b', 'Title'), book('c', 'Other')]
  const payload = buildRelationRequest({ task: 'dedupe', books, pairs: [{ leftId: 'a', rightId: 'b' }, { leftId: 'b', rightId: 'c' }] })
  const parsed = validateRelationResult(result(payload, [relation(payload, 'same_work_same_part'), relation(payload, 'unrelated', 'b', 'c')]), payload)
  assert.equal(parsed.relations.length, 2)
  assert.ok(!Object.hasOwn(parsed, 'eligible'))
  assert.ok(!Object.hasOwn(parsed, 'equivalenceClasses'))
  assert.deepEqual(buildSeriesReport({ books, relations: parsed.relations }).groups, [])
})

test('series report orders explicit chapters, preserves unknown ordinals and separates magazine relations', () => {
  const books = [book('unknown', 'Title', { aiSemantic: { seriesTitle: 'Title', uncertainties: ['No chapter stated.'] } }),
    book('three', 'Title Ch.3'), book('two', 'Title Ch.2'), book('m35', 'Dascomi Vol.35'), book('m38', 'Dascomi Vol.38')]
  const relations = [{ leftId: 'unknown', rightId: 'three', relation: 'same_series_different_part' },
    { leftId: 'three', rightId: 'two', relation: 'same_series_different_part' },
    { leftId: 'm35', rightId: 'm38', relation: 'same_publication_different_issue' }]
  const before = JSON.stringify(books)
  const report = buildSeriesReport({ books, relations })
  assert.equal(report.groups.length, 1)
  assert.deepEqual(report.groups[0].members.map(member => member.id), ['two', 'three', 'unknown'])
  assert.ok(report.groups[0].uncertainties.some(reason => reason.includes('未推断为第1话')))
  assert.ok(report.groups[0].uncertainties.some(reason => reason.includes('未逐对确认')))
  assert.equal(report.publicationRelations.length, 1)
  assert.equal(JSON.stringify(books), before)
  assert.equal(buildSeriesReport({ books, relations: [{ leftId: 'm35', rightId: 'm38', relation: 'same_series_different_part' }] }).groups.length, 0)
})

test('series report does not merge an explicitly contradictory connected component', () => {
  const report = buildSeriesReport({ books: [book('a', 'A'), book('b', 'B'), book('c', 'C')], relations: [
    { leftId: 'a', rightId: 'b', relation: 'same_series_different_part' },
    { leftId: 'b', rightId: 'c', relation: 'same_series_different_part' }, { leftId: 'a', rightId: 'c', relation: 'unrelated' }
  ] })
  assert.deepEqual(report.groups, [])
  assert.equal(report.uncertainRelations.length, 2)
})

test('series completeness counts unique confirmed same-work pairs and excludes unknown or repeated edges', () => {
  const books = [book('a', 'Title Ch.1'), book('b', 'Title Ch.1'), book('c', 'Title Ch.2')]
  const seriesEdges = [{ leftId: 'a', rightId: 'c', relation: 'same_series_different_part' },
    { leftId: 'b', rightId: 'c', relation: 'same_series_different_part' }]
  for (const relation of ['same_work_same_part', 'same_work_different_edition']) {
    const report = buildSeriesReport({ books, relations: [...seriesEdges, { leftId: 'a', rightId: 'b', relation }] })
    assert.equal(report.groups.length, 1)
    assert.ok(!report.groups[0].uncertainties.some(reason => reason.includes('未逐对确认')))
  }
  const incomplete = buildSeriesReport({ books, relations: [...seriesEdges,
    { leftId: 'a', rightId: 'b', relation: 'unknown' }, { leftId: 'c', rightId: 'a', relation: 'same_series_different_part' }] })
  assert.ok(incomplete.groups[0].uncertainties.some(reason => reason.includes('未逐对确认')))
})

test('local periodical relations connect adjacent distinct issues without sending cross-issue AI requests', () => {
  const magazine = (id, title) => book(id, title, { semantic: { publications: parseTitleParts(title).publications } })
  const books = [magazine('m38', 'Dascomi Vol.38'), magazine('m35b', 'Dascomi Vol.35 [Colorized]'),
    magazine('m35a', 'ダスコミ Vol.35'), magazine('m42', 'Dascomi Vol.42'), magazine('different', 'COMIC Other Vol.35'),
    magazine('story', '[Creator] Story Ch.3 (COMIC Megastore Vol.16)')]
  const before = JSON.stringify(books)
  const relations = collectPublicationRelations(books)
  assert.deepEqual(relations.map(value => [value.leftId, value.rightId]), [['m35a', 'm38'], ['m38', 'm42']])
  assert.ok(relations.every(value => value.relation === 'same_publication_different_issue' && value.evidenceRefs.length === 0))
  assert.deepEqual(collectPublicationRelations([...books].reverse()), relations)
  assert.equal(JSON.stringify(books), before)
  const report = buildSeriesReport({ books, relations })
  assert.equal(report.groups.length, 0)
  assert.equal(report.publicationRelations.length, 2)
})

test('publication relations consume prior AI semantics while excluding conflicting local issues and mixed date/number periods', () => {
  const publication = (name, issue, date = null) => ({ kind: 'whole-issue', name, issue, date })
  const books = [
    book('a', 'First', { semantic: { publications: [publication('COMIC Test', '1'), publication('COMIC Test', '2')] } }),
    book('b', 'Second', { semantic: { publications: [publication('COMIC Test', '3')] } }),
    book('c', 'Third', { aiSemantic: { publication: publication('COMIC Test', '4') } }),
    book('d', 'Monthly', { semantic: { publications: [publication('COMIC Test', null, '2023-08')] } })
  ]
  assert.deepEqual(collectPublicationRelations(books).map(value => [value.leftId, value.rightId]), [['b', 'c']])
  books.push(book('e', 'Next month', { semantic: { publications: [publication('COMIC Test', null, '2023-09')] } }))
  assert.deepEqual(collectPublicationRelations(books).map(value => [value.leftId, value.rightId]).sort(), [['b', 'c'], ['d', 'e']])
})

test('publication relation counts grow with periods rather than all issue and edition pairs', () => {
  const books = Array.from({ length: 100 }, (_, index) => [0, 1, 2].map(edition => book(`${index}-${edition}`, 'Magazine', {
    semantic: { publications: [{ kind: 'whole-issue', name: 'Dascomi', nameKey: 'dascomi', issue: String(index + 1), date: null }] }
  }))).flat()
  assert.equal(collectPublicationRelations(books).length, 99)
})

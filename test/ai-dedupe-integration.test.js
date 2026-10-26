const test = require('node:test')
const assert = require('node:assert/strict')
const { createFixture, scan, archive } = require('./fixtures/dedupe-fixture.cjs')

const semanticPair = { leftId: 'a', rightId: 'b' }
const semanticBooks = [
  { id: 'a', title: 'A summer journey', hash: null, tags: {}, url: '', entries: { '01.jpg': 'original page' } },
  { id: 'b', title: 'ある夏の旅', hash: null, tags: {}, url: '', entries: { 'front.png': 'translated first page', 'last.png': 'extra ending page in the translated edition' } }
]
const fixtureFor = async (t, descriptors) => {
  const fixture = await createFixture(descriptors)
  t.after(fixture.cleanup)
  return fixture
}
const memberIds = group => group.items.map(item => item.id).sort()
const findPair = (report, ids) => report.groups.find(group => JSON.stringify(memberIds(group)) === JSON.stringify([...ids].sort()))

test('AI semantic discovery creates a locally verified manual group without inventing content equivalence', async t => {
  const fixture = await fixtureFor(t, semanticBooks)
  const original = await scan(fixture, { scanMode: 'full' }, 'ai-baseline')
  assert.deepEqual(original.groups, [], 'this pair must be absent from every existing deterministic candidate path')

  const imported = await scan(fixture, { scanMode: 'daily', bookIds: ['a', 'b'], candidatePairs: [semanticPair], baseReport: original, groupIds: [] }, 'ai-import')
  assert.equal(imported.options.scope, 'candidates')
  assert.equal(imported.groups.length, 1)
  const group = imported.groups[0]
  assert.deepEqual(memberIds(group), ['a', 'b'])
  assert.equal(group.kind, 'candidate-review')
  assert.ok(group.reasons.some(reason => reason.code === 'ai-semantic'))
  assert.equal(group.verification.status, 'verified')
  assert.ok(group.items.every(item => item.contentProof && item.evidenceRef), 'the imported pair must be inspected locally')
  assert.deepEqual(group.equivalenceClasses, [])
  assert.equal(group.eligible, false)
  assert.equal(group.potentialBytes, 0)
  assert.equal(imported.summary.eligibleDuplicateGroups, 0)
})

test('AI targeted import preserves unrelated existing groups and daily scans can retain the semantic relationship', async t => {
  const exactBuffer = archive({ '001.jpg': 'unrelated exact duplicate content' })
  const fixture = await fixtureFor(t, [
    ...semanticBooks,
    { id: 'c', title: 'Unrelated duplicate one', hash: null, tags: {}, url: '', buffer: exactBuffer },
    { id: 'd', title: 'Unrelated duplicate two', hash: null, tags: {}, url: '', buffer: exactBuffer }
  ])
  const original = await scan(fixture, { scanMode: 'full' }, 'ai-existing-group')
  assert.equal(original.groups.length, 1)
  const unaffected = findPair(original, ['c', 'd'])
  assert.ok(unaffected)
  assert.deepEqual(unaffected.equivalenceClasses.map(item => item.memberIds.sort()), [['c', 'd']])

  const imported = await scan(fixture, { scanMode: 'daily', bookIds: ['a', 'b'], candidatePairs: [semanticPair], baseReport: original, groupIds: [] }, 'ai-targeted-import')
  assert.equal(imported.groups.length, 2)
  assert.deepEqual(findPair(imported, ['c', 'd']), unaffected, 'unselected groups retain their existing evidence and review identity')
  assert.deepEqual(findPair(imported, ['a', 'b']).equivalenceClasses, [])
  assert.equal(imported.aiCandidatePairs.semantic.length, 1)

  const replayed = await scan(fixture, { scanMode: 'daily', aiCandidatePairs: imported.aiCandidatePairs }, 'ai-replayed-daily')
  const replayedPair = findPair(replayed, ['a', 'b'])
  assert.ok(replayedPair, 'a local daily check must retain a previous AI relation without a new AI request')
  assert.equal(replayedPair.verification.status, 'verified')
  assert.ok(replayedPair.items.every(item => item.contentProof && item.evidenceRef))

  const scoped = await scan(fixture, { scanMode: 'full', baseReport: imported, groupIds: [findPair(imported, ['a', 'b']).id] }, 'ai-replayed-scoped')
  assert.ok(findPair(scoped, ['a', 'b']), 'verifying one group must retain its unchanged AI relation')
  assert.deepEqual(findPair(scoped, ['c', 'd']), unaffected)

  const nextScan = await scan(fixture, { scanMode: 'daily', semanticPairs: [semanticPair] }, 'ai-following-daily')
  const retained = findPair(nextScan, ['a', 'b'])
  assert.ok(retained, 'the explicit semantic pair must survive the next library scan')
  assert.ok(retained.reasons.some(reason => reason.code === 'ai-semantic'))
  assert.equal(retained.verification.status, 'verified')
  assert.deepEqual(retained.equivalenceClasses, [])
  assert.equal(retained.eligible, false)
  assert.deepEqual(findPair(nextScan, ['c', 'd']).equivalenceClasses.map(item => item.memberIds.sort()), [['c', 'd']])
})

test('full local verification reviews contained chapters together without inferring indirect equivalence', async t => {
  const fixture = await fixtureFor(t, [
    { id: 'a', title: 'Title Ch.1-3', hash: null, url: '', entries: { '01.jpg': 'one', '02.jpg': 'two', '03.jpg': 'three' } },
    { id: 'b', title: 'Title Ch.2', hash: null, url: '', entries: { '01.jpg': 'two', '02.jpg': 'three' } },
    { id: 'c', title: 'Title Ch.2 [Digital]', hash: null, url: '', entries: { '01.jpg': 'other', '02.jpg': 'other ending' } }
  ])
  const report = await scan(fixture, { scanMode: 'full', semanticPairs: [
    { leftId: 'a', rightId: 'b' }, { leftId: 'b', rightId: 'c' }],
  coveragePairs: [{ leftId: 'a', rightId: 'c', relation: 'same_work_left_contains_right' }] }, 'scope-separated')
  assert.deepEqual(report.groups.map(group => memberIds(group)), [['a', 'b', 'c']])
  assert.ok(report.coverageRelations.some(pair => pair.leftId === 'a' && pair.rightId === 'b' && pair.relation === 'left_contains_right'))
  assert.ok(report.coverageRelations.some(pair => pair.leftId === 'a' && pair.rightId === 'c' && pair.relation === 'left_contains_right'))
  assert.deepEqual(report.groups[0].relations.map(pair => [pair.leftId, pair.rightId]), [['a', 'b'], ['a', 'c'], ['b', 'c']])
  assert.ok(report.groups[0].equivalenceClasses.every(entry => !entry.memberIds.includes('a')))
  assert.equal(report.summary.duplicateGroups, 1)
  assert.equal(report.summary.coverageRelations, 2)
})

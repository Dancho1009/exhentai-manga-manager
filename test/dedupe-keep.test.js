const test = require('node:test')
const assert = require('node:assert/strict')
const helpers = import('../src/audit/dedupeReview.mjs')
const group = () => ({ evidenceRevision: 'current', items: ['a', 'b', 'c', 'd'].map(id => ({ id })),
  equivalenceClasses: [{ eligible: true, memberIds: ['a', 'b', 'c'], suggestedKeepId: 'a' }] })

test('keep drafts restore explicit saved mappings and default to keeping every version', async () => {
  const { createKeepDraft } = await helpers
  assert.deepEqual(createKeepDraft(group()).keepIds, ['a', 'b', 'c', 'd'])
  const saved = createKeepDraft(group(), { disposition: 'duplicate', quarantineToKeep: { b: 'a' }, keepIds: ['a'] })
  assert.deepEqual(saved.keepIds, ['a', 'c', 'd'])
  assert.deepEqual(saved.quarantineToKeep, { b: 'a' })
  assert.deepEqual(createKeepDraft(group(), { disposition: 'not-duplicate' }).quarantineToKeep, {})
})

test('checkboxes resolve a sole same-content keeper and keep independent editions', async () => {
  const { createKeepDraft, toggleKeep } = await helpers
  const draft = toggleKeep(group(), toggleKeep(group(), createKeepDraft(group()), 'b', false), 'c', false)
  assert.deepEqual(draft.keepIds, ['a', 'd'])
  assert.deepEqual(draft.quarantineToKeep, { b: 'a', c: 'a' })
  assert.deepEqual(draft.unresolvedIds, [])
})

test('multiple keepers and cross-version removals require an explicit target', async () => {
  const { createKeepDraft, toggleKeep, setKeepTarget } = await helpers
  let draft = toggleKeep(group(), createKeepDraft(group()), 'b', false)
  assert.deepEqual(draft.unresolvedIds, ['b'])
  draft = setKeepTarget(group(), draft, 'b', 'c')
  assert.deepEqual(draft.quarantineToKeep, { b: 'c' })
  draft = toggleKeep(group(), draft, 'd', false)
  assert.deepEqual(draft.unresolvedIds, ['d'])
  assert.deepEqual(setKeepTarget(group(), draft, 'd', 'a').quarantineToKeep, { b: 'c', d: 'a' })
})

test('changing a keeper retargets its dependents and never creates a mapping chain', async () => {
  const { createKeepDraft, toggleKeep, setKeepTarget } = await helpers
  let draft = setKeepTarget(group(), toggleKeep(group(), createKeepDraft(group()), 'b', false), 'b', 'a')
  draft = toggleKeep(group(), draft, 'a', false)
  assert.deepEqual(draft.keepIds, ['c', 'd'])
  assert.deepEqual(draft.quarantineToKeep, { a: 'c', b: 'c' })
  assert.ok(Object.values(draft.quarantineToKeep).every(id => draft.keepIds.includes(id)))
})

test('retain-only acts within the verified content class and cannot remove the last or nested keeper', async () => {
  const { createKeepDraft, toggleKeep, retainOnlyEquivalent } = await helpers
  const draft = retainOnlyEquivalent(group(), createKeepDraft(group()), 'b')
  assert.deepEqual(draft.keepIds, ['b', 'd'])
  assert.deepEqual(draft.quarantineToKeep, { a: 'b', c: 'b' })
  const single = { ...group(), items: [{ id: 'a' }], equivalenceClasses: [] }
  assert.deepEqual(toggleKeep(single, createKeepDraft(single), 'a', false).keepIds, ['a'])
  const nested = { ...group(), items: [{ id: 'a', nestedBookIds: ['child'] }, { id: 'b' }], equivalenceClasses: [] }
  assert.deepEqual(toggleKeep(nested, createKeepDraft(nested), 'a', false).keepIds, ['a', 'b'])
})

test('draft changes track selections, targets and manual confirmation without treating automatic resolution as a change', async () => {
  const { createKeepDraft, toggleKeep, keepDraftFingerprint } = await helpers
  const initial = createKeepDraft(group())
  assert.notEqual(keepDraftFingerprint(initial), keepDraftFingerprint(toggleKeep(group(), initial, 'b', false)))
  assert.notEqual(keepDraftFingerprint(initial), keepDraftFingerprint(initial, 'reason', true))
  assert.equal(keepDraftFingerprint(initial), keepDraftFingerprint(createKeepDraft(group())))
})

const test = require('node:test')
const assert = require('node:assert/strict')
const helpers = import('../src/audit/dedupeReview.mjs')
const group = () => ({ id: 'group', evidenceRevision: 'current', items: ['a', 'b', 'c', 'd'].map(id => ({ id })),
  equivalenceClasses: [{ eligible: true, memberIds: ['a', 'b', 'c'], suggestedKeepId: 'a' }] })

test('checkbox reviews restore the exact retained copies; older mapped reviews still reopen', async () => {
  const { createKeepDraft } = await helpers
  assert.deepEqual(createKeepDraft(group()).keepIds, ['a', 'b', 'c', 'd'])
  const checkbox = createKeepDraft(group(), { disposition: 'duplicate', selectionMode: 'checkbox', keepIds: ['a', 'd'] })
  assert.deepEqual(checkbox.keepIds, ['a', 'd'])
  const legacy = createKeepDraft(group(), { disposition: 'duplicate', quarantineToKeep: { b: 'a' }, keepIds: ['a'] })
  assert.deepEqual(legacy.keepIds, ['a', 'c', 'd'])
  assert.deepEqual(createKeepDraft(group(), { disposition: 'not-duplicate' }).keepIds, ['a', 'b', 'c', 'd'])
})

test('one or several retained copies need no manually chosen target', async () => {
  const { createKeepDraft, toggleKeep, getDecisionFiles } = await helpers
  let draft = createKeepDraft(group())
  for (const id of ['b', 'c', 'd']) draft = toggleKeep(group(), draft, id, false)
  assert.deepEqual(draft.keepIds, ['a'])
  assert.deepEqual(getDecisionFiles({ groups: [group()] }, { group: { disposition: 'duplicate', selectionMode: 'checkbox', keepIds: draft.keepIds } }).map(item => item.id), ['b', 'c', 'd'])
  draft = toggleKeep(group(), draft, 'c', true)
  assert.deepEqual(draft.keepIds, ['a', 'c'])
  assert.equal(toggleKeep(group(), { ...draft, keepIds: ['a'] }, 'a', false).keepIds.length, 1)
})

test('retain-only changes only its verified equivalence class', async () => {
  const { createKeepDraft, retainOnlyEquivalent } = await helpers
  assert.deepEqual(retainOnlyEquivalent(group(), createKeepDraft(group()), 'b').keepIds, ['b', 'd'])
  const single = { ...group(), items: [{ id: 'a' }], equivalenceClasses: [] }
  assert.deepEqual(createKeepDraft(single).keepIds, ['a'])
})

test('draft changes track checkbox choices and optional review note', async () => {
  const { createKeepDraft, toggleKeep, keepDraftFingerprint } = await helpers
  const initial = createKeepDraft(group())
  assert.notEqual(keepDraftFingerprint(initial), keepDraftFingerprint(toggleKeep(group(), initial, 'b', false)))
  assert.notEqual(keepDraftFingerprint(initial), keepDraftFingerprint(initial, 'note'))
  assert.equal(keepDraftFingerprint(initial), keepDraftFingerprint(createKeepDraft(group())))
})

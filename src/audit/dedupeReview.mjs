export const isPendingDecision = decision => !decision || decision.disposition === 'deferred'

export const resolveKeepTargets = (group, draft) => {
  const keepIds = group.items.filter(item => draft.keepIds.includes(item.id) || item.nestedBookIds?.length).map(item => item.id)
  const targetOverrides = {}, quarantineToKeep = {}, unresolvedIds = []
  for (const item of group.items) {
    if (keepIds.includes(item.id)) continue
    const explicit = draft.targetOverrides?.[item.id]
    if (keepIds.includes(explicit)) {
      targetOverrides[item.id] = explicit
      quarantineToKeep[item.id] = explicit
      continue
    }
    const equivalence = group.equivalenceClasses?.find(entry => entry.eligible && entry.memberIds.includes(item.id))
    const peers = equivalence?.memberIds.filter(id => keepIds.includes(id)) || []
    if (peers.length === 1) quarantineToKeep[item.id] = peers[0]
    else unresolvedIds.push(item.id)
  }
  return { evidenceRevision: group.evidenceRevision, keepIds, targetOverrides, quarantineToKeep, unresolvedIds }
}

export const createKeepDraft = (group, decision) => {
  const mapping = decision?.disposition === 'duplicate' ? decision.quarantineToKeep || {} : {}
  return resolveKeepTargets(group, {
    keepIds: group.items.filter(item => !mapping[item.id]).map(item => item.id), targetOverrides: mapping
  })
}

export const toggleKeep = (group, draft, bookId, checked) => {
  if (!checked && (draft.keepIds.length === 1 || group.items.find(item => item.id === bookId)?.nestedBookIds?.length)) return draft
  const keepIds = checked ? [...draft.keepIds, bookId] : draft.keepIds.filter(id => id !== bookId)
  return resolveKeepTargets(group, { ...draft, keepIds })
}

export const setKeepTarget = (group, draft, bookId, keepId) => resolveKeepTargets(group, {
  ...draft, targetOverrides: { ...draft.targetOverrides, [bookId]: keepId }
})

export const retainOnlyEquivalent = (group, draft, bookId) => {
  const equivalence = group.equivalenceClasses?.find(entry => entry.eligible && entry.memberIds.includes(bookId))
  if (!equivalence) return draft
  return resolveKeepTargets(group, {
    keepIds: group.items.filter(item => equivalence.memberIds.includes(item.id) ? item.id === bookId : draft.keepIds.includes(item.id)).map(item => item.id),
    targetOverrides: Object.fromEntries(Object.entries(draft.targetOverrides).filter(([id]) => !equivalence.memberIds.includes(id)))
  })
}

export const keepDraftFingerprint = (selection, reason = '', differencesConfirmed = false) => JSON.stringify([
  selection.keepIds, selection.quarantineToKeep, selection.unresolvedIds, reason, differencesConfirmed
])

export const suggestedDecision = group => {
  const quarantineToKeep = {}
  for (const equivalence of group.equivalenceClasses || []) {
    if (!equivalence.eligible) continue
    for (const id of equivalence.memberIds) if (id !== equivalence.suggestedKeepId) quarantineToKeep[id] = equivalence.suggestedKeepId
  }
  if (!Object.keys(quarantineToKeep).length) return null
  return { disposition: 'duplicate', evidenceRevision: group.evidenceRevision,
    keepIds: group.items.filter(item => !quarantineToKeep[item.id]).map(item => item.id), quarantineToKeep,
    reason: '', confirmedConflictCodes: [] }
}

export const getDecisionFiles = (report, decisions = {}, selections = {}) => (report?.groups || []).flatMap(group => {
  const mapping = decisions[group.id]?.disposition === 'duplicate' ? decisions[group.id].quarantineToKeep || {}
    : decisions[group.id] ? {} : Object.fromEntries((selections[group.id]?.quarantineIds || []).map(id => [id, selections[group.id].keepId]))
  return group.items.filter(item => mapping[item.id]).map(item => ({ ...item, groupId: group.id, keepId: mapping[item.id] }))
})

export const pagePairs = (evidence, alignment = 'ordinal', differencesOnly = false) => {
  if (!evidence?.comparison?.verified) return []
  const { comparison, left, right } = evidence
  if (alignment === 'hash') return [...comparison.matched.map(pair => ({ left: pair.leftIndex, right: pair.rightIndex, same: true })),
    ...comparison.onlyLeft.map(page => ({ left: page.index, right: null, same: false })),
    ...comparison.onlyRight.map(page => ({ left: null, right: page.index, same: false }))].filter(pair => !differencesOnly || !pair.same)
  return Array.from({ length: Math.max(left.images.length, right.images.length) }, (_, index) => ({
    left: left.images[index] ? index : null, right: right.images[index] ? index : null,
    same: Boolean(left.images[index] && left.images[index]?.sha256 === right.images[index]?.sha256)
  })).filter(pair => !differencesOnly || !pair.same)
}

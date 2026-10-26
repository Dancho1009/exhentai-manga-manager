export const isPendingDecision = decision => !decision || decision.disposition === 'deferred'

export const resolveKeepTargets = (group, draft) => {
  const keepIds = group.items.filter(item => draft.keepIds.includes(item.id)).map(item => item.id)
  return { evidenceRevision: group.evidenceRevision, keepIds }
}

export const createKeepDraft = (group, decision) => {
  const mapping = decision?.disposition === 'duplicate' ? decision.quarantineToKeep || {} : {}
  return resolveKeepTargets(group, {
    keepIds: decision?.disposition === 'duplicate' && decision.selectionMode === 'checkbox'
      ? decision.keepIds || []
      : group.items.filter(item => !mapping[item.id]).map(item => item.id)
  })
}

export const toggleKeep = (group, draft, bookId, checked) => {
  if (!checked && draft.keepIds.length === 1) return draft
  const keepIds = checked ? [...draft.keepIds, bookId] : draft.keepIds.filter(id => id !== bookId)
  return resolveKeepTargets(group, { ...draft, keepIds })
}

export const retainOnlyEquivalent = (group, draft, bookId) => {
  const equivalence = group.equivalenceClasses?.find(entry => entry.eligible && entry.memberIds.includes(bookId))
  if (!equivalence) return draft
  return resolveKeepTargets(group, {
    keepIds: group.items.filter(item => equivalence.memberIds.includes(item.id) ? item.id === bookId : draft.keepIds.includes(item.id)).map(item => item.id)
  })
}

export const keepDraftFingerprint = (selection, reason = '') => JSON.stringify([selection.keepIds, reason])

export const suggestedDecision = group => {
  const quarantineToKeep = {}
  for (const equivalence of group.equivalenceClasses || []) {
    if (!equivalence.eligible) continue
    for (const id of equivalence.memberIds) if (id !== equivalence.suggestedKeepId) quarantineToKeep[id] = equivalence.suggestedKeepId
  }
  if (!Object.keys(quarantineToKeep).length) return null
  return { disposition: 'duplicate', selectionMode: 'checkbox', evidenceRevision: group.evidenceRevision,
    keepIds: group.items.filter(item => !quarantineToKeep[item.id]).map(item => item.id), reason: '' }
}

export const getDecisionFiles = (report, decisions = {}, selections = {}) => (report?.groups || []).flatMap(group => {
  const decision = decisions[group.id]
  const mapping = decision?.disposition === 'duplicate' ? decision.quarantineToKeep || {}
    : decisions[group.id] ? {} : Object.fromEntries((selections[group.id]?.quarantineIds || []).map(id => [id, selections[group.id].keepId]))
  const quarantined = decision?.disposition === 'duplicate' && decision.selectionMode === 'checkbox'
    ? group.items.filter(item => !decision.keepIds?.includes(item.id))
    : group.items.filter(item => mapping[item.id])
  return quarantined.map(item => ({ ...item, groupId: group.id, keepId: mapping[item.id] || null }))
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

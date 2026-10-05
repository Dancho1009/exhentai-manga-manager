const normalizeIds = values => [...new Set((Array.isArray(values) ? values : []).map(value => String(value)))]

export const togglePageRecoverySelection = (selectedIds, rowId, selected) => {
  const next = new Set(normalizeIds(selectedIds))
  const id = String(rowId)
  if (selected) next.add(id)
  else next.delete(id)
  return [...next]
}

export const mergePageRecoveryPageSelection = (selectedIds, visibleIds, selectedVisibleIds) => {
  const visible = new Set(normalizeIds(visibleIds))
  const selectedVisible = new Set(normalizeIds(selectedVisibleIds))
  const next = normalizeIds(selectedIds).filter(id => !visible.has(id))
  for (const id of selectedVisible) {
    if (!next.includes(id)) next.push(id)
  }
  return next
}

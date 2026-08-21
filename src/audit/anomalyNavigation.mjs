export const getAnomalyNavigation = (items = [], selectedId) => {
  const list = Array.isArray(items) ? items : []
  const index = list.findIndex(item => item?.id === selectedId)
  return {
    index,
    current: index >= 0 ? list[index] : null,
    previous: index > 0 ? list[index - 1] : null,
    next: index >= 0 && index < list.length - 1 ? list[index + 1] : null,
    position: index >= 0 ? { current: index + 1, total: list.length } : null
  }
}

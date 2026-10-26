const ordinalCoverage = value => value && Number.isFinite(value.start) &&
  (value.end === null || value.end === undefined || Number.isFinite(value.end))
  ? value.end === null || value.end === undefined || value.end === value.start
    ? { kind: 'single', value: value.start }
    : { kind: 'range', start: value.start, end: value.end }
  : null

const listCoverage = values => {
  const distinct = [...new Set(values.map(Number))].sort((a, b) => a - b)
  return distinct.length > 1 && distinct.every(Number.isFinite) ? { kind: 'list', values: distinct } : null
}

const covers = (coverage, value) => coverage.kind === 'single' ? coverage.value === value
  : coverage.kind === 'range' ? coverage.start <= value && value <= coverage.end
    : coverage.values.includes(value)

const isIntegerRange = coverage => coverage.kind === 'range' &&
  Number.isInteger(coverage.start) && Number.isInteger(coverage.end)

const contains = (left, right) => {
  if (right.kind === 'single') return covers(left, right.value)
  if (right.kind === 'list') return right.values.every(value => covers(left, value))
  if (left.kind === 'range') return left.start <= right.start && left.end >= right.end
  if (left.kind === 'list' && isIntegerRange(right)) {
    return right.end - right.start + 1 === left.values.filter(value =>
      Number.isInteger(value) && right.start <= value && value <= right.end).length
  }
  return false
}

const overlaps = (left, right) => {
  if (left.kind === 'single') return covers(right, left.value)
  if (right.kind === 'single') return covers(left, right.value)
  if (left.kind === 'range' && right.kind === 'range') return left.start <= right.end && right.start <= left.end
  if (left.kind === 'list') return left.values.some(value => covers(right, value))
  return right.values.some(value => covers(left, value))
}

const coverageRelation = (left, right) => {
  if (!left || !right) return 'unknown'
  const leftContains = contains(left, right), rightContains = contains(right, left)
  if (leftContains && rightContains) return 'equal'
  if (leftContains) return 'left_contains_right'
  if (rightContains) return 'right_contains_left'
  return overlaps(left, right) ? 'overlap' : 'disjoint'
}

const bookCoverageRelation = (left, right) => {
  const relations = ['volume', 'chapter'].map(field => coverageRelation(
    left[`${field}Coverage`] || ordinalCoverage(left[field]),
    right[`${field}Coverage`] || ordinalCoverage(right[field])
  )).filter(value => value !== 'unknown')
  if (!relations.length) return 'unknown'
  if (relations.includes('disjoint')) return 'disjoint'
  const distinct = [...new Set(relations.filter(value => value !== 'equal'))]
  return distinct.length <= 1 ? distinct[0] || 'equal' : 'unknown'
}

module.exports = { ordinalCoverage, listCoverage, coverageRelation, bookCoverageRelation }

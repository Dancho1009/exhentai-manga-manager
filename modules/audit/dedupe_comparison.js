const { stableId } = require('./utils.js')

const compareBookEvidence = (left, right) => {
  const leftImages = left?.images || []
  const rightImages = right?.images || []
  const queues = new Map()
  rightImages.forEach((image, index) => {
    if (!image.sha256) return
    if (!queues.has(image.sha256)) queues.set(image.sha256, [])
    queues.get(image.sha256).push(index)
  })
  const matched = []
  const onlyLeft = []
  const used = new Set()
  leftImages.forEach((image, index) => {
    const rightIndex = queues.get(image.sha256)?.shift()
    if (rightIndex === undefined) onlyLeft.push({ index, ...image })
    else { matched.push({ leftIndex: index, rightIndex }); used.add(rightIndex) }
  })
  const onlyRight = rightImages.flatMap((image, index) => used.has(index) ? [] : [{ index, ...image }])
  const ordinalDifferences = Array.from({ length: Math.max(leftImages.length, rightImages.length) }, (_, index) => index)
    .filter(index => !leftImages[index]?.sha256 || leftImages[index]?.sha256 !== rightImages[index]?.sha256)
  const ancillaryPaths = new Set([...(left?.ancillary || []).map(entry => entry.path), ...(right?.ancillary || []).map(entry => entry.path)])
  const leftFiles = new Map((left?.ancillary || []).map(entry => [entry.path, entry]))
  const rightFiles = new Map((right?.ancillary || []).map(entry => [entry.path, entry]))
  const ancillary = [...ancillaryPaths].sort().map(filepath => {
    const a = leftFiles.get(filepath) || null
    const b = rightFiles.get(filepath) || null
    return { path: filepath, left: a, right: b, status: !a ? 'right-only' : !b ? 'left-only' : a.sha256 && a.sha256 === b.sha256 ? 'same' : 'changed' }
  })
  const verified = Boolean(left?.formatVersion >= 2 && right?.formatVersion >= 2)
  return { verified, leftPageCount: leftImages.length, rightPageCount: rightImages.length,
    orderedEqual: verified && leftImages.length > 0 && ordinalDifferences.length === 0,
    multisetEqual: verified && leftImages.length > 0 && onlyLeft.length === 0 && onlyRight.length === 0,
    matchedCount: matched.length, matched, onlyLeft, onlyRight, ordinalDifferences,
    firstDifference: ordinalDifferences[0] ?? null, ancillary,
    ancillaryEqual: verified && ancillary.every(entry => entry.status === 'same'),
    coverage: { left: leftImages.length ? matched.length / leftImages.length : 0, right: rightImages.length ? matched.length / rightImages.length : 0 } }
}

const contentProof = evidence => evidence?.formatVersion >= 2 ? stableId(evidence.imageSignature, evidence.ancillarySignature, evidence.uncoveredEntries || []) : null
module.exports = { compareBookEvidence, contentProof }

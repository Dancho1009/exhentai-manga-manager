const { stableId, normalizePath, extractFilenameIdentity } = require('./utils.js')
const { summarizeBook, groupBy, scoreKeeper } = require('./dedupe_analyzer.js')
const { resolveBookIdentity } = require('./dedupe_identity.js')

const { DEDUPE_REPORT_RULES_VERSION, normalizeTitle, parseBookSemantics } = require('./dedupe_title.js')
const { bookCoverageRelation } = require('./part_coverage.js')
const { compareBookEvidence, contentProof } = require('./dedupe_comparison.js')

const contentRelationOf = comparison => !comparison?.verified ? 'unknown' : !comparison.matchedCount ? 'no-exact-pages'
  : comparison.multisetEqual ? 'equal-pages'
    : comparison.onlyLeft.length === 0 ? 'right_contains_left'
      : comparison.onlyRight.length === 0 ? 'left_contains_right' : 'overlap'

const hasInteriorPageRun = (left, right) => {
  const comparison = compareBookEvidence(left.inspection, right.inspection)
  let first = null, previous = null, length = 0
  for (const match of comparison.matched) {
    if (previous && match.leftIndex === previous.leftIndex + 1 && match.rightIndex === previous.rightIndex + 1) length++
    else { first = match; length = 1 }
    if (length >= 5 && (first.leftIndex < comparison.leftPageCount - 8 || first.rightIndex < comparison.rightPageCount - 8)) return true
    previous = match
  }
  return false
}

const collectDuplicateCandidates = wrappedBooks => {
  const buckets = new Map()
  const add = (key, kind, item) => {
    if (!key) return
    const id = `${kind}:${key}`
    if (!buckets.has(id)) buckets.set(id, { kind, items: [] })
    buckets.get(id).items.push(item)
  }
  for (const wrapped of wrappedBooks) {
    wrapped.semantic = parseBookSemantics(wrapped)
    const identity = resolveBookIdentity(wrapped, wrapped.inspection?.ehviewer || wrapped.manifest?.ehviewer)
    add(normalizePath(wrapped.raw.filepath), 'database-path', wrapped)
    add(wrapped.archiveSha256, 'archive-sha256', wrapped)
    add(wrapped.manifest?.orderedCandidate, 'manifest-order', wrapped)
    add(wrapped.manifest?.multisetCandidate, 'manifest-set', wrapped)
    add(wrapped.manifest?.sizeCandidate, 'page-sizes', wrapped)
    add(identity.key, 'source', wrapped)
    const filenameIdentity = extractFilenameIdentity(wrapped.raw.filepath)
    if (filenameIdentity) add(`${filenameIdentity.namespace}:${filenameIdentity.id}`, 'filename-id', wrapped)
    add(wrapped.raw.hash, 'sample-hash', wrapped)
    if (wrapped.raw.coverHash && (wrapped.manifest?.pageCount || wrapped.raw.pageCount)) add(`${wrapped.manifest?.pageCount || wrapped.raw.pageCount}:${wrapped.raw.coverHash}`, 'cover-pages', wrapped)
    add(wrapped.inspection?.pageCount ? wrapped.inspection.imageSignature : null, 'image-content', wrapped)
    add(wrapped.inspection?.pageCount ? wrapped.inspection.imageMultisetSignature : null, 'image-set', wrapped)
    for (const artist of wrapped.semantic.artists) {
      for (const title of wrapped.semantic.titles) add(`${normalizeTitle(artist)}:${title}`, 'title-author', wrapped)
    }
    for (const publication of wrapped.semantic.publications.filter(item => item.kind === 'whole-issue')) {
      add(`${publication.nameKey}:${publication.issue || publication.date}`, 'publication-issue', wrapped)
    }
  }
  // An inverted page index discovers contained editions without an all-library
  // pairwise comparison. Pages shared by three or more distinct contents cannot
  // establish partial overlap on their own (e.g. a translation group's credits).
  // A consecutive interior run still identifies a story reprinted in several books.
  const byPage = new Map()
  const overlaps = new Map()
  for (const book of wrappedBooks) {
    const counts = new Map()
    for (const page of book.inspection?.images || []) counts.set(page.sha256, (counts.get(page.sha256) || 0) + 1)
    for (const [digest, count] of counts) {
      if (!byPage.has(digest)) byPage.set(digest, [])
      byPage.get(digest).push({ book, count })
    }
  }
  for (const peers of byPage.values()) {
    if (peers.length < 2) continue
    const distinctContents = new Set(peers.map(({ book }) => book.inspection.imageMultisetSignature ||
      book.inspection.imageSignature || String(book.raw.id))).size
    for (let a = 0; a < peers.length; a++) for (let b = a + 1; b < peers.length; b++) {
      const left = peers[a], right = peers[b]
      const key = JSON.stringify([String(left.book.raw.id), String(right.book.raw.id)].sort())
      const pair = overlaps.get(key) || { items: [left.book, right.book], count: 0, specificPages: 0 }
      pair.count += Math.min(left.count, right.count)
      if (distinctContents === 2) pair.specificPages++
      overlaps.set(key, pair)
    }
  }
  for (const pair of overlaps.values()) {
    const [a, b] = pair.items.map(item => item.inspection.pageCount)
    if (pair.count < 2 || pair.count === a && pair.count === b) continue
    const contained = a !== b && pair.count === Math.min(a, b)
    if (!contained && pair.specificPages < 2 && (pair.count < 5 || !hasInteriorPageRun(...pair.items))) continue
    buckets.set('page-overlap:' + pair.items.map(item => item.raw.id).sort().join(':'),
      { kind: contained ? 'page-coverage' : 'page-overlap', items: pair.items })
  }
  return [...buckets.values()].map(bucket => ({ ...bucket, items: [...new Map(bucket.items.map(item => [String(item.raw.id), item])).values()] })).filter(bucket => bucket.items.length > 1)
}

const keeper = members => {
  const ordered = [...members].sort((a, b) =>
    Number(Boolean(b.inspection)) - Number(Boolean(a.inspection)) ||
    Number(resolveBookIdentity(b, b.inspection?.ehviewer || b.manifest?.ehviewer).status === 'known') - Number(resolveBookIdentity(a, a.inspection?.ehviewer || a.manifest?.ehviewer).status === 'known') ||
    scoreKeeper(b) - scoreKeeper(a) || a.raw.filepath.localeCompare(b.raw.filepath))
  const selected = ordered[0]
  return { id: String(selected.raw.id), reasons: [selected.inspection ? 'readable-content' : 'archive-verified',
    ...(selected.raw.mark ? ['marked'] : []), ...(Number(selected.raw.readCount) > 0 ? ['read-history'] : []),
    ...(selected.effective.status === 'tagged' ? ['metadata-complete'] : []), 'stable-path'] }
}

const buildDuplicateClassification = (wrappedBooks, { semanticPairs = [], coveragePairs = [] } = {}) => {
  const candidates = collectDuplicateCandidates(wrappedBooks)
  const byId = new Map(wrappedBooks.map(item => [String(item.raw.id), item]))
  for (const { leftId, rightId } of semanticPairs) {
    const left = byId.get(String(leftId)), right = byId.get(String(rightId))
    if (left && right && left !== right) candidates.push({ kind: 'ai-semantic', items: [left, right] })
  }
  const parent = new Map(wrappedBooks.map(item => [String(item.raw.id), String(item.raw.id)]))
  const find = id => { const p = parent.get(id); if (p !== id) parent.set(id, find(p)); return parent.get(id) }
  const candidateEdges = [], accepted = [], coverage = new Map(), metadataConflicts = new Set()
  const pairKey = (left, right) => JSON.stringify([String(left.raw.id), String(right.raw.id)].sort())
  const exactProof = (left, right) => Boolean(
    left.archiveSha256 && left.archiveSha256 === right.archiveSha256 ||
    left.inspection?.pageCount > 0 && left.inspection.pageCount === right.inspection?.pageCount &&
      left.inspection.imageSignature && left.inspection.imageSignature === right.inspection.imageSignature &&
      left.inspection.ancillarySignature === right.inspection.ancillarySignature &&
      (!contentProof(left.inspection) || contentProof(left.inspection) === contentProof(right.inspection)))
  const addCoverage = (left, right, scope, source) => {
    const [a, b] = String(left.raw.id) < String(right.raw.id) ? [left, right] : [right, left]
    const key = pairKey(left, right)
    const normalized = a === left ? scope : scope === 'left_contains_right' ? 'right_contains_left'
      : scope === 'right_contains_left' ? 'left_contains_right' : scope
    const comparison = a.inspection && b.inspection ? compareBookEvidence(a.inspection, b.inspection) : null
    const localScope = bookCoverageRelation(a.semantic || {}, b.semantic || {})
    const pageScope = comparison?.verified && comparison.leftPageCount !== comparison.rightPageCount &&
      comparison.matchedCount === Math.min(comparison.leftPageCount, comparison.rightPageCount)
      ? comparison.coverage.left === 1 ? 'right_contains_left' : 'left_contains_right' : null
    const declaredRelation = ['left_contains_right', 'right_contains_left', 'overlap'].includes(localScope) ? localScope : normalized
    const contentRelation = contentRelationOf(comparison)
    const previous = coverage.get(key)
    coverage.set(key, { leftId: String(a.raw.id), rightId: String(b.raw.id),
      leftTitle: a.effective.title || a.raw.title || String(a.raw.id), rightTitle: b.effective.title || b.raw.title || String(b.raw.id),
      relation: declaredRelation, declaredRelation, contentRelation, category: 'coverage',
      sources: [...new Set([...(previous?.sources || []), source])],
      metadataConflict: Boolean(previous?.metadataConflict || pageScope && ['left_contains_right', 'right_contains_left'].includes(localScope) && pageScope !== localScope),
      verified: comparison?.verified || false, matchedPages: comparison?.matchedCount || 0,
      leftPages: comparison?.leftPageCount || 0, rightPages: comparison?.rightPageCount || 0,
      leftUniquePages: comparison?.onlyLeft.length ?? null, rightUniquePages: comparison?.onlyRight.length ?? null,
      ancillaryDifferences: comparison?.ancillary.filter(entry => entry.status !== 'same').length ?? null })
  }
  for (const bucket of candidates) {
    for (let a = 0; a < bucket.items.length; a++) for (let b = a + 1; b < bucket.items.length; b++) {
      const left = bucket.items[a], right = bucket.items[b]
      const scope = bookCoverageRelation(left.semantic || {}, right.semantic || {})
      const exact = exactProof(left, right)
      const comparison = left.inspection && right.inspection ? compareBookEvidence(left.inspection, right.inspection) : null
      const containedPages = comparison?.verified && comparison.leftPageCount !== comparison.rightPageCount &&
        comparison.matchedCount >= 2 && comparison.matchedCount === Math.min(comparison.leftPageCount, comparison.rightPageCount)
      if (!exact && containedPages) {
        addCoverage(left, right, ['left_contains_right', 'right_contains_left', 'overlap'].includes(scope) ? scope :
          comparison.coverage.left === 1 ? 'right_contains_left' : 'left_contains_right', bucket.kind)
        continue
      }
      if (!exact && ['page-coverage', 'page-overlap'].includes(bucket.kind)) {
        const relation = scope === 'left_contains_right' || scope === 'right_contains_left' || scope === 'overlap'
          ? scope : comparison.coverage.left === 1 ? 'right_contains_left' : comparison.coverage.right === 1 ? 'left_contains_right' : 'overlap'
        addCoverage(left, right, relation, bucket.kind)
        continue
      }
      if (!exact && ['left_contains_right', 'right_contains_left', 'overlap'].includes(scope)) {
        addCoverage(left, right, scope, bucket.kind)
        continue
      }
      if (!exact && scope === 'disjoint' && bucket.kind !== 'database-path') continue
      if (exact && !['equal', 'unknown'].includes(scope)) metadataConflicts.add(pairKey(left, right))
      candidateEdges.push({ kind: bucket.kind, items: [left, right] })
    }
  }
  for (const pair of coveragePairs) {
    const left = byId.get(String(pair.leftId)), right = byId.get(String(pair.rightId))
    if (!left || !right || left === right) continue
    const scope = { same_work_left_contains_right: 'left_contains_right', same_work_right_contains_left: 'right_contains_left',
      same_work_partial_overlap: 'overlap' }[pair.relation]
    if (scope && !exactProof(left, right)) addCoverage(left, right, scope, 'ai-semantic')
  }
  const sameWholeBook = (left, right) => {
    if (exactProof(left, right) || normalizePath(left.raw.filepath) === normalizePath(right.raw.filepath)) return true
    if (left.inspection?.pageCount > 0 && left.inspection.pageCount === right.inspection?.pageCount &&
        left.inspection.imageMultisetSignature && left.inspection.imageMultisetSignature === right.inspection.imageMultisetSignature) return true
    if (coverage.has(pairKey(left, right))) return false
    const leftIdentity = resolveBookIdentity(left, left.inspection?.ehviewer || left.manifest?.ehviewer)
    const rightIdentity = resolveBookIdentity(right, right.inspection?.ehviewer || right.manifest?.ehviewer)
    if (leftIdentity.status === 'known' && leftIdentity.key === rightIdentity.key) return true
    const publications = [left, right].map(book => (book.semantic?.publications || []).filter(item => item.kind === 'whole-issue'))
    if (publications.some(items => items.length)) return publications.every(items => items.length) && publications[0].some(a =>
      publications[1].some(b => a.nameKey === b.nameKey && (a.issue || a.date) && (a.issue || a.date) === (b.issue || b.date)))
    if (bookCoverageRelation(left.semantic || {}, right.semantic || {}) !== 'equal' &&
        bookCoverageRelation(left.semantic || {}, right.semantic || {}) !== 'unknown') return false
    const rightTitles = new Set(right.semantic?.titles || [])
    return (left.semantic?.titles || []).some(title => rightTitles.has(title))
  }
  const distinctWholeIssues = (left, right) => {
    const leftIssues = (left.semantic?.publications || []).filter(item => item.kind === 'whole-issue')
    const rightIssues = (right.semantic?.publications || []).filter(item => item.kind === 'whole-issue')
    return leftIssues.length > 0 && rightIssues.length > 0 && !leftIssues.some(a =>
      rightIssues.some(b => a.nameKey === b.nameKey && (a.issue || a.date) && (a.issue || a.date) === (b.issue || b.date)))
  }
  // Only pairwise-compatible whole books form a multi-member selection.
  // A shared page run remains a direct two-book review item.
  const members = new Map(wrappedBooks.map(item => [String(item.raw.id), [item]]))
  const pairCandidates = new Map()
  const rememberPair = edge => {
    if (distinctWholeIssues(...edge.items)) return
    const key = pairKey(...edge.items)
    if (!pairCandidates.has(key)) pairCandidates.set(key, { items: edge.items })
  }
  candidateEdges.sort((a, b) => Number(exactProof(...b.items)) - Number(exactProof(...a.items)) ||
    Number(bookCoverageRelation(...b.items.map(item => item.semantic || {})) === 'equal') -
      Number(bookCoverageRelation(...a.items.map(item => item.semantic || {})) === 'equal'))
  for (const edge of candidateEdges) {
    const [left, right] = edge.items, leftRoot = find(String(left.raw.id)), rightRoot = find(String(right.raw.id))
    if (!sameWholeBook(left, right)) { rememberPair(edge); continue }
    if (leftRoot !== rightRoot) {
      if (members.get(leftRoot).some(a => members.get(rightRoot).some(b => !sameWholeBook(a, b)))) {
        rememberPair(edge)
        continue
      }
      parent.set(rightRoot, leftRoot)
      members.set(leftRoot, [...members.get(leftRoot), ...members.get(rightRoot)])
      members.delete(rightRoot)
    }
    accepted.push(edge)
  }
  const primaryIds = new Set(accepted.flatMap(edge => edge.items.map(item => String(item.raw.id))))
  const components = [...groupBy(wrappedBooks.filter(item => primaryIds.has(String(item.raw.id))), item => find(String(item.raw.id))).values()]
    .map(items => ({ members: items, reviewShape: 'whole-book' }))
  const pairs = new Map()
  for (const relation of coverage.values()) pairs.set(JSON.stringify([relation.leftId, relation.rightId]),
    { members: [byId.get(relation.leftId), byId.get(relation.rightId)], reviewShape: 'direct-pair' })
  for (const [key, candidate] of pairCandidates) if (!pairs.has(key)) pairs.set(key,
    { members: candidate.items, reviewShape: 'direct-pair' })
  for (const [key, pair] of pairs) {
    const [leftId, rightId] = JSON.parse(key)
    if (find(leftId) !== find(rightId) || !primaryIds.has(leftId)) components.push(pair)
  }
  const groups = []
  for (const component of components) {
    const members = [...component.members].sort((a, b) => String(a.raw.id).localeCompare(String(b.raw.id)))
    const memberIds = new Set(members.map(item => String(item.raw.id)))
    const scopedEdges = component.reviewShape === 'whole-book' ? accepted : candidateEdges.filter(edge =>
      edge.items.every(item => memberIds.has(String(item.raw.id))))
    const reasons = scopedEdges.filter(bucket => bucket.items.every(item => memberIds.has(String(item.raw.id))))
      .map(bucket => ({ code: bucket.kind, memberIds: bucket.items.map(item => String(item.raw.id)) }))
    const coverageRelations = [...coverage.values()].filter(relation => memberIds.has(relation.leftId) && memberIds.has(relation.rightId))
    reasons.push(...coverageRelations.map(relation => ({ code: relation.sources[0] || 'coverage', memberIds: [relation.leftId, relation.rightId] })))
    const direct = new Map(coverageRelations.map(relation => [JSON.stringify([relation.leftId, relation.rightId]), relation]))
    for (const edge of scopedEdges.filter(edge => edge.items.every(item => memberIds.has(String(item.raw.id))))) {
      const [a, b] = [...edge.items].sort((left, right) => String(left.raw.id).localeCompare(String(right.raw.id)))
      const leftId = String(a.raw.id), rightId = String(b.raw.id), key = JSON.stringify([leftId, rightId])
      const previous = direct.get(key)
      if (previous) {
        previous.sources = [...new Set([...previous.sources, edge.kind])]
        continue
      }
      const comparison = a.inspection && b.inspection ? compareBookEvidence(a.inspection, b.inspection) : null
      const declaredRelation = bookCoverageRelation(a.semantic || {}, b.semantic || {})
      direct.set(key, { leftId, rightId,
        leftTitle: a.effective.title || a.raw.title || leftId, rightTitle: b.effective.title || b.raw.title || rightId,
        relation: declaredRelation, declaredRelation, contentRelation: contentRelationOf(comparison), category: 'duplicate',
        sources: [edge.kind], metadataConflict: metadataConflicts.has(key), verified: comparison?.verified || false,
        matchedPages: comparison?.matchedCount || 0, leftPages: comparison?.leftPageCount || 0, rightPages: comparison?.rightPageCount || 0,
        leftUniquePages: comparison?.onlyLeft.length ?? null, rightUniquePages: comparison?.onlyRight.length ?? null,
        ancillaryDifferences: comparison?.ancillary.filter(entry => entry.status !== 'same').length ?? null })
    }
    const relations = [...direct.values()].sort((a, b) => a.leftId.localeCompare(b.leftId) || a.rightId.localeCompare(b.rightId))
    const scopeConflicts = [...metadataConflicts].filter(key => JSON.parse(key).every(id => memberIds.has(id)))
    const pathConflict = [...groupBy(members, item => normalizePath(item.raw.filepath)).values()].some(items => items.length > 1)
    const items = members.map(summarizeBook)
    const classes = []
    const assigned = new Set()
    // Exact byte equality first; content equivalence may connect several archive classes.
    const contentBuckets = groupBy(members.filter(item => item.inspection?.pageCount > 0), item => `${item.inspection.imageSignature}:${item.inspection.ancillarySignature}`)
    const exactBuckets = groupBy(members.filter(item => item.archiveSha256), item => item.archiveSha256)
    for (const subset of [...contentBuckets.values(), ...exactBuckets.values()]) {
      const peers = subset.filter(item => !assigned.has(String(item.raw.id)))
      if (peers.length < 2) continue
      const summaries = peers.map(summarizeBook)
      const exact = peers.every(item => item.archiveSha256 && item.archiveSha256 === peers[0].archiveSha256)
      const identityConsistent = summaries.every(item => item.sourceEvidence.status === 'known') && new Set(summaries.map(item => item.sourceEvidence.key)).size === 1
      const conflict = summaries.some(item => ['conflict', 'invalid', 'ambiguous'].includes(item.sourceEvidence.status))
      const peerIds = new Set(summaries.map(item => item.id))
      const scopeConflict = scopeConflicts.some(key => JSON.parse(key).every(id => peerIds.has(id)))
      const eligible = !pathConflict && !scopeConflict && peers.every(item => item.inspection?.pageCount > 0) && !summaries.some(item => item.uncoveredEntries.length || item.nestedBookIds.length) && (exact ? !conflict : identityConsistent)
      const suggestion = keeper(peers)
      classes.push({ id: stableId('equivalence', summaries.map(item => item.id).sort()), memberIds: summaries.map(item => item.id),
        kind: exact ? 'exact-archive' : identityConsistent ? 'strict-content' : 'content-review', eligible,
        suggestedKeepId: suggestion.id, keepReasons: suggestion.reasons })
      peers.forEach(item => assigned.add(String(item.raw.id)))
    }
    const allImages = members.every(item => item.inspection?.pageCount > 0)
    const orderedEqual = allImages && new Set(members.map(item => item.inspection.imageSignature)).size === 1
    const setEqual = allImages && new Set(members.map(item => item.inspection.imageMultisetSignature)).size === 1
    const allExact = members.every(item => item.archiveSha256 && item.archiveSha256 === members[0].archiveSha256)
    const allEquivalent = classes.length === 1 && classes[0].memberIds.length === members.length
    const kinds = new Set(reasons.map(reason => reason.code))
    let kind = pathConflict ? 'duplicate-database-path' : allExact ? 'exact-archive' : allEquivalent ? classes[0].kind : coverageRelations.length ? 'coverage-review' : orderedEqual ? 'content-review' : setEqual ? 'page-order-review' : kinds.has('source') || kinds.has('title-author') || kinds.has('publication-issue') || kinds.has('filename-id') ? 'version-review' : 'candidate-review'
    if (kinds.size === 1 && kinds.has('sample-hash')) kind = 'shared-hash-review'
    const eligible = classes.some(item => item.eligible)
    const potentialBytes = classes.filter(item => item.eligible).reduce((sum, group) => sum + items.filter(item => group.memberIds.includes(item.id) && item.id !== group.suggestedKeepId).reduce((bytes, item) => bytes + Number(item.transferBytes || 0), 0), 0)
    const evidenceRevision = stableId(DEDUPE_REPORT_RULES_VERSION, items.map(item => [item.id, item.filepath, item.archiveSha256, item.contentProof, item.folderFingerprint, item.size, item.mtimeMs, item.sourceEvidence.fingerprint, item.metadataFingerprint, item.nestedBookIds.slice().sort()]),
      relations.map(({ leftId, rightId, declaredRelation, contentRelation, matchedPages, leftPages, rightPages, sources }) =>
        [leftId, rightId, declaredRelation, contentRelation, matchedPages, leftPages, rightPages, sources]))
    groups.push({ id: stableId(component.reviewShape === 'whole-book' ? 'dedupe-group' : 'dedupe-pair', items.map(item => item.id).sort()),
      reviewShape: component.reviewShape, kind, eligible, actionable: true,
      severity: eligible ? 'medium' : 'high', items, equivalenceClasses: classes, reasons, relations, evidenceRevision,
      suggestedKeepId: classes.find(item => item.eligible)?.suggestedKeepId || keeper(members).id, potentialBytes,
      verification: { status: members.every(item => item.inspection) ? 'verified' : members.some(item => item.inspection || item.archiveSha256) ? 'partial' : 'unverified', checkedAt: new Date().toISOString(),
        missingEvidence: items.filter(item => !item.contentProof).map(item => item.id), fromCache: members.every(item => item.inspection?.fromCache) },
      conflicts: [...items.filter(item => item.sourceEvidence.status !== 'known').map(item => ({ field: 'source', bookId: item.id, status: item.sourceEvidence.status })),
        ...scopeConflicts.map(key => ({ field: 'chapter-coverage', memberIds: JSON.parse(key), status: 'metadata-conflict' }))],
      evidence: { sha256: allExact ? members[0].archiveSha256 : null, imageCount: orderedEqual ? members[0].inspection.pageCount : null, identities: items.map(item => item.sourceEvidence), reasons },
      reviewReason: eligible ? null : kind })
  }
  return { groups: groups.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.potentialBytes - a.potentialBytes || a.id.localeCompare(b.id)),
    coverageRelations: [...coverage.values()].sort((a, b) => a.leftId.localeCompare(b.leftId) || a.rightId.localeCompare(b.rightId)) }
}

const buildDuplicateGroups = (wrappedBooks, options) => buildDuplicateClassification(wrappedBooks, options).groups

module.exports = { normalizeTitle, parseBookSemantics, collectDuplicateCandidates, buildDuplicateGroups, buildDuplicateClassification }

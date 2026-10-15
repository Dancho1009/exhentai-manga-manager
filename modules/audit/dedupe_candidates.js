const { stableId, normalizePath, extractFilenameIdentity } = require('./utils.js')
const { summarizeBook, groupBy, scoreKeeper } = require('./dedupe_analyzer.js')
const { resolveBookIdentity } = require('./dedupe_identity.js')

const { DEDUPE_RULES_VERSION, normalizeTitle, parseBookSemantics } = require('./dedupe_title.js')

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
  // An inverted page index discovers a contained edition without an all-library
  // pairwise comparison. Counts retain repeated pages on both sides.
  const byPage = new Map()
  const overlaps = new Map()
  for (const book of wrappedBooks) {
    const counts = new Map()
    for (const page of book.inspection?.images || []) counts.set(page.sha256, (counts.get(page.sha256) || 0) + 1)
    for (const [digest, count] of counts) {
      for (const peer of byPage.get(digest) || []) {
        const ids = [String(book.raw.id), String(peer.book.raw.id)].sort()
        const key = JSON.stringify(ids)
        const pair = overlaps.get(key) || { items: [peer.book, book], count: 0 }
        pair.count += Math.min(count, peer.count)
        overlaps.set(key, pair)
      }
      if (!byPage.has(digest)) byPage.set(digest, [])
      byPage.get(digest).push({ book, count })
    }
  }
  for (const pair of overlaps.values()) {
    const [a, b] = pair.items.map(item => item.inspection.pageCount)
    if (a !== b && pair.count >= 2 && pair.count === Math.min(a, b)) buckets.set('coverage:' + pair.items.map(item => item.raw.id).sort().join(':'), { kind: 'page-coverage', items: pair.items })
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

const buildDuplicateGroups = wrappedBooks => {
  const candidates = collectDuplicateCandidates(wrappedBooks)
  const parent = new Map(wrappedBooks.map(item => [String(item.raw.id), String(item.raw.id)]))
  const find = id => { const p = parent.get(id); if (p !== id) parent.set(id, find(p)); return parent.get(id) }
  for (const bucket of candidates) {
    const anchor = find(String(bucket.items[0].raw.id))
    for (const member of bucket.items.slice(1)) parent.set(find(String(member.raw.id)), anchor)
  }
  const relatedIds = new Set(candidates.flatMap(bucket => bucket.items.map(item => String(item.raw.id))))
  const components = groupBy(wrappedBooks.filter(item => relatedIds.has(String(item.raw.id))), item => find(String(item.raw.id)))
  const groups = []
  for (const component of components.values()) {
    const members = [...component].sort((a, b) => String(a.raw.id).localeCompare(String(b.raw.id)))
    const memberIds = new Set(members.map(item => String(item.raw.id)))
    const reasons = candidates.filter(bucket => bucket.items.some(item => memberIds.has(String(item.raw.id))))
      .map(bucket => ({ code: bucket.kind, memberIds: bucket.items.map(item => String(item.raw.id)) }))
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
      const eligible = !pathConflict && peers.every(item => item.inspection?.pageCount > 0) && !summaries.some(item => item.uncoveredEntries.length || item.nestedBookIds.length) && (exact ? !conflict : identityConsistent)
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
    let kind = pathConflict ? 'duplicate-database-path' : allExact ? 'exact-archive' : allEquivalent ? classes[0].kind : orderedEqual ? 'content-review' : setEqual ? 'page-order-review' : kinds.has('source') || kinds.has('title-author') || kinds.has('publication-issue') || kinds.has('filename-id') ? 'version-review' : 'candidate-review'
    if (kinds.has('page-coverage') && !orderedEqual && !setEqual && !allEquivalent) kind = 'coverage-review'
    if (kinds.size === 1 && kinds.has('sample-hash')) kind = 'shared-hash-review'
    const eligible = classes.some(item => item.eligible)
    const potentialBytes = classes.filter(item => item.eligible).reduce((sum, group) => sum + items.filter(item => group.memberIds.includes(item.id) && item.id !== group.suggestedKeepId).reduce((bytes, item) => bytes + Number(item.transferBytes || 0), 0), 0)
    const evidenceRevision = stableId(DEDUPE_RULES_VERSION, items.map(item => [item.id, item.filepath, item.archiveSha256, item.contentProof, item.folderFingerprint, item.size, item.mtimeMs, item.sourceEvidence.fingerprint, item.metadataFingerprint, item.nestedBookIds.slice().sort()]))
    groups.push({ id: stableId('dedupe-group', items.map(item => item.id).sort()), kind, eligible, actionable: !pathConflict && kind !== 'shared-hash-review',
      severity: eligible ? 'medium' : 'high', items, equivalenceClasses: classes, reasons, evidenceRevision,
      suggestedKeepId: classes.find(item => item.eligible)?.suggestedKeepId || keeper(members).id, potentialBytes,
      verification: { status: members.every(item => item.inspection) ? 'verified' : members.some(item => item.inspection || item.archiveSha256) ? 'partial' : 'unverified', checkedAt: new Date().toISOString(),
        missingEvidence: items.filter(item => !item.contentProof).map(item => item.id), fromCache: members.every(item => item.inspection?.fromCache) },
      conflicts: items.filter(item => item.sourceEvidence.status !== 'known').map(item => ({ field: 'source', bookId: item.id, status: item.sourceEvidence.status })),
      evidence: { sha256: allExact ? members[0].archiveSha256 : null, imageCount: orderedEqual ? members[0].inspection.pageCount : null, identities: items.map(item => item.sourceEvidence), reasons },
      reviewReason: eligible ? null : kind })
  }
  return groups.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.potentialBytes - a.potentialBytes || a.id.localeCompare(b.id))
}

module.exports = { normalizeTitle, parseBookSemantics, collectDuplicateCandidates, buildDuplicateGroups }

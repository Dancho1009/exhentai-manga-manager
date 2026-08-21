const {
  buildGalleryUrl,
  getSiteFromUrl,
  isIdentityWebAvailable,
  hasUncertainSiteStatus
} = require('../ehentai.js')

const FINAL_UNAVAILABLE_STATUSES = new Set([
  'copyright',
  'generic-unavailable',
  'gallery-not-found',
  'geo-blocked'
])

const isConclusiveSiteUnavailable = status => FINAL_UNAVAILABLE_STATUSES.has(status)

const normalizeVersionIdentity = (gid, token) => {
  const identity = { gid: String(gid || ''), token: String(token || '').toLowerCase() }
  return /^\d+$/.test(identity.gid) && /^[0-9a-z]+$/.test(identity.token) ? identity : null
}

const metadataIdentity = (metadata, fallback) => normalizeVersionIdentity(metadata?.gid || fallback?.gid, metadata?.token || fallback?.token)
const metadataPointer = (metadata, name) => normalizeVersionIdentity(metadata?.[`${name}_gid`], metadata?.[`${name}_key`])
const identityKey = identity => identity ? `${identity.gid}:${identity.token}` : null
const sameIdentity = (left, right) => Boolean(left && right && identityKey(left) === identityKey(right))

const getGalleryVersionRelation = ({ currentMetadata, candidateMetadata, currentIdentity, candidateIdentity }) => {
  const current = metadataIdentity(currentMetadata, currentIdentity)
  const candidate = metadataIdentity(candidateMetadata, candidateIdentity)
  if (!current || !candidate) return { status: 'unknown', sameChain: false, latestIdentity: null, chainGids: [] }
  if (sameIdentity(current, candidate)) {
    return { status: 'same-version', sameChain: true, latestIdentity: current, chainGids: [current.gid] }
  }

  const currentPointers = {
    parent: metadataPointer(currentMetadata, 'parent'),
    current: metadataPointer(currentMetadata, 'current'),
    first: metadataPointer(currentMetadata, 'first')
  }
  const candidatePointers = {
    parent: metadataPointer(candidateMetadata, 'parent'),
    current: metadataPointer(candidateMetadata, 'current'),
    first: metadataPointer(candidateMetadata, 'first')
  }
  const directlyLinked = Object.values(currentPointers).some(pointer => sameIdentity(pointer, candidate)) ||
    Object.values(candidatePointers).some(pointer => sameIdentity(pointer, current))
  const sameFirst = sameIdentity(currentPointers.first, candidatePointers.first)
  if (!directlyLinked && !sameFirst) {
    return { status: 'unrelated', sameChain: false, latestIdentity: null, chainGids: [current.gid, candidate.gid] }
  }

  const chain = [current, candidate, ...Object.values(currentPointers), ...Object.values(candidatePointers)].filter(Boolean)
  const chainGids = [...new Set(chain.map(identity => identity.gid))]
  const latestPointers = [currentPointers.current, candidatePointers.current]
    .filter(pointer => pointer && !sameIdentity(pointer, currentPointers.first) && !sameIdentity(pointer, candidatePointers.first))
  const latestKeys = [...new Set(latestPointers.map(identityKey))]
  let latestIdentity = latestKeys.length === 1 ? latestPointers[0] : null
  if (!latestIdentity && latestKeys.length === 0) {
    if (sameIdentity(currentPointers.parent, candidate)) latestIdentity = current
    else if (sameIdentity(candidatePointers.parent, current)) latestIdentity = candidate
  }

  const status = sameIdentity(latestIdentity, current)
    ? 'current-latest'
    : sameIdentity(latestIdentity, candidate)
      ? 'candidate-latest'
      : latestIdentity
        ? 'latest-other'
        : 'same-chain-latest-unknown'
  return { status, sameChain: true, latestIdentity, chainGids }
}

const isVersionChainNoise = (anomaly, bookId, relation) => {
  if (!relation?.sameChain || String(anomaly?.bookId) !== String(bookId)) return false
  if (['ehviewer-url-conflict', 'unverified-page-mismatch'].includes(anomaly.type)) return true
  return anomaly.type === 'filename-url-id-conflict' && relation.chainGids.includes(String(anomaly.evidence?.filenameId || ''))
}

const isConclusiveUnavailable = availability => {
  const statuses = ['ehentai', 'exhentai'].map(site => availability?.sites?.[site]?.status)
  return statuses.every(status => FINAL_UNAVAILABLE_STATUSES.has(status))
}

const summarizeAvailability = availability => {
  const statuses = Object.values(availability?.sites || {}).map(site => site.status)
  if (statuses.includes('available')) return 'available'
  if (hasUncertainSiteStatus(availability)) return 'uncertain'
  if (statuses.includes('copyright')) return 'copyright'
  return isConclusiveUnavailable(availability) ? 'unavailable' : 'uncertain'
}

const pickAvailableUrl = (availability, preferredSite = 'exhentai') => {
  if (!availability) return null
  if (availability.sites?.[preferredSite]?.status === 'available') {
    return buildGalleryUrl(preferredSite, availability.identity.gid, availability.identity.token)
  }
  const otherSite = preferredSite === 'exhentai' ? 'ehentai' : 'exhentai'
  if (availability.sites?.[otherSite]?.status === 'available') {
    return buildGalleryUrl(otherSite, availability.identity.gid, availability.identity.token)
  }
  return null
}

const getSameIdentityFallbackUrl = (availability, currentUrl) => {
  if (!availability || !currentUrl) return null
  const currentSite = getSiteFromUrl(currentUrl)
  if (!currentSite || !isConclusiveSiteUnavailable(availability.sites?.[currentSite]?.status)) return null
  const otherSite = currentSite === 'exhentai' ? 'ehentai' : 'exhentai'
  return availability.sites?.[otherSite]?.status === 'available'
    ? buildGalleryUrl(otherSite, availability.identity.gid, availability.identity.token)
    : null
}

const decideIdentityConflict = ({ currentAvailability, candidateAvailability, currentIdentityPresent = true }) => {
  const currentAvailable = isIdentityWebAvailable(currentAvailability)
  const candidateAvailable = isIdentityWebAvailable(candidateAvailability)
  const currentUncertain = currentIdentityPresent && hasUncertainSiteStatus(currentAvailability)
  const candidateUncertain = hasUncertainSiteStatus(candidateAvailability)

  if (currentAvailable && candidateAvailable) {
    return { outcome: 'manual-review', actionable: false, reason: 'both-identities-available' }
  }
  if (currentAvailable) {
    return candidateUncertain
      ? { outcome: 'no-action', actionable: false, reason: 'candidate-availability-uncertain' }
      : { outcome: 'keep-current', actionable: false, reason: 'current-available-candidate-unavailable' }
  }
  if (currentUncertain) {
    return { outcome: 'no-action', actionable: false, reason: 'current-availability-uncertain' }
  }
  const currentUnavailable = currentIdentityPresent
    ? isConclusiveUnavailable(currentAvailability)
    : true
  if (currentUnavailable && candidateAvailable) {
    return { outcome: 'allow-candidate', actionable: true, reason: currentIdentityPresent ? 'candidate-only-available' : 'missing-current-source' }
  }
  if (candidateUncertain) {
    return { outcome: 'no-action', actionable: false, reason: 'candidate-availability-uncertain' }
  }
  return { outcome: 'no-action', actionable: false, reason: 'no-confirmed-available-candidate' }
}

const buildSourceRecoveryAction = ({
  bookId,
  filepath,
  expectedSize,
  expectedMtimeMs,
  currentUrl,
  candidateIdentity,
  candidateAvailability,
  candidateGdata
}) => {
  if (currentUrl || !candidateIdentity || !isIdentityWebAvailable(candidateAvailability) || candidateGdata?.status !== 'available') return null
  const newUrl = pickAvailableUrl(candidateAvailability, 'exhentai')
  if (!newUrl) return null
  return {
    type: 'repair-url',
    repairKind: 'source-recovery',
    bookId,
    filepath,
    expectedSize,
    expectedMtimeMs,
    currentUrl: null,
    newUrl,
    availabilityProof: {
      checkedAt: Date.now(),
      current: null,
      candidate: candidateAvailability,
      candidateGdataStatus: candidateGdata.status
    }
  }
}

const buildEhviewerSyncAction = ({
  bookId,
  filepath,
  bookType,
  expectedSize,
  expectedMtimeMs,
  currentUrl,
  currentIdentity,
  currentTitle,
  entryPath,
  recoverySupport,
  currentAvailability,
  candidateAvailability,
  currentGdata
}) => {
  if (!recoverySupport?.supported || !currentIdentity || !currentTitle || currentGdata?.status !== 'available') return null
  return {
    type: 'repair-ehviewer',
    repairKind: 'ehviewer-sync-to-current-metadata',
    bookId,
    filepath,
    bookType,
    expectedSize,
    expectedMtimeMs,
    currentUrl,
    expectedTitle: currentTitle,
    entryPath: entryPath || '.ehviewer',
    identity: currentIdentity,
    availabilityProof: {
      checkedAt: Date.now(),
      current: currentAvailability,
      candidate: candidateAvailability,
      currentGdataStatus: currentGdata.status
    }
  }
}

module.exports = {
  FINAL_UNAVAILABLE_STATUSES,
  isConclusiveSiteUnavailable,
  getGalleryVersionRelation,
  isVersionChainNoise,
  isConclusiveUnavailable,
  summarizeAvailability,
  pickAvailableUrl,
  getSameIdentityFallbackUrl,
  decideIdentityConflict,
  buildSourceRecoveryAction,
  buildEhviewerSyncAction
}

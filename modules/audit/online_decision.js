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
  if (!currentSite || availability.sites?.[currentSite]?.status === 'available') return null
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

module.exports = {
  FINAL_UNAVAILABLE_STATUSES,
  isConclusiveUnavailable,
  summarizeAvailability,
  pickAvailableUrl,
  getSameIdentityFallbackUrl,
  decideIdentityConflict
}

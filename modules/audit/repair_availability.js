const { checkGallerySites, extractGalleryIdentity, getSiteFromUrl, isIdentityWebAvailable } = require('../ehentai.js')

const TRANSIENT_STATUSES = new Set(['network-error', 'service-unavailable', 'unknown'])
const STATUS_ERRORS = {
  'network-error': 'REPAIR_CANDIDATE_NETWORK_ERROR',
  'service-unavailable': 'REPAIR_CANDIDATE_SERVICE_UNAVAILABLE',
  unknown: 'REPAIR_CANDIDATE_STATUS_UNKNOWN',
  unchecked: 'REPAIR_CANDIDATE_STATUS_UNKNOWN',
  'auth-required': 'REPAIR_CANDIDATE_AUTH_REQUIRED',
  'ip-banned': 'REPAIR_CANDIDATE_IP_BANNED',
  'geo-blocked': 'REPAIR_CANDIDATE_GEO_BLOCKED',
  'gallery-not-found': 'REPAIR_CANDIDATE_NOT_FOUND',
  copyright: 'REPAIR_CANDIDATE_COPYRIGHT'
}

const describeAvailabilityFailure = (availability, checkedSites = ['ehentai', 'exhentai']) => {
  const sites = Object.fromEntries(['ehentai', 'exhentai'].map(site => {
    const value = availability?.sites?.[site] || {}
    return [site, Object.fromEntries(['status', 'httpStatus', 'claimant', 'region', 'finalUrl', 'checkedAt', 'evidence', 'error']
      .filter(key => value[key] !== undefined).map(key => [key, value[key]]))]
  }))
  const statuses = checkedSites.map(site => sites[site]?.status || 'unchecked')
  const uncertain = statuses.find(status => TRANSIENT_STATUSES.has(status) || ['unchecked', 'auth-required', 'ip-banned'].includes(status))
  const status = uncertain || (statuses.every(value => value === 'copyright') ? 'copyright' :
    statuses.every(value => value === 'gallery-not-found') ? 'gallery-not-found' :
      statuses.includes('geo-blocked') ? 'geo-blocked' : 'generic-unavailable')
  return { valid: false, error: STATUS_ERRORS[status] || 'REPAIR_CANDIDATE_UNAVAILABLE', detail: { sites } }
}

const checkRepairCandidate = async ({ url, setting, cache, checkSites = checkGallerySites, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) => {
  const identity = extractGalleryIdentity(url)
  if (!identity) return { valid: false, error: 'INVALID_REPAIR_CANDIDATE_URL' }
  const request = { ...identity, preferredSite: getSiteFromUrl(url) || 'exhentai', strategy: 'both', force: true, setting, cache }
  let candidate = await checkSites(request)
  if (!isIdentityWebAvailable(candidate) && Object.values(candidate.sites || {}).some(site => TRANSIENT_STATUSES.has(site.status))) {
    await wait(1000)
    candidate = await checkSites(request)
  }
  return isIdentityWebAvailable(candidate) ? { valid: true, candidate } : describeAvailabilityFailure(candidate)
}

module.exports = { checkRepairCandidate, describeAvailabilityFailure }

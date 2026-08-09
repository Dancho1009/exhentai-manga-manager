const fetch = require('node-fetch')
const { HttpsProxyAgent } = require('https-proxy-agent')

const SITE_HOSTS = {
  ehentai: 'e-hentai.org',
  exhentai: 'exhentai.org'
}
const SITE_ORDER = ['ehentai', 'exhentai']
const SERVICE_HTTP_STATUS = new Set([429, 502, 503, 504])
const AVAILABLE_STATUSES = new Set(['available'])

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const requestQueues = new Map()
const lastRequestAt = new Map()

const normalizePositiveInteger = (value, fallback = 0) => {
  const number = Number.parseInt(value, 10)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

const decodeHtmlEntities = value => String(value || '')
  .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')

const htmlToNormalizedText = html => decodeHtmlEntities(String(html || '')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(?:p|div|h\d|li|title)>/gi, '\n')
  .replace(/<[^>]+>/g, ' '))
  .replace(/\s+/g, ' ')
  .trim()

const extractGalleryIdentity = value => {
  const match = String(value || '').match(/(?:e-hentai\.org|exhentai\.org)\/g\/(\d+)\/([0-9a-z]+)/i)
  if (!match) return null
  return { gid: match[1], token: match[2].toLowerCase() }
}

const getSiteFromUrl = value => {
  try {
    const hostname = new URL(String(value || '')).hostname.toLowerCase()
    return hostname === SITE_HOSTS.exhentai ? 'exhentai' : hostname === SITE_HOSTS.ehentai ? 'ehentai' : null
  } catch {
    return null
  }
}

const buildGalleryUrl = (site, gid, token) => `https://${SITE_HOSTS[site]}/g/${gid}/${token}/`

const uncheckedSite = site => ({
  site,
  status: 'unchecked',
  httpStatus: null,
  claimant: null,
  region: null,
  finalUrl: null,
  checkedAt: null,
  evidence: 'not-requested',
  cached: false
})

const classifyGalleryHtml = ({ html, httpStatus, requestedUrl, finalUrl }) => {
  const text = htmlToNormalizedText(html)
  const checkedAt = Date.now()
  const copyright = text.match(/This gallery is unavailable due to a copyright claim by\s+(.+?)\.\s+Sorry about that\./i)
  if (copyright) return { status: 'copyright', claimant: copyright[1].trim(), region: null, evidence: 'copyright-template', checkedAt }
  if (/This gallery has been removed or is unavailable\.?/i.test(text)) {
    return { status: 'generic-unavailable', claimant: null, region: null, evidence: 'generic-unavailable-template', checkedAt }
  }
  if (/Gallery not found\.\s*If you just added this gallery/i.test(text)) {
    return { status: 'gallery-not-found', claimant: null, region: null, evidence: 'gallery-not-found-template', checkedAt }
  }
  const geoBlocked = text.match(/This content is not available in\s+(.+?)\./i)
  if (geoBlocked) return { status: 'geo-blocked', claimant: null, region: geoBlocked[1].trim(), evidence: 'geo-block-template', checkedAt }
  if (/Your IP address has been/i.test(text)) {
    return { status: 'ip-banned', claimant: null, region: null, evidence: 'ip-banned-template', checkedAt }
  }
  if (/sad panda|You must be logged on|please log in/i.test(text)) {
    return { status: 'auth-required', claimant: null, region: null, evidence: 'auth-template', checkedAt }
  }
  if (/id=["'](?:gn|gd1)["']/i.test(String(html || ''))) {
    return { status: 'available', claimant: null, region: null, evidence: 'gallery-dom', checkedAt }
  }
  if (SERVICE_HTTP_STATUS.has(Number(httpStatus))) {
    return { status: 'service-unavailable', claimant: null, region: null, evidence: `http-${httpStatus}`, checkedAt }
  }
  const requestedIdentity = extractGalleryIdentity(requestedUrl)
  const finalIdentity = extractGalleryIdentity(finalUrl)
  if (requestedIdentity && (!finalIdentity || requestedIdentity.gid !== finalIdentity.gid || requestedIdentity.token !== finalIdentity.token)) {
    return { status: 'auth-required', claimant: null, region: null, evidence: 'redirected-away', checkedAt }
  }
  return { status: 'unknown', claimant: null, region: null, evidence: `unclassified-http-${httpStatus || 0}`, checkedAt }
}

const buildCookie = setting => [
  ['igneous', setting?.igneous],
  ['ipb_pass_hash', setting?.ipb_pass_hash],
  ['ipb_member_id', setting?.ipb_member_id],
  ['star', setting?.star]
].filter(([, value]) => value !== undefined && value !== null && value !== '')
  .map(([key, value]) => `${key}=${value}`)
  .join(';')

const getRequestQueueKey = url => {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return 'default'
  }
}

const enqueueRequest = (queueKey, task, gap) => {
  const run = async () => {
    const wait = Math.max(0, (lastRequestAt.get(queueKey) || 0) + gap - Date.now())
    if (wait) await sleep(wait)
    try {
      return await task()
    } finally {
      lastRequestAt.set(queueKey, Date.now())
    }
  }
  const queue = requestQueues.get(queueKey) || Promise.resolve()
  const result = queue.then(run, run)
  requestQueues.set(queueKey, result.catch(() => {}))
  return result
}

const retryDelay = response => {
  const value = response?.headers?.get?.('retry-after')
  if (!value) return 30000
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 30000
}

const requestText = async ({ url, setting, method = 'GET', body, headers = {}, fetchImpl = fetch, retry = true }) => {
  const gap = normalizePositiveInteger(setting?.requireGap, 0)
  const queueKey = getRequestQueueKey(url)
  const execute = async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30000)
    try {
      const options = {
        method,
        body,
        headers,
        signal: controller.signal,
        redirect: 'follow'
      }
      if (setting?.proxy) options.agent = new HttpsProxyAgent(setting.proxy)
      return await fetchImpl(url, options)
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    let response = await enqueueRequest(queueKey, execute, gap)
    if (retry && SERVICE_HTTP_STATUS.has(response.status)) {
      await sleep(retryDelay(response))
      response = await enqueueRequest(queueKey, execute, gap)
    }
    return {
      body: await response.text(),
      httpStatus: response.status,
      finalUrl: response.url || url,
      headers: response.headers
    }
  } catch (error) {
    return { error, body: '', httpStatus: null, finalUrl: url, headers: null }
  }
}

const checkGallerySite = async ({ site, gid, token, setting, force = false, cache, fetchImpl }) => {
  if (!force && cache) {
    const cached = await cache.get({ site, gid, token })
    if (cached) return cached
  }
  const requestedUrl = buildGalleryUrl(site, gid, token)
  const response = await requestText({
    url: requestedUrl,
    setting,
    headers: { Cookie: buildCookie(setting) },
    fetchImpl
  })
  const classified = response.error
    ? { status: 'network-error', claimant: null, region: null, evidence: response.error.name === 'AbortError' ? 'request-timeout' : 'request-error', checkedAt: Date.now() }
    : classifyGalleryHtml({ html: response.body, httpStatus: response.httpStatus, requestedUrl, finalUrl: response.finalUrl })
  const result = {
    site,
    ...classified,
    httpStatus: response.httpStatus,
    finalUrl: response.finalUrl,
    cached: false
  }
  if (cache) await cache.set({ site, gid, token, ...result })
  return result
}

const checkGallerySites = async ({ gid, token, preferredSite = 'exhentai', strategy = 'fallback', force = false, setting = {}, cache, fetchImpl }) => {
  gid = String(gid || '')
  token = String(token || '').toLowerCase()
  if (!/^\d+$/.test(gid) || !/^[0-9a-z]+$/.test(token)) throw new Error('INVALID_EHENTAI_IDENTITY')
  preferredSite = SITE_ORDER.includes(preferredSite) ? preferredSite : 'exhentai'
  const otherSite = preferredSite === 'exhentai' ? 'ehentai' : 'exhentai'
  const sites = { ehentai: uncheckedSite('ehentai'), exhentai: uncheckedSite('exhentai') }
  if (strategy === 'both') {
    const [preferredResult, otherResult] = await Promise.all([
      checkGallerySite({ site: preferredSite, gid, token, setting, force, cache, fetchImpl }),
      checkGallerySite({ site: otherSite, gid, token, setting, force, cache, fetchImpl })
    ])
    sites[preferredSite] = preferredResult
    sites[otherSite] = otherResult
  } else {
    sites[preferredSite] = await checkGallerySite({ site: preferredSite, gid, token, setting, force, cache, fetchImpl })
  }
  if (strategy !== 'both' && !AVAILABLE_STATUSES.has(sites[preferredSite].status)) {
    sites[otherSite] = await checkGallerySite({ site: otherSite, gid, token, setting, force, cache, fetchImpl })
  }
  const availableSite = sites[preferredSite].status === 'available'
    ? preferredSite
    : sites[otherSite].status === 'available' ? otherSite : null
  const selectedSite = availableSite || preferredSite
  return {
    identity: { gid, token },
    sites,
    gdata: { status: 'unchecked', metadata: null },
    preferredSite: selectedSite,
    preferredUrl: buildGalleryUrl(selectedSite, gid, token)
  }
}

const getGdata = async ({ gid, token, setting, fetchImpl }) => {
  const response = await requestText({
    url: 'https://api.e-hentai.org/api.php',
    method: 'POST',
    body: JSON.stringify({ method: 'gdata', gidlist: [[Number(gid), token]], namespace: 1 }),
    headers: { 'Content-Type': 'application/json' },
    setting,
    fetchImpl
  })
  if (response.error) return { status: 'network-error', metadata: null, error: response.error.message }
  if (SERVICE_HTTP_STATUS.has(Number(response.httpStatus))) return { status: 'service-unavailable', metadata: null }
  try {
    const metadata = JSON.parse(response.body)?.gmetadata?.[0]
    if (!metadata || metadata.error) {
      return {
        status: /Gallery not found/i.test(metadata?.error || response.body) ? 'gallery-not-found' : 'unknown',
        metadata: null,
        error: metadata?.error || 'INVALID_GDATA_RESPONSE'
      }
    }
    return { status: 'available', metadata }
  } catch (error) {
    return { status: 'unknown', metadata: null, error: error.message }
  }
}

const getGalleryPage = async ({ url, setting = {}, fetchImpl }) => {
  const identity = extractGalleryIdentity(url)
  const site = getSiteFromUrl(url)
  if (!identity || !site) throw new Error('INVALID_EHENTAI_URL')
  const response = await requestText({
    url: buildGalleryUrl(site, identity.gid, identity.token),
    setting,
    headers: { Cookie: buildCookie(setting) },
    fetchImpl
  })
  if (response.error) throw response.error
  const classified = classifyGalleryHtml({
    html: response.body,
    httpStatus: response.httpStatus,
    requestedUrl: url,
    finalUrl: response.finalUrl
  })
  return {
    html: response.body,
    site,
    status: classified.status,
    claimant: classified.claimant,
    region: classified.region,
    httpStatus: response.httpStatus,
    finalUrl: response.finalUrl
  }
}

const getGalleryMetadata = async ({ url, gid, token, preferredSite, forceAvailability = false, setting = {}, cache, fetchImpl }) => {
  const identity = gid && token ? { gid: String(gid), token: String(token) } : extractGalleryIdentity(url)
  if (!identity) throw new Error('INVALID_EHENTAI_URL')
  const requestedSite = preferredSite || getSiteFromUrl(url) || 'exhentai'
  const availability = await checkGallerySites({
    ...identity,
    preferredSite: requestedSite,
    strategy: 'fallback',
    force: forceAvailability,
    setting,
    cache,
    fetchImpl
  })
  const gdata = await getGdata({ ...identity, setting, fetchImpl })
  return { ...availability, gdata }
}

const toManagerMetadata = metadata => {
  const tags = {}
  for (const rawTag of metadata?.tags || []) {
    const separator = String(rawTag).indexOf(':')
    const namespace = separator > 0 ? String(rawTag).slice(0, separator) : 'misc'
    const tag = separator > 0 ? String(rawTag).slice(separator + 1) : String(rawTag)
    if (!tags[namespace]) tags[namespace] = []
    tags[namespace].push(tag)
  }
  return {
    tags,
    title: decodeHtmlEntities(metadata?.title || ''),
    title_jpn: decodeHtmlEntities(metadata?.title_jpn || ''),
    filecount: Number(metadata?.filecount || 0),
    rating: Number(metadata?.rating || 0),
    posted: Number(metadata?.posted || 0),
    filesize: Number(metadata?.filesize || 0),
    category: metadata?.category || '',
    status: 'tagged'
  }
}

const isIdentityWebAvailable = result => SITE_ORDER.some(site => result?.sites?.[site]?.status === 'available')
const hasUncertainSiteStatus = result => SITE_ORDER.some(site => ['network-error', 'unknown', 'unchecked', 'service-unavailable', 'auth-required', 'ip-banned'].includes(result?.sites?.[site]?.status))

module.exports = {
  SITE_HOSTS,
  SITE_ORDER,
  htmlToNormalizedText,
  extractGalleryIdentity,
  getSiteFromUrl,
  buildGalleryUrl,
  buildCookie,
  classifyGalleryHtml,
  checkGallerySite,
  checkGallerySites,
  getGalleryPage,
  getGalleryMetadata,
  getGdata,
  toManagerMetadata,
  isIdentityWebAvailable,
  hasUncertainSiteStatus
}

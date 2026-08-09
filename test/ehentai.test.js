const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  classifyGalleryHtml,
  checkGallerySites,
  getGalleryMetadata
} = require('../modules/ehentai.js')
const { EhentaiAvailabilityCache } = require('../modules/ehentai_availability_cache.js')
const {
  decideIdentityConflict,
  getSameIdentityFallbackUrl,
  summarizeAvailability
} = require('../modules/audit/online_decision.js')

const response = (body, status, url) => ({
  status,
  url,
  headers: { get: () => null },
  text: async () => body
})

const availability = (ehentai, exhentai, gid = '1', token = 'token') => ({
  identity: { gid, token },
  sites: {
    ehentai: { status: ehentai },
    exhentai: { status: exhentai }
  }
})

test('classifier distinguishes copyright templates and preserves dotted claimant names', () => {
  const result = classifyGalleryHtml({
    html: '<html><body>This gallery is unavailable due to a copyright claim by JAST U.S.A. Sorry about that.</body></html>',
    httpStatus: 404,
    requestedUrl: 'https://e-hentai.org/g/1/token/',
    finalUrl: 'https://e-hentai.org/g/1/token/'
  })
  assert.equal(result.status, 'copyright')
  assert.equal(result.claimant, 'JAST U.S.A')
})

test('classifier keeps unavailable, not-found, geo-blocked, and available states separate', () => {
  const base = { requestedUrl: 'https://e-hentai.org/g/1/token/', finalUrl: 'https://e-hentai.org/g/1/token/' }
  assert.equal(classifyGalleryHtml({ ...base, html: 'This gallery has been removed or is unavailable.', httpStatus: 404 }).status, 'generic-unavailable')
  assert.equal(classifyGalleryHtml({ ...base, html: 'Gallery not found. If you just added this gallery, you may have to wait a short while before it becomes available.', httpStatus: 200 }).status, 'gallery-not-found')
  const geo = classifyGalleryHtml({ ...base, html: 'This content is not available in the United Kingdom.', httpStatus: 451 })
  assert.equal(geo.status, 'geo-blocked')
  assert.equal(geo.region, 'the United Kingdom')
  assert.equal(classifyGalleryHtml({ ...base, html: '<h1 id="gn">Gallery title</h1><div id="gd1"></div>', httpStatus: 200 }).status, 'available')
})

test('classifier separates authentication, IP bans, service errors, redirects, and unknown pages', () => {
  const requestedUrl = 'https://exhentai.org/g/1/token/'
  const base = { requestedUrl, finalUrl: requestedUrl }
  assert.equal(classifyGalleryHtml({ ...base, html: '<p>You must be logged on to access this page.</p>', httpStatus: 200 }).status, 'auth-required')
  assert.equal(classifyGalleryHtml({ ...base, html: '<p>Your IP address has been temporarily banned.</p>', httpStatus: 200 }).status, 'ip-banned')
  assert.equal(classifyGalleryHtml({ ...base, html: 'upstream unavailable', httpStatus: 503 }).status, 'service-unavailable')
  assert.equal(classifyGalleryHtml({ ...base, html: '<html>redirected</html>', httpStatus: 200, finalUrl: 'https://exhentai.org/' }).status, 'auth-required')
  assert.equal(classifyGalleryHtml({ ...base, html: '<html>unexpected response</html>', httpStatus: 200 }).status, 'unknown')
})

test('request failures and timeouts remain network errors instead of removal states', async () => {
  const requestError = await checkGallerySites({
    gid: '1', token: 'token', preferredSite: 'exhentai', strategy: 'both', setting: {},
    fetchImpl: async () => { throw new Error('offline') }
  })
  assert.equal(requestError.sites.exhentai.status, 'network-error')
  assert.equal(requestError.sites.ehentai.status, 'network-error')

  const abort = new Error('timed out')
  abort.name = 'AbortError'
  const timeout = await checkGallerySites({
    gid: '2', token: 'token', preferredSite: 'exhentai', setting: {},
    fetchImpl: async () => { throw abort }
  })
  assert.equal(timeout.sites.exhentai.status, 'network-error')
  assert.equal(timeout.sites.exhentai.evidence, 'request-timeout')
})

test('dual-site checks run in parallel while each host keeps an independent request queue', async () => {
  let activeRequests = 0
  let maxActiveRequests = 0
  const fetchImpl = async url => {
    activeRequests += 1
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests)
    await new Promise(resolve => setTimeout(resolve, 20))
    activeRequests -= 1
    return response('<h1 id="gn">Available</h1><div id="gd1"></div>', 200, url)
  }

  const result = await checkGallerySites({
    gid: '3', token: 'token', preferredSite: 'exhentai', strategy: 'both', setting: {}, fetchImpl
  })

  assert.equal(maxActiveRequests, 2)
  assert.equal(result.sites.ehentai.status, 'available')
  assert.equal(result.sites.exhentai.status, 'available')
})

test('fallback strategy preserves per-site state and switches to the available counterpart', async () => {
  const fetchImpl = async url => url.includes('e-hentai.org')
    ? response('This gallery has been removed or is unavailable.', 404, url)
    : response('<h1 id="gn">Available</h1><div id="gd1"></div>', 200, url)
  const result = await checkGallerySites({
    gid: '2212965', token: '551e1ccfb1', preferredSite: 'ehentai', setting: {}, fetchImpl
  })
  assert.equal(result.sites.ehentai.status, 'generic-unavailable')
  assert.equal(result.sites.exhentai.status, 'available')
  assert.equal(result.preferredSite, 'exhentai')
  assert.equal(result.preferredUrl, 'https://exhentai.org/g/2212965/551e1ccfb1/')
})

test('copyrighted pages can still return usable gdata metadata', async () => {
  const copyright = 'This gallery is unavailable due to a copyright claim by Irodori Comics. Sorry about that.'
  const fetchImpl = async (url, options) => {
    if (url.includes('api.e-hentai.org')) {
      assert.equal(options.method, 'POST')
      return response(JSON.stringify({ gmetadata: [{ gid: 3954416, token: '565a588fe2', title: 'Archived metadata', tags: [] }] }), 200, url)
    }
    return response(copyright, 404, url)
  }
  const result = await getGalleryMetadata({
    url: 'https://exhentai.org/g/3954416/565a588fe2/', setting: {}, fetchImpl
  })
  assert.equal(result.sites.exhentai.status, 'copyright')
  assert.equal(result.sites.ehentai.status, 'copyright')
  assert.equal(result.gdata.status, 'available')
  assert.equal(result.gdata.metadata.title, 'Archived metadata')
})

test('identity conflict matrix only allows a conclusively available candidate', () => {
  const available = availability('available', 'generic-unavailable')
  const unavailable = availability('copyright', 'generic-unavailable')
  const uncertain = availability('network-error', 'generic-unavailable')

  assert.equal(decideIdentityConflict({ currentAvailability: available, candidateAvailability: unavailable }).outcome, 'keep-current')
  assert.equal(decideIdentityConflict({ currentAvailability: unavailable, candidateAvailability: available }).outcome, 'allow-candidate')
  assert.equal(decideIdentityConflict({ currentAvailability: available, candidateAvailability: available }).outcome, 'manual-review')
  assert.equal(decideIdentityConflict({ currentAvailability: unavailable, candidateAvailability: unavailable }).outcome, 'no-action')
  assert.equal(decideIdentityConflict({ currentAvailability: uncertain, candidateAvailability: available }).outcome, 'no-action')
  assert.equal(decideIdentityConflict({ currentAvailability: unavailable, candidateAvailability: availability('available', 'network-error') }).outcome, 'allow-candidate')
  assert.equal(decideIdentityConflict({ currentAvailability: null, candidateAvailability: available, currentIdentityPresent: false }).outcome, 'allow-candidate')
})

test('same identity changes domain only when the current site is unavailable', () => {
  const result = availability('available', 'generic-unavailable', '2212965', '551e1ccfb1')
  assert.equal(
    getSameIdentityFallbackUrl(result, 'https://exhentai.org/g/2212965/551e1ccfb1/'),
    'https://e-hentai.org/g/2212965/551e1ccfb1/'
  )
  assert.equal(getSameIdentityFallbackUrl(result, 'https://e-hentai.org/g/2212965/551e1ccfb1/'), null)
  assert.equal(summarizeAvailability(availability('copyright', 'network-error')), 'uncertain')
})

test('availability cache stores conclusive states without response bodies', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'eh-availability-cache-'))
  const cache = await EhentaiAvailabilityCache.open(root)
  t.after(async () => {
    await cache.close()
    await fs.promises.rm(root, { recursive: true, force: true })
  })
  await cache.set({
    site: 'exhentai', gid: '1', token: 'token', status: 'copyright', httpStatus: 404,
    claimant: 'FAKKU', finalUrl: 'https://exhentai.org/g/1/token/', checkedAt: Date.now(), evidence: 'copyright-template'
  })
  const cached = await cache.get({ site: 'exhentai', gid: '1', token: 'token' })
  assert.equal(cached.status, 'copyright')
  assert.equal(cached.claimant, 'FAKKU')
  assert.equal(Object.hasOwn(cached, 'html'), false)
})

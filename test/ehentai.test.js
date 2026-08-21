const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  classifyGalleryHtml,
  checkGallerySites,
  getGalleryMetadata,
  getGdataBatch
} = require('../modules/ehentai.js')
const { EhentaiAvailabilityCache } = require('../modules/ehentai_availability_cache.js')
const {
  decideIdentityConflict,
  buildSourceRecoveryAction,
  buildEhviewerSyncAction,
  getSameIdentityFallbackUrl,
  summarizeAvailability,
  getGalleryVersionRelation,
  isVersionChainNoise
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

test('classifier does not treat gallery comments mentioning sad panda as authentication', () => {
  const result = classifyGalleryHtml({
    html: '<div id="gn">Replaced gallery</div><div id="cdiv">I directly got sad panda from this one.</div>',
    httpStatus: 200,
    requestedUrl: 'https://exhentai.org/g/1/abc/',
    finalUrl: 'https://exhentai.org/g/1/abc/'
  })
  assert.equal(result.status, 'available')
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

test('gdata batches up to 25 identities per API request and preserves result order', async () => {
  const identities = Array.from({ length: 30 }, (_, index) => ({ gid: String(1000 + index), token: `token${index}` }))
  const batchSizes = []
  const results = await getGdataBatch({
    identities,
    setting: {},
    fetchImpl: async (url, options) => {
      const payload = JSON.parse(options.body)
      batchSizes.push(payload.gidlist.length)
      return response(JSON.stringify({
        gmetadata: payload.gidlist.map(([gid]) => ({ gid, title: `Gallery ${gid}`, tags: [] }))
      }), 200, url)
    }
  })
  assert.deepEqual(batchSizes, [25, 5])
  assert.equal(results.size, 30)
  assert.equal(results.get('1000:token0').metadata.title, 'Gallery 1000')
  assert.equal(results.get('1029:token29').metadata.title, 'Gallery 1029')
})

test('gallery version relation distinguishes current latest, candidate latest, and unrelated identities', () => {
  const oldIdentity = { gid: '4050179', token: '09c3a040d0' }
  const latestIdentity = { gid: '4055722', token: 'd7df36ff21' }
  const oldMetadata = {
    gid: 4050179,
    parent_gid: '4050161', parent_key: '1961fe3850',
    current_gid: '4055722', current_key: 'd7df36ff21',
    first_gid: '4050161', first_key: '1961fe3850'
  }
  const latestMetadata = {
    gid: 4055722,
    parent_gid: '4050179', parent_key: '09c3a040d0',
    first_gid: '4050161', first_key: '1961fe3850'
  }
  const currentLatest = getGalleryVersionRelation({
    currentMetadata: latestMetadata,
    candidateMetadata: oldMetadata,
    currentIdentity: latestIdentity,
    candidateIdentity: oldIdentity
  })
  assert.equal(currentLatest.sameChain, true)
  assert.equal(currentLatest.status, 'current-latest')
  assert.equal(currentLatest.latestIdentity.gid, '4055722')
  assert.deepEqual(new Set(currentLatest.chainGids), new Set(['4050161', '4050179', '4055722']))

  const candidateLatest = getGalleryVersionRelation({
    currentMetadata: oldMetadata,
    candidateMetadata: latestMetadata,
    currentIdentity: oldIdentity,
    candidateIdentity: latestIdentity
  })
  assert.equal(candidateLatest.status, 'candidate-latest')

  const unrelated = getGalleryVersionRelation({
    currentMetadata: latestMetadata,
    candidateMetadata: { gid: 9999999 },
    currentIdentity: latestIdentity,
    candidateIdentity: { gid: '9999999', token: 'different1' }
  })
  assert.equal(unrelated.sameChain, false)
  assert.equal(unrelated.status, 'unrelated')
})

test('confirmed version chains suppress only identity noise belonging to the same book and chain', () => {
  const relation = { sameChain: true, chainGids: ['4050161', '4050179', '4055722'] }
  assert.equal(isVersionChainNoise({ type: 'ehviewer-url-conflict', bookId: 'book' }, 'book', relation), true)
  assert.equal(isVersionChainNoise({ type: 'unverified-page-mismatch', bookId: 'book' }, 'book', relation), true)
  assert.equal(isVersionChainNoise({ type: 'filename-url-id-conflict', bookId: 'book', evidence: { filenameId: '4050179' } }, 'book', relation), true)
  assert.equal(isVersionChainNoise({ type: 'filename-url-id-conflict', bookId: 'book', evidence: { filenameId: '123' } }, 'book', relation), false)
  assert.equal(isVersionChainNoise({ type: 'metadata-missing', bookId: 'book' }, 'book', relation), false)
  assert.equal(isVersionChainNoise({ type: 'ehviewer-url-conflict', bookId: 'other' }, 'book', relation), false)
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

test('source recovery action requires an available .ehviewer gallery and valid gdata', () => {
  const candidateAvailability = availability('available', 'generic-unavailable', '4049796', 'bc7704fe8b')
  const input = {
    bookId: 'book-1',
    filepath: 'book.zip',
    expectedSize: 123,
    expectedMtimeMs: 456,
    currentUrl: null,
    candidateIdentity: { gid: '4049796', token: 'bc7704fe8b' },
    candidateAvailability,
    candidateGdata: { status: 'available', metadata: { gid: 4049796 } }
  }
  const action = buildSourceRecoveryAction(input)
  assert.equal(action.type, 'repair-url')
  assert.equal(action.repairKind, 'source-recovery')
  assert.equal(action.currentUrl, null)
  assert.equal(action.newUrl, 'https://e-hentai.org/g/4049796/bc7704fe8b/')
  assert.equal(buildSourceRecoveryAction({ ...input, currentUrl: 'https://example.com/' }), null)
  assert.equal(buildSourceRecoveryAction({ ...input, candidateGdata: { status: 'network-error' } }), null)
  assert.equal(buildSourceRecoveryAction({ ...input, candidateAvailability: availability('copyright', 'generic-unavailable') }), null)
})

test('ehviewer sync action is only generated for archive formats that can be rewritten safely', () => {
  const input = {
    bookId: 'book-1',
    filepath: 'book.zip',
    bookType: 'zip',
    expectedSize: 123,
    expectedMtimeMs: 456,
    currentUrl: 'https://exhentai.org/g/2000000/bbbbbbbbbb/',
    currentIdentity: { gid: '2000000', token: 'bbbbbbbbbb' },
    currentTitle: 'Current title',
    entryPath: '.ehviewer',
    recoverySupport: { supported: true, format: 'zip' },
    currentAvailability: availability('available', 'available', '2000000', 'bbbbbbbbbb'),
    candidateAvailability: availability('generic-unavailable', 'gallery-not-found', '1000000', 'aaaaaaaaaa'),
    currentGdata: { status: 'available' }
  }
  const action = buildEhviewerSyncAction(input)
  assert.equal(action.type, 'repair-ehviewer')
  assert.equal(action.repairKind, 'ehviewer-sync-to-current-metadata')
  assert.deepEqual(action.identity, input.currentIdentity)
  assert.equal(buildEhviewerSyncAction({ ...input, filepath: 'book.rar', bookType: 'rar', recoverySupport: { supported: false, format: 'rar' } }), null)
  assert.equal(buildEhviewerSyncAction({ ...input, currentGdata: { status: 'network-error' } }), null)
})

test('same identity changes domain only when the current site is unavailable', () => {
  const result = availability('available', 'generic-unavailable', '2212965', '551e1ccfb1')
  assert.equal(
    getSameIdentityFallbackUrl(result, 'https://exhentai.org/g/2212965/551e1ccfb1/'),
    'https://e-hentai.org/g/2212965/551e1ccfb1/'
  )
  assert.equal(getSameIdentityFallbackUrl(result, 'https://e-hentai.org/g/2212965/551e1ccfb1/'), null)
  assert.equal(
    getSameIdentityFallbackUrl(availability('available', 'network-error', '2212965', '551e1ccfb1'), 'https://exhentai.org/g/2212965/551e1ccfb1/'),
    null
  )
  assert.equal(
    getSameIdentityFallbackUrl(availability('available', 'service-unavailable', '2212965', '551e1ccfb1'), 'https://exhentai.org/g/2212965/551e1ccfb1/'),
    null
  )
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

  await cache.setGdata({
    gid: '1', token: 'token', status: 'available',
    metadata: { gid: 1, title: 'Cached gallery', tags: [] }, checkedAt: Date.now()
  })
  const cachedGdata = await cache.getGdata({ gid: '1', token: 'token' })
  assert.equal(cachedGdata.status, 'available')
  assert.equal(cachedGdata.metadata.title, 'Cached gallery')

  let requests = 0
  const cachedBatch = await getGdataBatch({
    identities: [{ gid: '1', token: 'token' }],
    setting: {},
    cache,
    fetchImpl: async () => {
      requests += 1
      throw new Error('cache should avoid this request')
    }
  })
  assert.equal(requests, 0)
  assert.equal(cachedBatch.get('1:token').cached, true)

  const refreshedBatch = await getGdataBatch({
    identities: [{ gid: '1', token: 'token' }],
    setting: {},
    cache,
    force: true,
    fetchImpl: async url => {
      requests += 1
      return response(JSON.stringify({ gmetadata: [{ gid: 1, title: 'Refreshed gallery', tags: [] }] }), 200, url)
    }
  })
  assert.equal(requests, 1)
  assert.equal(refreshedBatch.get('1:token').metadata.title, 'Refreshed gallery')
})

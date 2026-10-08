const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const sharp = require('sharp')
const AdmZip = require('adm-zip')
const { PageRecoveryManager, parseGalleryPageManifest, parseGalleryPagination, parseImagePageSource, assessBatchPageMapping, listPendingRecoverySummaries } = require('../modules/audit/page_recovery.js')
const { buildNhentaiImageUrl, normalizeNhentaiSearchResultLimit } = require('../modules/nhentai.js')
const { extractJmComicId, searchJmComic, setJmComicBrowserFetchers, parseSearchResults, parseJmApiSearchResults, parseJmApiAlbumInfo, parseJmApiChapter, decryptJmApiData, parseAlbumInfo, parsePhotoManifest, getJmImageSegmentCount, decodeJmImage } = require('../modules/jmcomic.js')
const { inspectBookHealth } = require('../modules/audit/archive_inspector.js')

test('nHentai recovery uses the API page path and extension', () => {
  assert.equal(
    buildNhentaiImageUrl({
      cdn: { image_servers: ['https://i1.nhentai.net'] },
      mediaId: '3684220',
      pageNumber: 14,
      page: { number: 14, path: 'galleries/3684220/14.webp' }
    }),
    'https://i1.nhentai.net/galleries/3684220/14.webp'
  )
})

test('nHentai search result limit is configurable within the API page size', () => {
  assert.equal(normalizeNhentaiSearchResultLimit(undefined), 5)
  assert.equal(normalizeNhentaiSearchResultLimit(1), 1)
  assert.equal(normalizeNhentaiSearchResultLimit(12), 12)
  assert.equal(normalizeNhentaiSearchResultLimit(100), 25)
  assert.equal(normalizeNhentaiSearchResultLimit(0), 1)
})

test('JMComic source parsing keeps album, chapter and page identities', async () => {
  assert.equal(extractJmComicId('https://18comic.vip/album/615436/'), '615436')
  assert.equal(extractJmComicId('JM615436'), '615436')
  const search = parseSearchResults(
    '<a href="/album/615436/" title="[作者] 测试本"><span>测试本</span></a><a href="/album/615436/" title="duplicate">duplicate</a><a href="/album/615437/" title="第二本">第二本</a>',
    'https://18comic.vip/search/photos'
  )
  assert.deepEqual(search.map(item => item.id), ['615436', '615437'])
  assert.equal(search[0].url, 'https://18comic.vip/album/615436/')

  const album = parseAlbumInfo({
    id: '615436',
    url: 'https://18comic.vip/album/615436/',
    html: '<h2 id="book-name">[作者] 测试本</h2><span class="pagecount">頁數: 2</span><a data-album="700001">第1话</a><a data-album="700002">第2话</a>'
  })
  assert.equal(album.title, '[作者] 测试本')
  assert.equal(album.pageCount, 2)
  assert.deepEqual(album.episodes, ['700001', '700002'])

  const photo = parsePhotoManifest({
    photoId: '700001',
    photoUrl: 'https://18comic.vip/photo/700001/',
    html: 'var scramble_id = 220980; var page_arr = ["00001.webp", "00002.webp"]; <img src="https://cdn-msp.18comic.org/media/albums/blank.jpg">'
  })
  assert.equal(photo.scrambleId, '220980')
  assert.deepEqual(photo.pages.map(item => item.imageUrl), [
    'https://cdn-msp.18comic.org/media/photos/700001/00001.webp',
    'https://cdn-msp.18comic.org/media/photos/700001/00002.webp'
  ])
})

test('JMComic search falls back to the browser session when Node networking is blocked', async () => {
  setJmComicBrowserFetchers({
    fetchText: async ({ url }) => ({
      body: '<a href="/album/615436/" title="[作者] 测试本"><span>测试本</span></a>',
      finalUrl: url,
      status: 200
    })
  })
  try {
    const results = await searchJmComic({
      title: '测试本',
      setting: {
        jmcomicDomain: 'http://127.0.0.1:1',
        jmcomicApiDomains: ['http://127.0.0.1:1']
      }
    })
    assert.deepEqual(results.map(item => item.id), ['615436'])
  } finally {
    setJmComicBrowserFetchers()
  }
})

test('JMComic mobile API data and page manifests are decoded into recovery sources', () => {
  const timestamp = 1700000000
  const value = { id: 615436, name: '测试本', total_photos: 2 }
  const key = Buffer.from(crypto.createHash('md5').update(`${timestamp}185Hcomic3PAPP7R`).digest('hex'), 'utf8')
  const cipher = crypto.createCipheriv('aes-256-ecb', key, null)
  cipher.setAutoPadding(true)
  const encrypted = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value))), cipher.final()]).toString('base64')
  assert.deepEqual(JSON.parse(decryptJmApiData(encrypted, timestamp)), value)

  assert.deepEqual(parseJmApiSearchResults({
    data: { content: [{ id: '615436', name: '测试本', total_photos: 2 }, { id: '615436', name: '重复' }] },
    htmlDomain: 'https://18comic.vip'
  }), [{
    title: '测试本',
    url: 'https://18comic.vip/album/615436/',
    type: 'jmcomic',
    id: '615436',
    confidence: 'title',
    pageCount: 2
  }])

  const album = parseJmApiAlbumInfo({
    data: { id: 615436, name: '测试本', total_photos: 2, series: [] },
    url: 'https://18comic.vip/album/615436/',
    id: '615436',
    apiDomain: 'https://www.cdnhjk.net'
  })
  assert.deepEqual(album.episodes, ['615436'])
  const chapter = parseJmApiChapter({
    data: { id: 615436, images: ['00001.webp', '00002.webp'] },
    sourceUrl: album.url,
    apiDomain: album.apiDomain
  })
  assert.equal(chapter.pages[1].imageUrl, 'https://cdn-msp.jmapiproxy1.cc/media/photos/615436/00002.webp')
  assert.equal(chapter.pages[1].imageUrls.length, 6)
  assert.equal(chapter.pages[1].imageReferer, 'https://www.cdnhjk.net/')
})

test('JMComic image decoder follows the published segmentation rules', async () => {
  const imageBuffer = await sharp({ create: { width: 4, height: 10, channels: 3, background: '#336699' } }).png().toBuffer()
  assert.equal(getJmImageSegmentCount({ scrambleId: 999999, photoId: 1, pageFileName: '00001.webp' }), 0)
  const decoded = await decodeJmImage({ buffer: imageBuffer, scrambleId: 999999, photoId: 1, pageFileName: '00001.webp' })
  assert.ok(Buffer.isBuffer(decoded.buffer))
  assert.equal(decoded.decoded, false)
  assert.equal(decoded.contentType, null)
})

test('JMComic segmentation hashes the filename without its extension', () => {
  for (const extension of ['', '.webp', '.jpg', '.png']) {
    assert.equal(getJmImageSegmentCount({ scrambleId: 220980, photoId: 1188850, pageFileName: `00014${extension}` }), 6)
    assert.equal(getJmImageSegmentCount({ scrambleId: 220980, photoId: 1188850, pageFileName: `00024${extension}` }), 16)
  }
  assert.equal(getJmImageSegmentCount({ scrambleId: 220980, photoId: 250000, pageFileName: '00014.webp' }), 10)
})

test('JMComic decoder restores scrambled bands including uneven image heights', async () => {
  const width = 32
  const channels = 3
  const segmentCount = 6
  const bandHeight = 24
  for (const remainder of [0, 5]) {
    const height = segmentCount * bandHeight + remainder
    const rowSize = width * channels
    const original = Buffer.alloc(rowSize * height)
    for (let row = 0; row < height; row += 1) {
      original.fill(30 + Math.floor(row * 180 / height), row * rowSize, (row + 1) * rowSize)
    }
    const bands = Array.from({ length: segmentCount }, (_, index) => {
      const start = index === 0 ? 0 : index * bandHeight + remainder
      const end = (index + 1) * bandHeight + remainder
      return original.subarray(start * rowSize, end * rowSize)
    })
    const scrambled = await sharp(Buffer.concat([...bands].reverse()), { raw: { width, height, channels } }).png().toBuffer()
    const decoded = await decodeJmImage({
      buffer: scrambled,
      scrambleId: 220980,
      photoId: 1188850,
      pageFileName: '00014.webp'
    })
    const expected = await sharp(original, { raw: { width, height, channels } }).jpeg().toBuffer()
    assert.equal(decoded.decoded, true)
    assert.equal(decoded.contentType, 'image/jpeg')
    assert.deepEqual(decoded.buffer, expected, `Incorrect band order for height ${height}`)
  }
})

test('gallery pagination exposes later page-list URLs without downloading images', () => {
  const galleryUrl = 'https://exhentai.org/g/1234567/abcdef1234/'
  const pagination = parseGalleryPagination({
    galleryUrl,
    html: '<p class="gpc">Showing 1 - 20 of 26 images</p><table class="ptt"><a href="https://exhentai.org/g/1234567/abcdef1234/?p=1">2</a></table>'
  })
  assert.equal(pagination.total, 26)
  assert.equal(pagination.pageSize, 20)
  assert.equal(pagination.pageCount, 2)
  assert.deepEqual(pagination.pageUrls, [galleryUrl, `${galleryUrl}?p=1`])
})

test('batch page recovery accepts leading gaps but defers trailing gaps', () => {
  const leadingHealth = {
    pageCount: 3,
    imageSequence: {
      checkedGroups: [{ directory: '.', imageCount: 3, first: 3, last: 6, missingCount: 1, missingRanges: [{ start: 4, end: 4, count: 1 }], missingNumbers: [4] }]
    }
  }
  const leading = assessBatchPageMapping({ health: leadingHealth, onlinePageCount: 6, pageNumbers: [1, 2, 4] })
  assert.equal(leading.confidence, 'anchored')
  assert.equal(leading.batchSupported, true)
  assert.deepEqual(leading.leadingPages, [1, 2])
  assert.deepEqual(leading.trailingPages, [])

  const trailingHealth = {
    pageCount: 3,
    imageSequence: {
      checkedGroups: [{ directory: '.', imageCount: 3, first: 1, last: 4, missingCount: 1, missingRanges: [{ start: 2, end: 2, count: 1 }], missingNumbers: [2] }]
    }
  }
  const trailing = assessBatchPageMapping({ health: trailingHealth, onlinePageCount: 5, pageNumbers: [2, 5] })
  assert.equal(trailing.confidence, 'anchored')
  assert.equal(trailing.batchSupported, false)
  assert.equal(trailing.batchReason, 'PAGE_RECOVERY_BATCH_TRAILING_UNCONFIRMED')
  assert.deepEqual(trailing.trailingPages, [5])
})

test('legacy completed recovery with remaining pages is restored as pending review', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'page-recovery-legacy-pending-'))
  const recoveryId = 'legacy-pending'
  const jobDir = path.join(root, 'audit', 'page-recovery', 'jobs', recoveryId)
  await fs.promises.mkdir(jobDir, { recursive: true })
  await fs.promises.writeFile(path.join(jobDir, 'state.json'), JSON.stringify({
    recoveryId,
    reportId: 'old-report',
    anomalyId: 'old-anomaly',
    status: 'completed',
    remainingMissingPages: [42],
    selectedPages: [12],
    candidates: [{ id: 'old-candidate' }]
  }))
  await fs.promises.writeFile(path.join(jobDir, 'summary.json'), JSON.stringify({
    recoveryId,
    reportId: 'old-report',
    anomalyId: 'old-anomaly',
    status: 'completed',
    selectedPages: [12],
    candidateCount: 1
  }))
  try {
    const summaries = await listPendingRecoverySummaries(root)
    assert.equal(summaries.length, 1)
    assert.equal(summaries[0].status, 'awaiting-confirmation')
    assert.deepEqual(summaries[0].remainingMissingPages, [42])
    assert.deepEqual(summaries[0].selectedPages, [42])
    assert.equal(summaries[0].batchWriteBackSupported, false)
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

test('page recovery fetches only selected pages and writes a confirmed folder page back', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'page-recovery-'))
  const library = path.join(root, 'book')
  await fs.promises.mkdir(library, { recursive: true })
  const imageBuffer = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#336699' } }).png().toBuffer()
  await fs.promises.writeFile(path.join(library, 'page-0001.webp'), imageBuffer)
  await fs.promises.writeFile(path.join(library, 'page-0003.webp'), imageBuffer)
  await fs.promises.writeFile(path.join(library, 'page-0004.webp'), imageBuffer)
  const sourceUrl = 'https://exhentai.org/g/1234567/abcdef1234/'
  const book = { id: 'book-1', filepath: library, type: 'folder', url: sourceUrl }
  const initialHealth = await inspectBookHealth(book)
  const report = {
    reportId: 'report-1',
    stale: false,
    anomalies: [{
      id: 'anomaly-1',
      bookId: book.id,
      filepath: library,
      type: 'archive-image-sequence-gap',
      evidence: {
        imageSequence: initialHealth.imageSequence
      }
    }]
  }
  let detailRequests = 0
  let imageRequests = 0
  const manager = new PageRecoveryManager({
    storePath: root,
    Manga: { findByPk: async () => book },
    getSetting: () => ({ requireGap: 0 }),
    getGalleryPage: async () => ({
      status: 'available',
      html: '<a href="/s/one/1234567-1">1</a><a href="/s/two/1234567-2">2</a><a href="/s/three/1234567-3">3</a><a href="/s/four/1234567-4">4</a>'
    }),
    requestText: async ({ url }) => {
      detailRequests += 1
      return { body: `<img id="img" src="https://ehgt.org/image-${url.includes('/s/two/') ? '2' : 'unexpected'}.png">` }
    },
    requestBinary: async () => {
      imageRequests += 1
      return { buffer: imageBuffer, httpStatus: 200, contentType: 'image/png' }
    }
  })

  try {
    const manifest = parseGalleryPageManifest({ html: '<a href="/s/one/a">1</a><a href="/s/two/b">2</a>', galleryUrl: sourceUrl })
    assert.equal(manifest.length, 2)
    assert.deepEqual(manifest.map(item => item.pageNumber), [1, 2])
    assert.match(parseImagePageSource({ html: '<img id="img" src="/image.png">', pageUrl: sourceUrl }), /image\.png$/)

    await assert.rejects(
      manager.fetchSelectedPages({ report: { ...report, stale: true, staleReason: 'library-changed' }, anomalyId: 'anomaly-1', pageNumbers: [2] }),
      /PAGE_RECOVERY_REPORT_INVALID/
    )
    const continuableReport = { ...report, stale: true, staleReason: 'page-recovery' }
    const session = await manager.fetchSelectedPages({ report: continuableReport, anomalyId: 'anomaly-1', pageNumbers: [2] })
    assert.equal(await fs.promises.stat(path.join(root, 'audit', 'page-recovery', 'jobs', session.recoveryId, 'summary.json')).then(() => true), true)
    assert.equal(detailRequests, 1)
    assert.equal(imageRequests, 1)
    assert.deepEqual(session.selectedPages, [2])
    assert.equal(session.writeBackSupported, true)
    assert.equal(session.batchWriteBackSupported, true)
    assert.equal(session.candidates.length, 1)
    assert.equal(session.candidates[0].pageNumber, 2)
    assert.equal(session.candidates[0].localContext.previous.pageNumber, 1)
    assert.equal(session.candidates[0].localContext.next.pageNumber, 3)
    assert.match(session.candidates[0].localContext.previous.previewDataUrl, /^data:image\/jpeg;base64,/)
    assert.match(session.candidates[0].localContext.next.previewDataUrl, /^data:image\/jpeg;base64,/)
    const restored = await manager.getLatestSession({ reportId: report.reportId, anomalyId: 'anomaly-1' })
    assert.equal(restored.recoveryId, session.recoveryId)
    assert.equal(restored.candidates.length, 1)

    const rebound = await manager.getLatestSession({ reportId: 'report-after-restart', anomalyId: 'anomaly-1' })
    assert.equal(rebound.recoveryId, session.recoveryId)
    assert.equal(rebound.reportId, 'report-after-restart')
    const summaries = await manager.listLatestSessionSummaries({
      reportId: 'report-after-restart',
      anomalyIds: ['anomaly-1']
    })
    assert.deepEqual(summaries.map(item => item.anomalyId), ['anomaly-1'])
    assert.equal(summaries[0].reportId, 'report-after-restart')

    const result = await manager.apply({ report: { ...continuableReport, reportId: 'report-after-restart' }, recoveryId: session.recoveryId, candidateIds: [session.candidates[0].id] })
    assert.equal(result.health.imageSequence.gapCount, 0)
    assert.equal(result.session.status, 'completed')
    assert.equal(await fs.promises.stat(path.join(library, 'page-0002.png')).then(() => true), true)
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

test('page recovery can use an nHentai API manifest and CDN image source', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'page-recovery-nhentai-'))
  const library = path.join(root, 'book')
  await fs.promises.mkdir(library, { recursive: true })
  const imageBuffer = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#996633' } }).png().toBuffer()
  await fs.promises.writeFile(path.join(library, 'page-0001.webp'), imageBuffer)
  await fs.promises.writeFile(path.join(library, 'page-0003.webp'), imageBuffer)
  await fs.promises.writeFile(path.join(library, 'page-0004.webp'), imageBuffer)
  const sourceUrl = 'https://nhentai.net/g/611025/'
  const book = { id: 'book-nhentai', filepath: library, type: 'folder', url: sourceUrl, title: 'nHentai 611025' }
  const health = await inspectBookHealth(book)
  const report = {
    reportId: 'report-nhentai',
    stale: false,
    anomalies: [{
      id: 'anomaly-nhentai',
      bookId: book.id,
      filepath: library,
      type: 'archive-image-sequence-gap',
      evidence: { currentUrl: sourceUrl, imageSequence: health.imageSequence }
    }]
  }
  let manifestRequests = 0
  let imageRequests = 0
  const manager = new PageRecoveryManager({
    storePath: root,
    Manga: { findByPk: async () => book },
    getSetting: () => ({ nhentaiApiKey: 'test-key', requireGap: 0 }),
    getNhentaiRecoveryManifest: async ({ id, url }) => {
      manifestRequests += 1
      assert.equal(id, '611025')
      assert.equal(url, sourceUrl)
      return {
        galleryId: '611025',
        mediaId: 'media-611025',
        onlinePageCount: 4,
        pages: [1, 2, 3, 4].map(pageNumber => ({
          pageNumber,
          pageUrl: `${sourceUrl}#page=${pageNumber}`,
          imageUrl: `https://cdn.example/media-611025/${pageNumber}.jpg`
        }))
      }
    },
    requestNhentaiImage: async ({ imageUrl, referer }) => {
      imageRequests += 1
      assert.match(imageUrl, /\/2\.jpg$/)
      assert.equal(referer, sourceUrl)
      return { buffer: imageBuffer, httpStatus: 200, contentType: 'image/png' }
    },
    requestText: async () => { throw new Error('E_HENTAI_REQUEST_SHOULD_NOT_RUN') },
    requestBinary: async () => { throw new Error('E_HENTAI_IMAGE_SHOULD_NOT_RUN') }
  })

  try {
    const session = await manager.fetchSelectedPages({
      report,
      anomalyId: 'anomaly-nhentai',
      source: 'current',
      sourceUrl,
      pageNumbers: [2]
    })
    assert.equal(manifestRequests, 1)
    assert.equal(imageRequests, 1)
    assert.equal(session.source.type, 'nhentai')
    assert.equal(session.source.galleryId, '611025')
    assert.equal(session.source.mediaId, 'media-611025')
    assert.equal(session.online.pageCount, 4)
    assert.equal(session.candidates[0].pageNumber, 2)
    assert.equal(session.candidates[0].imageUrl, 'https://cdn.example/media-611025/2.jpg')
    assert.equal(session.writeBackSupported, true)
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

test('page recovery can use a JMComic manifest and decoded image source', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'page-recovery-jmcomic-'))
  const library = path.join(root, 'book')
  await fs.promises.mkdir(library, { recursive: true })
  const imageBuffer = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#663399' } }).png().toBuffer()
  await fs.promises.writeFile(path.join(library, 'page-0001.webp'), imageBuffer)
  await fs.promises.writeFile(path.join(library, 'page-0003.webp'), imageBuffer)
  await fs.promises.writeFile(path.join(library, 'page-0004.webp'), imageBuffer)
  const sourceUrl = 'https://18comic.vip/album/615436/'
  const book = { id: 'book-jmcomic', filepath: library, type: 'folder', url: sourceUrl, title: 'JM615436' }
  const health = await inspectBookHealth(book)
  const report = {
    reportId: 'report-jmcomic',
    stale: false,
    anomalies: [{
      id: 'anomaly-jmcomic',
      bookId: book.id,
      filepath: library,
      type: 'archive-image-sequence-gap',
      evidence: { currentUrl: sourceUrl, imageSequence: health.imageSequence }
    }]
  }
  let manifestRequests = 0
  let imageRequests = 0
  const manager = new PageRecoveryManager({
    storePath: root,
    Manga: { findByPk: async () => book },
    getSetting: () => ({ requireGap: 0 }),
    getJmComicRecoveryManifest: async ({ id, url }) => {
      manifestRequests += 1
      assert.equal(id, '615436')
      assert.equal(url, sourceUrl)
      return {
        galleryId: '615436',
        sourceUrl,
        onlinePageCount: 4,
        pages: [1, 2, 3, 4].map(pageNumber => ({
          pageNumber,
          pageUrl: `${sourceUrl}#page=${pageNumber}`,
          imageUrl: `https://cdn.example/615436/${pageNumber}.webp`,
          photoId: '615436',
          scrambleId: '999999',
          pageFileName: `${String(pageNumber).padStart(5, '0')}.webp`
        }))
      }
    },
    requestJmComicImage: async ({ imageUrl, referer, photoId, scrambleId }) => {
      imageRequests += 1
      assert.match(imageUrl, /\/2\.webp$/)
      assert.equal(referer, sourceUrl)
      assert.equal(photoId, '615436')
      assert.equal(scrambleId, '999999')
      return { buffer: imageBuffer, httpStatus: 200, contentType: 'image/png' }
    },
    requestText: async () => { throw new Error('E_HENTAI_REQUEST_SHOULD_NOT_RUN') },
    requestBinary: async () => { throw new Error('E_HENTAI_IMAGE_SHOULD_NOT_RUN') }
  })

  try {
    const session = await manager.fetchSelectedPages({
      report,
      anomalyId: 'anomaly-jmcomic',
      source: 'current',
      sourceUrl,
      pageNumbers: [2]
    })
    assert.equal(manifestRequests, 1)
    assert.equal(imageRequests, 1)
    assert.equal(session.source.type, 'jmcomic')
    assert.equal(session.source.galleryId, '615436')
    assert.equal(session.online.pageCount, 4)
    assert.equal(session.candidates[0].pageNumber, 2)
    assert.equal(session.writeBackSupported, true)
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

test('page recovery persists failed fetch status for restart', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'page-recovery-failed-'))
  const library = path.join(root, 'book')
  await fs.promises.mkdir(library, { recursive: true })
  const imageBuffer = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#336699' } }).png().toBuffer()
  await fs.promises.writeFile(path.join(library, 'page-0001.webp'), imageBuffer)
  await fs.promises.writeFile(path.join(library, 'page-0003.webp'), imageBuffer)
  await fs.promises.writeFile(path.join(library, 'page-0004.webp'), imageBuffer)
  const sourceUrl = 'https://exhentai.org/g/1234568/abcdef1235/'
  const book = { id: 'book-failed', filepath: library, type: 'folder', url: sourceUrl }
  const health = await inspectBookHealth(book)
  const report = {
    reportId: 'report-failed',
    stale: false,
    anomalies: [{
      id: 'anomaly-failed',
      bookId: book.id,
      filepath: library,
      type: 'archive-image-sequence-gap',
      evidence: { imageSequence: health.imageSequence }
    }]
  }
  const manager = new PageRecoveryManager({
    storePath: root,
    Manga: { findByPk: async () => book },
    getSetting: () => ({ requireGap: 0 }),
    getGalleryPage: async () => ({
      status: 'available',
      html: '<a href="/s/one/1234568-1">1</a><a href="/s/two/1234568-2">2</a><a href="/s/three/1234568-3">3</a>'
    }),
    requestText: async () => ({ body: '<img id="img" src="https://ehgt.org/image.png">' }),
    requestBinary: async () => { throw new Error('ECONNRESET') }
  })

  try {
    await assert.rejects(
      manager.fetchSelectedPages({ report, anomalyId: 'anomaly-failed', pageNumbers: [2] }),
      /ECONNRESET/
    )
    const jobs = await fs.promises.readdir(path.join(root, 'audit', 'page-recovery', 'jobs'))
    assert.equal(jobs.length, 1)
    assert.equal(await fs.promises.stat(path.join(root, 'audit', 'page-recovery', 'jobs', jobs[0], 'summary.json')).then(() => true), true)
    const restored = await manager.getLatestSession({ reportId: 'report-after-restart', anomalyId: 'anomaly-failed' })
    assert.equal(restored.status, 'failed')
    assert.equal(restored.error, 'ECONNRESET')
    const summaries = await manager.listLatestSessionSummaries({ reportId: 'report-after-restart', anomalyIds: ['anomaly-failed'] })
    assert.equal(summaries[0].status, 'failed')
    assert.equal(summaries[0].error, 'ECONNRESET')
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

test('page recovery keeps trailing pages pending after writing internal gaps', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'page-recovery-trailing-pending-'))
  const library = path.join(root, 'book')
  await fs.promises.mkdir(library, { recursive: true })
  const imageBuffer = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#663399' } }).png().toBuffer()
  await fs.promises.writeFile(path.join(library, 'page-0001.webp'), imageBuffer)
  await fs.promises.writeFile(path.join(library, 'page-0003.webp'), imageBuffer)
  await fs.promises.writeFile(path.join(library, 'page-0004.webp'), imageBuffer)
  const sourceUrl = 'https://exhentai.org/g/1234569/abcdef1236/'
  const book = { id: 'book-trailing-pending', filepath: library, type: 'folder', url: sourceUrl }
  const health = await inspectBookHealth(book)
  const report = {
    reportId: 'report-trailing-pending',
    stale: false,
    anomalies: [{
      id: 'anomaly-trailing-pending',
      bookId: book.id,
      filepath: library,
      type: 'archive-image-sequence-gap',
      evidence: { currentUrl: sourceUrl, imageSequence: health.imageSequence }
    }]
  }
  const manager = new PageRecoveryManager({
    storePath: root,
    Manga: { findByPk: async () => book },
    getSetting: () => ({ requireGap: 0 }),
    getGalleryPage: async () => ({
      status: 'available',
      html: '<p class="gpc">Showing 1 - 4 of 5 images</p><a href="/s/one/1234569-1">1</a><a href="/s/two/1234569-2">2</a><a href="/s/three/1234569-3">3</a><a href="/s/four/1234569-4">4</a>'
    }),
    requestText: async () => ({ body: '<img id="img" src="https://ehgt.org/page-2.png">' }),
    requestBinary: async () => ({ buffer: imageBuffer, httpStatus: 200, contentType: 'image/png' })
  })

  try {
    const session = await manager.fetchSelectedPages({ report, anomalyId: 'anomaly-trailing-pending', pageNumbers: [2] })
    const result = await manager.apply({ report, recoveryId: session.recoveryId, candidateIds: [session.candidates[0].id] })
    assert.equal(result.session.status, 'awaiting-confirmation')
    assert.deepEqual(result.session.remainingMissingPages, [5])
    assert.deepEqual(result.session.selectedPages, [5])
    assert.equal(result.session.batchWriteBackSupported, false)
    assert.equal(result.session.candidates.length, 0)
    assert.equal(await fs.promises.stat(path.join(library, 'page-0002.png')).then(() => true), true)

    const restored = await manager.getLatestSession({ reportId: 'report-after-trailing-write', anomalyId: 'anomaly-trailing-pending' })
    assert.equal(restored.status, 'awaiting-confirmation')
    assert.deepEqual(restored.selectedPages, [5])
    assert.deepEqual(restored.remainingMissingPages, [5])
    const summaries = await manager.listLatestSessionSummaries({
      reportId: 'report-after-trailing-write',
      anomalyIds: ['anomaly-trailing-pending']
    })
    assert.equal(summaries[0].status, 'awaiting-confirmation')
    assert.deepEqual(summaries[0].remainingMissingPages, [5])
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

test('batch page recovery downloads inferred trailing pages into the review cache', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'page-recovery-batch-trailing-'))
  const library = path.join(root, 'book')
  await fs.promises.mkdir(library, { recursive: true })
  const imageBuffer = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#663399' } }).png().toBuffer()
  await fs.promises.writeFile(path.join(library, 'page-0001.webp'), imageBuffer)
  await fs.promises.writeFile(path.join(library, 'page-0003.webp'), imageBuffer)
  await fs.promises.writeFile(path.join(library, 'page-0004.webp'), imageBuffer)
  const sourceUrl = 'https://exhentai.org/g/1234570/abcdef1237/'
  const book = { id: 'book-batch-trailing', filepath: library, type: 'folder', url: sourceUrl }
  const health = await inspectBookHealth(book)
  const report = {
    reportId: 'report-batch-trailing',
    stale: false,
    anomalies: [{
      id: 'anomaly-batch-trailing',
      bookId: book.id,
      filepath: library,
      type: 'archive-image-sequence-gap',
      evidence: { currentUrl: sourceUrl, imageSequence: health.imageSequence }
    }]
  }
  let imageRequests = 0
  const manager = new PageRecoveryManager({
    storePath: root,
    Manga: { findByPk: async () => book },
    getSetting: () => ({ requireGap: 0 }),
    getGalleryPage: async () => ({
      status: 'available',
      html: '<p class="gpc">Showing 1 - 5 of 5 images</p><a href="/s/one/1234570-1">1</a><a href="/s/two/1234570-2">2</a><a href="/s/three/1234570-3">3</a><a href="/s/four/1234570-4">4</a><a href="/s/five/1234570-5">5</a>'
    }),
    requestText: async ({ url }) => ({ body: `<img id="img" src="https://ehgt.org/page-${url.match(/-(\d+)$/)?.[1] || 'unknown'}.png">` }),
    requestBinary: async () => {
      imageRequests += 1
      return { buffer: imageBuffer, httpStatus: 200, contentType: 'image/png' }
    }
  })

  try {
    const session = await manager.fetchSelectedPages({
      report,
      anomalyId: 'anomaly-batch-trailing',
      pageNumbers: [2],
      includeBoundaryPages: true
    })
    assert.equal(imageRequests, 2)
    assert.deepEqual(session.selectedPages, [2, 5])
    assert.deepEqual(session.trailingPages, [5])
    assert.deepEqual(session.candidates.map(item => item.pageNumber), [2, 5])
    assert.equal(session.batchWriteBackSupported, false)

    const summaries = await manager.listLatestSessionSummaries({
      reportId: report.reportId,
      anomalyIds: ['anomaly-batch-trailing']
    })
    assert.deepEqual(summaries[0].candidatePages, [2, 5])
    assert.deepEqual(summaries[0].trailingPages, [5])
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

test('page recovery links fetched consecutive pages as comparison neighbors', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'page-recovery-consecutive-'))
  const library = path.join(root, 'book')
  await fs.promises.mkdir(library, { recursive: true })
  const imageBuffer = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#663399' } }).png().toBuffer()
  await fs.promises.writeFile(path.join(library, 'page-0018.webp'), imageBuffer)
  await fs.promises.writeFile(path.join(library, 'page-0021.webp'), imageBuffer)
  await fs.promises.writeFile(path.join(library, 'page-0022.webp'), imageBuffer)
  const book = { id: 'book-consecutive', filepath: library, type: 'folder' }
  const health = await inspectBookHealth(book)
  const report = {
    reportId: 'report-consecutive',
    stale: false,
    anomalies: [{
      id: 'anomaly-consecutive',
      bookId: book.id,
      filepath: library,
      type: 'archive-image-sequence-gap',
      evidence: { currentUrl: 'https://exhentai.org/g/1234567/abcdef1234/', imageSequence: health.imageSequence }
    }]
  }
  const manager = new PageRecoveryManager({
    storePath: root,
    Manga: { findByPk: async () => book },
    getSetting: () => ({}),
    getGalleryPage: async () => ({
      status: 'available',
      html: '<a href="/s/1/1234567-1">1</a><a href="/s/18/1234567-18">18</a><a href="/s/19/1234567-19">19</a><a href="/s/20/1234567-20">20</a><a href="/s/21/1234567-21">21</a><a href="/s/22/1234567-22">22</a>'
    }),
    requestText: async ({ url }) => ({ body: `<img id="img" src="https://ehgt.org/page-${url.match(/-(\d+)$/)?.[1] || 'unknown'}.png">` }),
    requestBinary: async () => ({ buffer: imageBuffer, httpStatus: 200, contentType: 'image/png' })
  })

  try {
    const session = await manager.fetchSelectedPages({ report, anomalyId: 'anomaly-consecutive', pageNumbers: [1, 19, 20] })
    assert.equal(session.candidates.length, 3)
    assert.equal(session.writeBackSupported, true)
    assert.equal(session.mappingConfidence, 'anchored')
    const first = session.candidates.find(item => item.pageNumber === 1)
    const page19 = session.candidates.find(item => item.pageNumber === 19)
    const page20 = session.candidates.find(item => item.pageNumber === 20)
    assert.equal(first.targetPath, 'page-0001.png')
    assert.equal(first.localContext.previous.status, 'boundary')
    assert.equal(page19.localContext.next.status, 'fetched')
    assert.equal(page19.localContext.next.pageNumber, 20)
    assert.equal(page20.localContext.previous.status, 'fetched')
    assert.equal(page20.localContext.previous.pageNumber, 19)
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

test('page recovery keeps confirmed internal gaps when a leading gap is not anchored online', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'page-recovery-leading-unconfirmed-'))
  const library = path.join(root, 'book')
  await fs.promises.mkdir(library, { recursive: true })
  const imageBuffer = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#663399' } }).png().toBuffer()
  await fs.promises.writeFile(path.join(library, 'page-0002.webp'), imageBuffer)
  await fs.promises.writeFile(path.join(library, 'page-0004.webp'), imageBuffer)
  await fs.promises.writeFile(path.join(library, 'page-0005.webp'), imageBuffer)
  const book = { id: 'book-leading-unconfirmed', filepath: library, type: 'folder' }
  const health = await inspectBookHealth(book)
  const report = {
    reportId: 'report-leading-unconfirmed',
    stale: false,
    anomalies: [{
      id: 'anomaly-leading-unconfirmed',
      bookId: book.id,
      filepath: library,
      type: 'archive-image-sequence-gap',
      evidence: { currentUrl: 'https://exhentai.org/g/1234567/abcdef1234/', imageSequence: health.imageSequence }
    }]
  }
  const manager = new PageRecoveryManager({
    storePath: root,
    Manga: { findByPk: async () => book },
    getSetting: () => ({}),
    getGalleryPage: async () => ({
      status: 'available',
      html: '<a href="/s/1/1234567-1">1</a><a href="/s/2/1234567-2">2</a><a href="/s/3/1234567-3">3</a><a href="/s/4/1234567-4">4</a><a href="/s/5/1234567-5">5</a><a href="/s/6/1234567-6">6</a>'
    }),
    requestText: async ({ url }) => ({ body: `<img id="img" src="https://ehgt.org/page-${url.match(/-(\d+)$/)?.[1] || 'unknown'}.png">` }),
    requestBinary: async () => ({ buffer: imageBuffer, httpStatus: 200, contentType: 'image/png' })
  })

  try {
    const session = await manager.fetchSelectedPages({ report, anomalyId: 'anomaly-leading-unconfirmed', pageNumbers: [1, 3] })
    assert.deepEqual(session.unconfirmedLeadingPages, [1])
    assert.deepEqual(session.selectedPages, [1, 3])
    assert.deepEqual(session.leadingPages, [1])
    assert.deepEqual(session.trailingPages, [6])
    assert.deepEqual(session.availablePages, [1, 3, 6])
    assert.deepEqual(session.unconfirmedBoundaryPages, [1])
    assert.equal(session.candidates.length, 2)
    assert.deepEqual(session.candidates.map(item => item.pageNumber), [1, 3])
    assert.equal(session.writeBackSupported, false)
    const applied = await manager.apply({
      report,
      recoveryId: session.recoveryId,
      candidateIds: session.candidates.map(item => item.id),
      confirmPageMapping: true
    })
    assert.equal(applied.session.status, 'awaiting-confirmation')
    assert.deepEqual(applied.session.remainingMissingPages, [6])
    assert.equal(applied.session.mappingConfidence, 'unknown')
    assert.equal(await fs.promises.stat(path.join(library, 'page-0001.png')).then(() => true), true)
    assert.equal(await fs.promises.stat(path.join(library, 'page-0003.png')).then(() => true), true)
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

test('page recovery writes a selected page into a CBZ and keeps an original backup', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'page-recovery-cbz-'))
  const archivePath = path.join(root, `${'x'.repeat(150)}.cbz`)
  const imageBuffer = await sharp({ create: { width: 18, height: 28, channels: 3, background: '#663399' } }).png().toBuffer()
  const archive = new AdmZip()
  archive.addFile('page-0001.webp', imageBuffer)
  archive.addFile('page-0003.webp', imageBuffer)
  archive.addFile('page-0004.webp', imageBuffer)
  archive.writeZip(archivePath)
  const book = { id: 'book-cbz', filepath: archivePath, type: 'zip' }
  const initialHealth = await inspectBookHealth(book)
  const report = {
    reportId: 'report-cbz',
    stale: false,
    anomalies: [{
      id: 'anomaly-cbz',
      bookId: book.id,
      filepath: archivePath,
      type: 'archive-image-sequence-gap',
      evidence: { currentUrl: 'https://exhentai.org/g/1234567/abcdef1234/', imageSequence: initialHealth.imageSequence }
    }]
  }
  const manager = new PageRecoveryManager({
    storePath: root,
    Manga: { findByPk: async () => book },
    getSetting: () => ({}),
    getGalleryPage: async () => ({ status: 'available', html: '<a href="/s/one/1">1</a><a href="/s/two/2">2</a><a href="/s/three/3">3</a><a href="/s/four/4">4</a>' }),
    requestText: async () => ({ body: '<img id="img" src="https://ehgt.org/page-2.png">' }),
    requestBinary: async () => ({ buffer: imageBuffer, httpStatus: 200, contentType: 'image/png' })
  })

  try {
    const session = await manager.fetchSelectedPages({ report, anomalyId: 'anomaly-cbz', pageNumbers: [2] })
    assert.equal(session.candidates[0].localContext.previous.pageNumber, 1)
    assert.equal(session.candidates[0].localContext.next.pageNumber, 3)
    assert.match(session.candidates[0].localContext.previous.previewDataUrl, /^data:image\/jpeg;base64,/)
    assert.match(session.candidates[0].localContext.next.previewDataUrl, /^data:image\/jpeg;base64,/)
    const result = await manager.apply({ report, recoveryId: session.recoveryId, candidateIds: [session.candidates[0].id] })
    assert.equal(result.health.imageSequence.gapCount, 0)
    assert.equal(new AdmZip(archivePath).getEntry('page-0002.png')?.getData().length, imageBuffer.length)
    assert.equal(await fs.promises.readdir(path.join(root, 'audit', 'page-recovery', 'jobs', session.recoveryId, 'backups')).then(files => files.includes('original.cbz')), true)
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

const createOffsetRecoveryFixture = async (t, { source = 'nhentai', localEnd = 22, sourceEnd = 24, missing = [19], omittedSourcePages = [], archive = false } = {}) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'page-recovery-offset-'))
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const filepath = path.join(root, archive ? 'book.cbz' : 'book')
  const localBuffer = await sharp({ create: { width: 20, height: 30, channels: 3, background: '#369963' } }).png().toBuffer()
  const zip = archive ? new AdmZip() : null
  if (!archive) await fs.promises.mkdir(filepath)
  for (let page = 1; page <= localEnd; page += 1) {
    if (missing.includes(page)) continue
    const name = `page-${String(page).padStart(4, '0')}.png`
    if (zip) zip.addFile(name, localBuffer)
    else await fs.promises.writeFile(path.join(filepath, name), localBuffer)
  }
  if (zip) {
    zip.addFile('notes.txt', Buffer.from('preserve local attachment'))
    zip.writeZip(filepath)
  }
  const urls = {
    ehentai: 'https://e-hentai.org/g/1234567/abcdef1234/',
    exhentai: 'https://exhentai.org/g/1234567/abcdef1234/',
    nhentai: 'https://nhentai.net/g/615436/',
    jmcomic: 'https://18comic.vip/album/567890/'
  }
  const sourceUrl = urls[source]
  const book = { id: 'offset-book', filepath, type: archive ? 'zip' : 'folder', url: sourceUrl }
  const health = await inspectBookHealth(book)
  const report = {
    reportId: 'offset-report', stale: false,
    anomalies: [{ id: 'offset-gap', type: 'archive-image-sequence-gap', bookId: book.id, filepath, evidence: { currentUrl: sourceUrl, imageSequence: health.imageSequence } }]
  }
  const galleryRequests = []
  const imageRequests = []
  const imageForPage = page => sharp({ create: { width: 20, height: 30, channels: 3, background: { r: page * 7 % 256, g: page * 11 % 256, b: page * 13 % 256 } } }).png().toBuffer()
  const imageRequester = async request => {
    const page = Number(new URL(request.imageUrl || request.url).pathname.match(/(\d+)\.png$/)[1])
    imageRequests.push(page)
    return { buffer: await imageForPage(page), httpStatus: 200, contentType: 'image/png' }
  }
  const manifestFetcher = async () => ({
    galleryId: source === 'jmcomic' ? '567890' : '615436',
    onlinePageCount: sourceEnd,
    pages: Array.from({ length: sourceEnd }, (_value, index) => index + 1)
      .filter(page => !omittedSourcePages.includes(page))
      .map(page => ({ pageNumber: page, imageUrl: `https://images.example/${page}.png` }))
  })
  const options = {
    storePath: root, Manga: { findByPk: async () => book }, getSetting: () => ({}),
    getNhentaiRecoveryManifest: manifestFetcher, requestNhentaiImage: imageRequester,
    getJmComicRecoveryManifest: manifestFetcher, requestJmComicImage: imageRequester,
    getGalleryPage: async ({ url }) => {
      galleryRequests.push(url)
      const start = Number(new URL(url).searchParams.get('p') || 0) * 20 + 1
      const end = Math.min(sourceEnd, start + 19)
      const links = Array.from({ length: Math.max(0, end - start + 1) }, (_value, index) => start + index)
        .filter(page => !omittedSourcePages.includes(page))
        .map(page => `<a href="/s/page${page}/1234567-${page}">${page}</a>`).join('')
      return { status: 'available', html: `<p>Showing ${start} - ${end} of ${sourceEnd} images</p>${links}` }
    },
    requestText: async ({ url }) => ({ body: `<img id="img" src="https://images.example/${url.match(/-(\d+)$/)[1]}.png">` }),
    requestBinary: imageRequester
  }
  const manager = new PageRecoveryManager(options)
  return { root, filepath, book, report, manager, options, galleryRequests, imageRequests, imageForPage, localBuffer }
}

for (const source of ['ehentai', 'exhentai', 'nhentai', 'jmcomic']) {
  for (const offset of [-2, 0, 2]) {
    test(`${source} recovery offset ${offset} downloads the source page and writes the local page`, async t => {
      const fixture = await createOffsetRecoveryFixture(t, { source, sourceEnd: 22 + offset, archive: source === 'nhentai' && offset === 2 })
      const { manager, report, filepath } = fixture
      const session = await manager.fetchSelectedPages({ report, anomalyId: 'offset-gap', sourceOffset: offset, pageNumbers: [19] })
      assert.deepEqual(fixture.imageRequests, [19 + offset])
      assert.equal(session.sourceOffset, offset)
      assert.equal(session.online.pageCount, 22 + offset)
      assert.equal(session.online.localPageCount, 22)
      assert.deepEqual(session.availablePages, [19])
      assert.deepEqual(session.trailingPages, [])
      assert.equal(session.batchWriteBackSupported, true)
      const candidate = session.candidates[0]
      assert.equal(candidate.pageNumber, 19)
      assert.equal(candidate.sourcePageNumber, 19 + offset)
      assert.equal(candidate.targetPath, 'page-0019.png')
      assert.equal(candidate.localContext.previous.pageNumber, 18)
      assert.equal(candidate.localContext.next.pageNumber, 20)
      if (offset === 2 && ['ehentai', 'exhentai'].includes(source)) {
        assert.equal(fixture.galleryRequests.some(url => new URL(url).searchParams.get('p') === '1'), true)
      }

      const restarted = new PageRecoveryManager(fixture.options)
      const restored = await restarted.getLatestSession({ reportId: report.reportId, anomalyId: 'offset-gap' })
      assert.equal(restored.sourceOffset, offset)
      assert.equal(restored.candidates[0].sourcePageNumber, 19 + offset)
      assert.equal(restored.candidates[0].previewDataUrl, candidate.previewDataUrl)
      assert.equal(restored.batchWriteBackSupported, true)
      const summaries = await restarted.listLatestSessionSummaries({ reportId: report.reportId, anomalyIds: ['offset-gap'] })
      assert.equal(summaries[0].sourceOffset, offset)
      assert.deepEqual(summaries[0].candidatePages, [19])

      const applied = await restarted.apply({ report, recoveryId: session.recoveryId, candidateIds: restored.candidates.map(item => item.id) })
      assert.equal(applied.session.status, 'completed')
      assert.deepEqual(applied.session.remainingMissingPages, [])
      assert.equal(applied.health.pageCount, 22)
      assert.equal(applied.health.imageSequence.gapCount, 0)
      const readPage = name => fixture.book.type === 'zip' ? new AdmZip(filepath).getEntry(name).getData() : fs.promises.readFile(path.join(filepath, name))
      assert.deepEqual(await readPage('page-0019.png'), await fixture.imageForPage(19 + offset))
      assert.deepEqual(await readPage('page-0021.png'), fixture.localBuffer)
      if (fixture.book.type === 'zip') {
        assert.equal(new AdmZip(filepath).getEntry('notes.txt').getData().toString(), 'preserve local attachment')
        assert.equal(fs.existsSync(path.join(restarted.getJobDir(session.recoveryId), 'backups', 'original.cbz')), true)
      }
    })
  }
}

test('offset recovery rejects invalid and unavailable source pages before any image download', async t => {
  const fixture = await createOffsetRecoveryFixture(t, { sourceEnd: 20, missing: [1, 19] })
  for (const sourceOffset of [1.5, NaN, Infinity, 1001, -1001]) {
    await assert.rejects(fixture.manager.fetchSelectedPages({ report: fixture.report, anomalyId: 'offset-gap', sourceOffset, pageNumbers: [19] }), /PAGE_RECOVERY_SOURCE_OFFSET_INVALID/)
  }
  await assert.rejects(fixture.manager.fetchSelectedPages({ report: fixture.report, anomalyId: 'offset-gap', sourceOffset: -2, pageNumbers: [1] }), /PAGE_RECOVERY_SOURCE_PAGE_INVALID:1:-1/)
  await assert.rejects(fixture.manager.fetchSelectedPages({ report: fixture.report, anomalyId: 'offset-gap', sourceOffset: 2, pageNumbers: [19] }), /PAGE_RECOVERY_SOURCE_PAGE_UNAVAILABLE:19:21/)
  assert.deepEqual(fixture.imageRequests, [])
  const summaries = await fixture.manager.listLatestSessionSummaries({ anomalyIds: ['offset-gap'] })
  assert.equal(summaries[0].status, 'failed')
  assert.equal(summaries[0].candidateCount, 0)
  assert.equal(summaries[0].sourceOffset, 2)
  assert.equal((await inspectBookHealth(fixture.book)).pageCount, 20)

  const incomplete = await createOffsetRecoveryFixture(t, { missing: [18, 19], omittedSourcePages: [21] })
  await assert.rejects(incomplete.manager.fetchSelectedPages({ report: incomplete.report, anomalyId: 'offset-gap', sourceOffset: 2, pageNumbers: [18, 19] }), /PAGE_RECOVERY_SOURCE_PAGE_UNAVAILABLE:19:21/)
  assert.deepEqual(incomplete.imageRequests, [])
})

test('offset recovery maps leading and trailing pages without changing local gap evidence', async t => {
  const fixture = await createOffsetRecoveryFixture(t, { missing: [1, 19, 22] })
  const before = await inspectBookHealth(fixture.book)
  const session = await fixture.manager.fetchSelectedPages({ report: fixture.report, anomalyId: 'offset-gap', sourceOffset: 2, pageNumbers: [19], includeBoundaryPages: true })
  assert.deepEqual(session.selectedPages, [1, 19, 22])
  assert.deepEqual(session.leadingPages, [1])
  assert.deepEqual(session.trailingPages, [22])
  assert.deepEqual(session.candidates.map(item => item.sourcePageNumber), [3, 21, 24])
  assert.equal(session.batchWriteBackSupported, false)
  assert.deepEqual((await inspectBookHealth(fixture.book)).imageSequence, before.imageSequence)

  const partial = await fixture.manager.apply({ report: fixture.report, recoveryId: session.recoveryId, candidateIds: [session.candidates.find(item => item.pageNumber === 19).id], confirmPageMapping: true })
  assert.deepEqual(partial.session.remainingMissingPages, [1, 22])
  const restarted = new PageRecoveryManager(fixture.options)
  const restored = await restarted.getLatestSession({ reportId: fixture.report.reportId, anomalyId: 'offset-gap' })
  assert.equal(restored.sourceOffset, 2)
  assert.equal(restored.local.pageCount, 20)
  assert.deepEqual(restored.availablePages, [1, 22])
  assert.deepEqual(restored.trailingPages, [22])
  const remaining = await restarted.fetchSelectedPages({ report: fixture.report, anomalyId: 'offset-gap', sourceOffset: restored.sourceOffset, pageNumbers: [1, 22] })
  const completed = await restarted.apply({ report: fixture.report, recoveryId: remaining.recoveryId, candidateIds: remaining.candidates.map(item => item.id), confirmPageMapping: true })
  assert.equal(completed.session.status, 'completed')
  assert.deepEqual(completed.session.remainingMissingPages, [])
})

test('offset recovery keeps consecutive preview neighbors in local page order', async t => {
  const fixture = await createOffsetRecoveryFixture(t, { missing: [19, 20] })
  const session = await fixture.manager.fetchSelectedPages({ report: fixture.report, anomalyId: 'offset-gap', sourceOffset: 2, pageNumbers: [19, 20] })
  const [first, second] = session.candidates
  assert.deepEqual(session.candidates.map(item => item.sourcePageNumber), [21, 22])
  assert.equal(first.localContext.previous.pageNumber, 18)
  assert.equal(first.localContext.next.pageNumber, 20)
  assert.equal(first.localContext.next.sourcePageNumber, 22)
  assert.equal(first.localContext.next.previewDataUrl, second.previewDataUrl)
  assert.equal(second.localContext.previous.pageNumber, 19)
  assert.equal(second.localContext.previous.sourcePageNumber, 21)
  assert.equal(second.localContext.previous.previewDataUrl, first.previewDataUrl)
  assert.equal(second.localContext.next.pageNumber, 21)
})

test('negative offsets keep the mapped local tail pending until it is written back', async t => {
  const fixture = await createOffsetRecoveryFixture(t, { sourceEnd: 20, missing: [19, 22] })
  const session = await fixture.manager.fetchSelectedPages({ report: fixture.report, anomalyId: 'offset-gap', sourceOffset: -2, pageNumbers: [19], includeBoundaryPages: true })
  assert.deepEqual(session.selectedPages, [19, 22])
  assert.deepEqual(session.trailingPages, [22])
  assert.deepEqual(session.candidates.map(item => item.sourcePageNumber), [17, 20])
  const partial = await fixture.manager.apply({ report: fixture.report, recoveryId: session.recoveryId, candidateIds: [session.candidates[0].id] })
  assert.deepEqual(partial.session.remainingMissingPages, [22])
  const restarted = new PageRecoveryManager(fixture.options)
  const restored = await restarted.getLatestSession({ reportId: fixture.report.reportId, anomalyId: 'offset-gap' })
  assert.equal(restored.sourceOffset, -2)
  assert.equal(restored.online.pageCount, 20)
  assert.equal(restored.online.localPageCount, 22)
  assert.deepEqual(restored.availablePages, [22])
  assert.deepEqual(restored.trailingPages, [22])
  const tail = await restarted.fetchSelectedPages({ report: fixture.report, anomalyId: 'offset-gap', sourceOffset: -2, pageNumbers: [22] })
  const completed = await restarted.apply({ report: fixture.report, recoveryId: tail.recoveryId, candidateIds: [tail.candidates[0].id], confirmPageMapping: true })
  assert.equal(completed.session.status, 'completed')
  assert.deepEqual(completed.session.remainingMissingPages, [])
  assert.deepEqual(await fs.promises.readFile(path.join(fixture.filepath, 'page-0022.png')), await fixture.imageForPage(20))
})

test('legacy recovery sessions without source offsets restore as zero', async t => {
  const fixture = await createOffsetRecoveryFixture(t, { sourceEnd: 22 })
  const session = await fixture.manager.fetchSelectedPages({ report: fixture.report, anomalyId: 'offset-gap', pageNumbers: [19] })
  delete session.sourceOffset
  delete session.online.sourceOffset
  delete session.online.localPageCount
  delete session.candidates[0].sourcePageNumber
  await fs.promises.writeFile(path.join(fixture.manager.getJobDir(session.recoveryId), 'state.json'), JSON.stringify(session))
  const restarted = new PageRecoveryManager(fixture.options)
  assert.equal((await restarted.getSession(session.recoveryId)).sourceOffset, 0)
  const restored = await restarted.getLatestSession({ reportId: fixture.report.reportId, anomalyId: 'offset-gap' })
  assert.equal(restored.sourceOffset, 0)
  assert.equal(restored.candidates[0].sourcePageNumber, 19)
  assert.equal(restored.online.localPageCount, 22)
})

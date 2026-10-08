const crypto = require('crypto')
const path = require('path')
const fetch = require('node-fetch')
const { HttpsProxyAgent } = require('https-proxy-agent')
const sharp = require('sharp')

const JM_REDIRECT_URL = 'https://jm365.work/3YeBdF'
const JM_DEFAULT_DOMAIN = 'https://18comic.vip'
const JM_SEARCH_RESULT_LIMIT = 5
const JM_DEFAULT_SCRAMBLE_ID = 220980
const JM_SCRAMBLE_268850 = 268850
const JM_SCRAMBLE_421926 = 421926
const JM_API_DOMAINS = [
  'https://www.cdnhjk.net',
  'https://www.cdngwc.cc',
  'https://www.cdngwc.net',
  'https://www.cdngwc.club'
]
const JM_IMAGE_DOMAINS = [
  'https://cdn-msp.jmapiproxy1.cc',
  'https://cdn-msp.jmapiproxy2.cc',
  'https://cdn-msp2.jmapiproxy2.cc',
  'https://cdn-msp3.jmapiproxy2.cc',
  'https://cdn-msp.jmapinodeudzn.net',
  'https://cdn-msp3.jmapinodeudzn.net'
]
const JM_API_VERSION = '1.6.3'
const JM_API_TOKEN_SECRET = '185Hcomic3PAPP7R'
const JM_API_DATA_SECRET = '185Hcomic3PAPP7R'
const JM_API_USER_AGENT = 'Mozilla/5.0 (Linux; Android 9; V1938CT Build/PQ3A.190705.11211812; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/91.0.4472.114 Safari/537.36'

let browserFetchText = null
let browserFetchBinary = null

const setJmComicBrowserFetchers = ({ fetchText: textFetcher, fetchBinary: binaryFetcher } = {}) => {
  browserFetchText = typeof textFetcher === 'function' ? textFetcher : null
  browserFetchBinary = typeof binaryFetcher === 'function' ? binaryFetcher : null
}

const browserHeaders = (referer = null) => ({
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  ...(referer ? { Referer: referer } : {})
})

const imageHeaders = (referer = null) => ({
  Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  ...(referer ? { Referer: referer } : {})
})

const normalizeDomain = value => {
  try {
    const url = new URL(String(value || '').trim())
    return url.origin
  } catch {
    return null
  }
}

const createFetchOptions = (setting = {}, headers = {}) => {
  const agent = setting.proxy ? new HttpsProxyAgent(setting.proxy) : undefined
  return {
    headers,
    ...(agent ? { agent } : {})
  }
}

const md5Hex = value => crypto.createHash('md5').update(String(value)).digest('hex')

const decryptJmApiData = (data, timestamp) => {
  const key = Buffer.from(md5Hex(`${timestamp}${JM_API_DATA_SECRET}`), 'utf8')
  const decipher = crypto.createDecipheriv('aes-256-ecb', key, null)
  decipher.setAutoPadding(true)
  return Buffer.concat([
    decipher.update(Buffer.from(String(data || ''), 'base64')),
    decipher.final()
  ]).toString('utf8')
}

const parseJmApiResponse = (body, timestamp) => {
  const payload = JSON.parse(String(body || ''))
  if (Number(payload?.code) !== 200) {
    throw new Error(`JMCOMIC_API_${payload?.code || 'INVALID_RESPONSE'}`)
  }
  if (payload.data == null || payload.data === '') return payload
  const decoded = JSON.parse(decryptJmApiData(payload.data, timestamp))
  return { ...payload, data: decoded }
}

const getJmApiDomains = setting => {
  if (Array.isArray(setting?.jmcomicApiDomains)) {
    return [...new Set(setting.jmcomicApiDomains.map(normalizeDomain).filter(Boolean))]
  }
  const configured = normalizeDomain(setting?.jmcomicApiDomain)
  return [...new Set([...(configured ? [configured] : []), ...JM_API_DOMAINS])]
}

const fetchJmApiJson = async (apiPath, params = {}, setting = {}) => {
  let lastError = null
  for (const domain of getJmApiDomains(setting)) {
    const timestamp = Math.floor(Date.now() / 1000)
    const url = new URL(apiPath, domain)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
    try {
      const response = await fetch(url.toString(), {
        ...createFetchOptions(setting, {
          Accept: 'application/json',
          'User-Agent': JM_API_USER_AGENT,
          token: md5Hex(`${timestamp}${JM_API_TOKEN_SECRET}`),
          tokenparam: `${timestamp},${JM_API_VERSION}`,
          'X-Requested-With': 'com.JMComic3.app',
          Referer: `${domain}/`
        }),
        redirect: 'follow',
        timeout: 30000
      })
      const body = await response.text()
      if (!response.ok) throw new Error(`JMCOMIC_API_HTTP_${response.status}`)
      return { ...parseJmApiResponse(body, timestamp), apiDomain: domain }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('JMCOMIC_API_UNAVAILABLE')
}

const fetchText = async (url, setting = {}, options = {}) => {
  let response
  try {
    response = await fetch(url, {
      ...createFetchOptions(setting, browserHeaders(options.referer)),
      redirect: 'follow',
      timeout: 30000
    })
  } catch (error) {
    if (browserFetchText) {
      return await browserFetchText({ url, setting, referer: options.referer })
    }
    throw error
  }
  const body = await response.text()
  if (!response.ok) {
    if (browserFetchText) {
      return await browserFetchText({ url, setting, referer: options.referer })
    }
    throw new Error(`JMCOMIC_HTTP_${response.status}`)
  }
  return { body, finalUrl: response.url || url, status: response.status }
}

const decodeHtml = value => String(value || '')
  .replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))

const stripHtml = value => decodeHtml(String(value || '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, ' '))
  .replace(/\s+/g, ' ')
  .trim()

const decodeEmbeddedHtml = value => {
  const encoded = String(value || '').match(/const\s+html\s*=\s*base64DecodeUtf8\(["']([^"']+)["']\)/i)?.[1]
  if (!encoded) return String(value || '')
  try {
    return Buffer.from(encoded, 'base64').toString('utf8')
  } catch {
    return String(value || '')
  }
}

const extractJmComicId = value => {
  if (value == null) return null
  const text = String(value)
  const urlMatch = /(?:18comic|jmcomic|禁漫)[^\s/]*\/\s*(?:album|photo)\/(\d+)/i.exec(text)
  if (urlMatch) return urlMatch[1]
  const pathMatch = /\/(?:album|photo)\/(\d+)/i.exec(text)
  if (pathMatch) return pathMatch[1]
  const jmMatch = /\bjm\s*[-_#]?\s*(\d{3,})\b/i.exec(path.basename(text))
  if (jmMatch) return jmMatch[1]
  const plain = /^\s*(\d{3,})\s*$/.exec(text)
  return plain ? plain[1] : null
}

const resolveJmComicId = ({ id, url, filepath, title } = {}) =>
  extractJmComicId(id) || extractJmComicId(url) || extractJmComicId(filepath) || extractJmComicId(title)

const parseJmUrl = value => {
  try {
    const url = new URL(String(value || ''))
    const match = url.pathname.match(/\/(?:album|photo)\/(\d+)/i)
    return match ? { id: match[1], origin: url.origin, url: url.toString() } : null
  } catch {
    return null
  }
}

const resolveJmDomain = async setting => {
  const configured = normalizeDomain(setting?.jmcomicDomain)
  if (configured) return configured
  try {
    const response = await fetch(JM_REDIRECT_URL, {
      ...createFetchOptions(setting, browserHeaders()),
      redirect: 'follow',
      timeout: 15000
    })
    const origin = response.ok ? normalizeDomain(response.url) : null
    if (origin) return origin
  } catch {
    // Use the stable public domain below when the redirect service is unavailable.
  }
  return JM_DEFAULT_DOMAIN
}

const resolveSourceUrl = async ({ id, url, setting } = {}) => {
  const parsed = parseJmUrl(url)
  if (parsed && parsed.id === String(id)) return parsed.url
  return `${await resolveJmDomain(setting)}/album/${id}/`
}

const parseSearchResults = (html, baseUrl) => {
  const results = []
  const seen = new Set()
  const anchorPattern = /<a\b[^>]*\bhref\s*=\s*["']([^"']*\/album\/\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi
  for (const match of String(html || '').matchAll(anchorPattern)) {
    const idMatch = match[1].match(/\/album\/(\d+)/i)
    if (!idMatch || seen.has(idMatch[1])) continue
    const anchor = match[0]
    const titleMatch = anchor.match(/\btitle\s*=\s*["']([^"']+)["']/i)
    const title = stripHtml(titleMatch ? titleMatch[1] : match[2])
    let url
    try {
      url = new URL(`/album/${idMatch[1]}/`, baseUrl).toString()
    } catch {
      continue
    }
    seen.add(idMatch[1])
    results.push({
      title: title || `JM${idMatch[1]}`,
      url,
      type: 'jmcomic',
      id: idMatch[1],
      confidence: 'title',
      pageCount: null
    })
    if (results.length >= JM_SEARCH_RESULT_LIMIT) break
  }
  return results
}

const parseJmApiSearchResults = ({ data, htmlDomain = JM_DEFAULT_DOMAIN } = {}) => {
  const result = data || {}
  const redirectId = extractJmComicId(result.redirect_aid)
  if (redirectId) {
    return [{
      title: `JM${redirectId}`,
      url: `${htmlDomain}/album/${redirectId}/`,
      type: 'jmcomic',
      id: redirectId,
      confidence: 'exact',
      pageCount: null
    }]
  }
  const seen = new Set()
  return (Array.isArray(result.content) ? result.content : [])
    .map(item => {
      const id = extractJmComicId(item?.id || item?.album_id)
      if (!id || seen.has(id)) return null
      seen.add(id)
      const pageCount = Number(item?.total_photos || item?.page_count || item?.pageCount)
      return {
        title: String(item?.name || item?.title || `JM${id}`).trim(),
        url: `${htmlDomain}/album/${id}/`,
        type: 'jmcomic',
        id,
        confidence: 'title',
        pageCount: Number.isSafeInteger(pageCount) && pageCount > 0 ? pageCount : null
      }
    })
    .filter(Boolean)
    .slice(0, JM_SEARCH_RESULT_LIMIT)
}

const parsePageCount = html => {
  const patterns = [
    /<span[^>]*class=["'][^"']*pagecount[^"']*["'][^>]*>[\s\S]*?(\d+)\s*<\/span>/i,
    /(?:頁數|页数|pages?)\s*[:：]?\s*(\d+)/i
  ]
  for (const pattern of patterns) {
    const match = String(html || '').match(pattern)
    const value = Number(match?.[1])
    if (Number.isSafeInteger(value) && value > 0) return value
  }
  return null
}

const parseAlbumInfo = ({ html, url, id }) => {
  html = decodeEmbeddedHtml(html)
  const titleMatch = String(html || '').match(/id=["']book-name["'][^>]*>([\s\S]*?)<\//i)
  const episodeIds = []
  const seen = new Set()
  for (const match of String(html || '').matchAll(/data-album=["'](\d+)["']/gi)) {
    if (!seen.has(match[1])) {
      seen.add(match[1])
      episodeIds.push(match[1])
    }
  }
  if (!episodeIds.length) episodeIds.push(String(id))
  return {
    id: String(id),
    title: stripHtml(titleMatch?.[1]) || `JM${id}`,
    url,
    type: 'jmcomic',
    pageCount: parsePageCount(html),
    episodes: episodeIds
  }
}

const getJmApiEpisodeIds = (album, albumId) => {
  const episodeIds = (Array.isArray(album?.series) ? album.series : [])
    .map(item => extractJmComicId(item?.id || item?.photo_id || item?.chapter_id))
    .filter(Boolean)
  return [...new Set(episodeIds.length ? episodeIds : [String(albumId)])]
}

const parseJmApiAlbumInfo = ({ data, url, id, apiDomain } = {}) => {
  const albumId = String(data?.id || id)
  const pageCount = Number(data?.total_photos)
  return {
    id: albumId,
    title: String(data?.name || `JM${albumId}`).trim(),
    url,
    type: 'jmcomic',
    pageCount: Number.isSafeInteger(pageCount) && pageCount > 0 ? pageCount : null,
    episodes: getJmApiEpisodeIds(data, albumId),
    apiAlbum: data,
    apiDomain
  }
}

const parseJmApiChapter = ({ data, photoId, sourceUrl, apiDomain } = {}) => {
  const resolvedPhotoId = String(data?.id || photoId)
  const filenames = Array.isArray(data?.images) ? data.images.map(value => String(value)).filter(Boolean) : []
  const scrambleId = String(data?.scramble_id || JM_DEFAULT_SCRAMBLE_ID)
  const htmlOrigin = (() => {
    try {
      return new URL(sourceUrl).origin
    } catch {
      return JM_DEFAULT_DOMAIN
    }
  })()
  const pages = filenames.map((filename, index) => {
    const imageUrls = JM_IMAGE_DOMAINS.map(domain => `${domain}/media/photos/${resolvedPhotoId}/${path.posix.basename(filename)}`)
    return {
      index: index + 1,
      pageNumber: index + 1,
      pageUrl: `${htmlOrigin}/photo/${resolvedPhotoId}/#page=${index + 1}`,
      imageUrl: imageUrls[0],
      imageUrls,
      imageReferer: `${apiDomain || htmlOrigin}/`,
      photoId: resolvedPhotoId,
      scrambleId,
      pageFileName: path.posix.basename(filename)
    }
  })
  return { photoId: resolvedPhotoId, scrambleId, pages }
}

const parseLooseArray = value => {
  const text = String(value || '').trim().replace(/;\s*$/, '')
  try {
    const result = JSON.parse(text)
    return Array.isArray(result) ? result.map(item => String(item)) : []
  } catch {
    return [...text.matchAll(/["']([^"']+\.(?:jpg|jpeg|png|webp|gif))["']/gi)].map(match => match[1])
  }
}

const parsePhotoManifest = ({ html, photoUrl, photoId }) => {
  const text = String(html || '')
  const scrambleId = Number(text.match(/var\s+scramble_id\s*=\s*(\d+)\s*;/i)?.[1]) || JM_DEFAULT_SCRAMBLE_ID
  const pageArr = parseLooseArray(text.match(/var\s+page_arr\s*=\s*([\s\S]*?);/i)?.[1])
  const originalUrls = [...text.matchAll(/\bdata-original\s*=\s*["']([^"']+)["']/gi)]
    .map(match => decodeHtml(match[1]))
    .filter(value => /\.(?:jpg|jpeg|png|webp|gif)(?:\?|$)/i.test(value))
  const domainMatch = text.match(/\bsrc\s*=\s*["']https?:\/\/([^"']+)\/media\/(?:albums\/blank|photos\/)/i)
  const domain = domainMatch ? `https://${domainMatch[1]}` : null
  const filenames = pageArr.length ? pageArr : originalUrls.map(value => path.posix.basename(value.split('?')[0]))
  const pages = filenames.map((filename, index) => {
    const original = originalUrls[index]
    let imageUrl = original
    if (imageUrl && !/^https?:\/\//i.test(imageUrl)) {
      imageUrl = new URL(imageUrl, photoUrl).toString()
    }
    if (!imageUrl && domain) imageUrl = `${domain}/media/photos/${photoId}/${filename}`
    if (!imageUrl) return null
    return {
      index: index + 1,
      pageNumber: index + 1,
      pageUrl: `${photoUrl}#page=${index + 1}`,
      imageUrl,
      photoId: String(photoId),
      scrambleId: String(scrambleId || 0),
      pageFileName: path.posix.basename(imageUrl.split('?')[0]) || filename
    }
  }).filter(Boolean)
  return { photoId: String(photoId), scrambleId: String(scrambleId || 0), pages }
}

const getJmComicInfo = async ({ id, url, setting } = {}) => {
  const albumId = resolveJmComicId({ id, url })
  if (!albumId) throw new Error('JMCOMIC_ALBUM_ID_MISSING')
  const sourceUrl = await resolveSourceUrl({ id: albumId, url, setting })
  try {
    const response = await fetchJmApiJson('/album', { id: albumId }, setting)
    const info = parseJmApiAlbumInfo({
      data: response.data,
      url: sourceUrl,
      id: albumId,
      apiDomain: response.apiDomain
    })
    return { ...info, url: sourceUrl }
  } catch (apiError) {
    const response = await fetchText(sourceUrl, setting)
    const info = parseAlbumInfo({ html: response.body, url: response.finalUrl || sourceUrl, id: albumId })
    return { ...info, url: response.finalUrl || sourceUrl }
  }
}

const searchJmComic = async ({ title, filepath, setting } = {}) => {
  const query = String(title || '').trim()
  const id = resolveJmComicId({ filepath, title }) || extractJmComicId(query)
  if (id) return [{ ...(await getJmComicInfo({ id, setting })), confidence: 'exact' }]
  if (!query) return []
  try {
    const [response, domain] = await Promise.all([
      fetchJmApiJson('/search', {
        main_tag: 0,
        search_query: query,
        page: 1,
        o: 'mr',
        t: 'a'
      }, setting),
      resolveJmDomain(setting)
    ])
    return parseJmApiSearchResults({ data: response.data, htmlDomain: domain })
  } catch (apiError) {
    const domain = await resolveJmDomain(setting)
    const url = new URL('/search/photos', domain)
    url.searchParams.set('main_tag', '0')
    url.searchParams.set('search_query', query)
    url.searchParams.set('page', '1')
    url.searchParams.set('o', 'mr')
    url.searchParams.set('t', 'a')
    const response = await fetchText(url.toString(), setting, { referer: `${domain}/` })
    return parseSearchResults(response.body, response.finalUrl || domain)
  }
}

const getJmComicApiRecoveryManifest = async ({ id, url, setting } = {}) => {
  const albumId = resolveJmComicId({ id, url })
  if (!albumId) throw new Error('JMCOMIC_ALBUM_ID_MISSING')
  const sourceUrl = await resolveSourceUrl({ id: albumId, url, setting })
  const albumResponse = await fetchJmApiJson('/album', { id: albumId }, setting)
  const album = parseJmApiAlbumInfo({
    data: albumResponse.data,
    url: sourceUrl,
    id: albumId,
    apiDomain: albumResponse.apiDomain
  })
  const pages = []
  for (const photoId of album.episodes) {
    const response = await fetchJmApiJson('/chapter', { id: photoId }, setting)
    const parsed = parseJmApiChapter({
      data: response.data,
      sourceUrl: album.url,
      photoId,
      apiDomain: response.apiDomain || album.apiDomain
    })
    pages.push(...parsed.pages.map(page => ({ ...page, pageNumber: pages.length + page.pageNumber, index: pages.length + page.index })))
  }
  const onlinePageCount = Number(album.pageCount) || pages.length
  if (!onlinePageCount || pages.length < onlinePageCount) throw new Error('JMCOMIC_PAGE_MANIFEST_INCOMPLETE')
  return {
    galleryId: album.id,
    sourceUrl: album.url,
    onlinePageCount,
    pages,
    pagesByNumber: Object.fromEntries(pages.map(page => [page.pageNumber, page]))
  }
}

const getJmComicRecoveryManifest = async ({ id, url, filepath, title, setting } = {}) => {
  try {
    return await getJmComicApiRecoveryManifest({ id, url, setting })
  } catch (apiError) {
    const album = await getJmComicInfo({ id, url, setting })
    const pages = []
    for (const photoId of album.episodes) {
      const photoUrl = `${new URL(album.url).origin}/photo/${photoId}/`
      const response = await fetchText(photoUrl, setting, { referer: album.url })
      const parsed = parsePhotoManifest({ html: response.body, photoUrl: response.finalUrl || photoUrl, photoId })
      pages.push(...parsed.pages.map(page => ({ ...page, pageNumber: pages.length + page.pageNumber, index: pages.length + page.index })))
    }
    const onlinePageCount = pages.length || album.pageCount
    if (!onlinePageCount || pages.length < onlinePageCount) throw new Error('JMCOMIC_PAGE_MANIFEST_INCOMPLETE')
    return {
      galleryId: album.id,
      sourceUrl: album.url,
      onlinePageCount,
      pages,
      pagesByNumber: Object.fromEntries(pages.map(page => [page.pageNumber, page]))
    }
  }
}

const getJmImageSegmentCount = ({ scrambleId, photoId, pageFileName } = {}) => {
  const scramble = Number(scrambleId) || 0
  const aid = Number(photoId) || 0
  if (aid < scramble) return 0
  if (aid < JM_SCRAMBLE_268850) return 10
  const x = aid < JM_SCRAMBLE_421926 ? 10 : 8
  const filename = path.posix.parse(pageFileName).name
  const hash = crypto.createHash('md5').update(`${aid}${filename}`).digest('hex')
  return (hash.charCodeAt(hash.length - 1) % x) * 2 + 2
}

const decodeJmImage = async ({ buffer, scrambleId, photoId, pageFileName } = {}) => {
  const segmentCount = getJmImageSegmentCount({ scrambleId, photoId, pageFileName })
  if (!segmentCount) return { buffer, contentType: null, decoded: false }
  const raw = await sharp(buffer).raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = raw.info
  if (!width || !height || !channels || segmentCount > height) return { buffer, contentType: null, decoded: false }
  const rowSize = width * channels
  const decoded = Buffer.alloc(raw.data.length)
  const move = Math.floor(height / segmentCount)
  const over = height % segmentCount
  for (let index = 0; index < segmentCount; index += 1) {
    let sourceHeight = move
    let sourceY = height - (move * (index + 1)) - over
    let targetY = move * index
    if (index === 0) sourceHeight += over
    else targetY += over
    const sourceStart = sourceY * rowSize
    const targetStart = targetY * rowSize
    raw.data.copy(decoded, targetStart, sourceStart, sourceStart + sourceHeight * rowSize)
  }
  const output = await sharp(decoded, { raw: { width, height, channels } }).jpeg().toBuffer()
  return { buffer: output, contentType: 'image/jpeg', decoded: true }
}

const fetchJmComicImage = async ({ imageUrl, imageUrls = [], setting, referer, photoId, scrambleId, pageFileName } = {}) => {
  if (!imageUrl) throw new Error('JMCOMIC_IMAGE_SOURCE_MISSING')
  const agent = setting?.proxy ? new HttpsProxyAgent(setting.proxy) : undefined
  const candidates = [...new Set([imageUrl, ...(Array.isArray(imageUrls) ? imageUrls : [])].filter(Boolean))]
  let lastError = null
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        headers: imageHeaders(referer),
        ...(agent ? { agent } : {}),
        timeout: 30000
      })
      const buffer = await response.buffer()
      const contentType = response.headers.get('content-type') || ''
      if (!response.ok) throw new Error(`JMCOMIC_IMAGE_HTTP_${response.status}`)
      const decoded = await decodeJmImage({ buffer, photoId, scrambleId, pageFileName })
      return {
        buffer: decoded.buffer,
        httpStatus: response.status,
        contentType: decoded.contentType || contentType || ''
      }
    } catch (error) {
      lastError = error
    }
  }
  if (browserFetchBinary) {
    for (const candidate of candidates) {
      try {
        const browserResponse = await browserFetchBinary({ imageUrl: candidate, setting, referer })
        const status = Number(browserResponse.status) || 0
        if (status < 200 || status >= 300) throw new Error(`JMCOMIC_IMAGE_HTTP_${status}`)
        const decoded = await decodeJmImage({
          buffer: browserResponse.buffer,
          photoId,
          scrambleId,
          pageFileName
        })
        return {
          buffer: decoded.buffer,
          httpStatus: status,
          contentType: decoded.contentType || browserResponse.contentType || ''
        }
      } catch (error) {
        lastError = error
      }
    }
  }
  throw lastError || new Error('JMCOMIC_IMAGE_UNAVAILABLE')
}

module.exports = {
  extractJmComicId,
  searchJmComic,
  getJmComicInfo,
  getJmComicRecoveryManifest,
  fetchJmComicImage,
  parseSearchResults,
  parseJmApiSearchResults,
  parseAlbumInfo,
  parseJmApiAlbumInfo,
  parseJmApiChapter,
  parsePhotoManifest,
  decryptJmApiData,
  getJmImageSegmentCount,
  decodeJmImage,
  setJmComicBrowserFetchers
}

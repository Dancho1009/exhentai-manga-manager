const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const fetch = require('node-fetch')
const { HttpsProxyAgent } = require('https-proxy-agent')

const NHENTAI_BASE_URL = 'https://nhentai.net'
const EHTAG_DATABASE_URL = 'https://raw.githubusercontent.com/EhTagTranslation/DatabaseReleases/master/db.text.json.gz'
const EHTAG_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const SEARCH_PAGE_SIZE = 25
const SEARCH_RESULT_LIMIT = 5

const MANAGER_TAG_GROUPS = [
  'artist',
  'group',
  'language',
  'parody',
  'character',
  'female',
  'male',
  'mixed',
  'other',
  'cosplayer'
]

const DIRECT_NAMESPACE_MAP = {
  artist: 'artist',
  group: 'group',
  language: 'language',
  parody: 'parody',
  character: 'character',
  female: 'female',
  male: 'male',
  mixed: 'mixed',
  other: 'other',
  cosplayer: 'cosplayer'
}

const CATEGORY_MAP = {
  doujinshi: 'Doujinshi',
  manga: 'Manga',
  artistcg: 'Artist CG',
  gamecg: 'Game CG',
  nonh: 'Non-H',
  imageset: 'Image Set',
  western: 'Western',
  cosplay: 'Cosplay',
  asianporn: 'Asian Porn',
  misc: 'Misc'
}

const normalizeSearchText = (value) => {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

const assertNhentaiApiKey = (setting = {}) => {
  if (!String(setting.nhentaiApiKey || '').trim()) {
    throw new Error('NHENTAI_API_KEY_MISSING')
  }
}

const createAgent = (setting = {}) => {
  return setting.proxy ? new HttpsProxyAgent(setting.proxy) : undefined
}

const createFetchOptions = (setting = {}, extra = {}) => {
  const agent = createAgent(setting)
  return {
    ...extra,
    headers: {
      'User-Agent': 'exhentai-manga-manager/nhentai-metadata',
      'Authorization': `Key ${String(setting.nhentaiApiKey || '').trim()}`,
      'Accept': 'application/json',
      ...(extra.headers || {})
    },
    ...(agent ? { agent } : {})
  }
}

const createPlainFetchOptions = (setting = {}) => {
  const agent = createAgent(setting)
  return {
    headers: {
      'User-Agent': 'exhentai-manga-manager/nhentai-metadata',
      'Accept': 'application/json,application/gzip,*/*'
    },
    ...(agent ? { agent } : {})
  }
}

const fetchJson = async (url, options) => {
  const response = await fetch(url, options)
  const body = await response.text()

  if (!response.ok) {
    const message = response.status === 401 || response.status === 403
      ? `nhentai API authentication failed (${response.status})`
      : `HTTP ${response.status} ${response.statusText}`
    throw new Error(`${message} ${body.slice(0, 300)}`.trim())
  }

  return body ? JSON.parse(body) : null
}

const fetchBuffer = async (url, options) => {
  const response = await fetch(url, options)
  const body = await response.buffer()

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} ${body.toString('utf-8').slice(0, 300)}`.trim())
  }

  return body
}

const extractNhentaiId = (value) => {
  if (!value) return null
  const text = String(value)
  const urlMatch = /nhentai\.net\/g\/(\d+)/i.exec(text)
  if (urlMatch) return urlMatch[1]
  const fileMatch = /\bnhentai[-_\s]*(\d+)\b/i.exec(path.basename(text))
  if (fileMatch) return fileMatch[1]
  const plainIdMatch = /^\s*(\d{3,})\s*$/.exec(text)
  return plainIdMatch ? plainIdMatch[1] : null
}

const resolveNhentaiId = ({ id, url, filepath, title } = {}) => {
  return extractNhentaiId(id) ||
    extractNhentaiId(url) ||
    extractNhentaiId(filepath) ||
    extractNhentaiId(title)
}

const getGalleryTitle = (gallery = {}) => {
  return gallery.title?.pretty ||
    gallery.title?.english ||
    gallery.title?.japanese ||
    gallery.english_title ||
    gallery.japanese_title ||
    ''
}

const getGalleryJpnTitle = (gallery = {}) => {
  return gallery.title?.japanese ||
    gallery.japanese_title ||
    gallery.title?.pretty ||
    gallery.title?.english ||
    gallery.english_title ||
    ''
}

const createResultFromGallery = (gallery, confidence = 'exact') => {
  return {
    title: getGalleryTitle(gallery),
    url: `${NHENTAI_BASE_URL}/g/${gallery.id}/`,
    type: 'nhentai',
    id: String(gallery.id),
    confidence
  }
}

const buildQueryString = (params) => {
  return new URLSearchParams(params).toString()
}

const fetchGallery = async (galleryId, setting) => {
  assertNhentaiApiKey(setting)
  return await fetchJson(
    `${NHENTAI_BASE_URL}/api/v2/galleries/${galleryId}`,
    createFetchOptions(setting)
  )
}

const fetchSearch = async (query, setting) => {
  assertNhentaiApiKey(setting)
  return await fetchJson(
    `${NHENTAI_BASE_URL}/api/v2/search?${buildQueryString({
      query,
      sort: 'date',
      page: 1,
      per_page: SEARCH_PAGE_SIZE
    })}`,
    createFetchOptions(setting)
  )
}

const getEhtagCacheFile = (storePath) => {
  return path.join(storePath, 'nhentai', 'ehtag-db.json')
}

const parseEhtagDatabase = (buffer) => {
  let raw = buffer
  try {
    raw = zlib.gunzipSync(buffer)
  } catch {
    raw = buffer
  }

  const root = JSON.parse(raw.toString('utf-8'))
  const namespaces = {}
  for (const namespaceBlock of root.data || []) {
    const namespace = namespaceBlock.namespace || ''
    if (!namespace) continue
    namespaces[namespace] = {}
    for (const [rawTag, tagInfo] of Object.entries(namespaceBlock.data || {})) {
      namespaces[namespace][rawTag] = typeof tagInfo === 'object' && tagInfo
        ? tagInfo.name || ''
        : String(tagInfo || '')
    }
  }
  return namespaces
}

const createNamespaceIndex = (namespaces) => {
  const index = {}
  for (const [namespace, entries] of Object.entries(namespaces || {})) {
    index[namespace] = new Set(Object.keys(entries).map(key => key.toLowerCase()))
  }
  return index
}

const createEhtagDb = ({ loaded, source, namespaces = {}, error = '' }) => {
  return {
    loaded,
    source,
    namespaces,
    namespaceIndex: createNamespaceIndex(namespaces),
    error
  }
}

const readEhtagCache = async (storePath) => {
  try {
    const cache = JSON.parse(await fs.promises.readFile(getEhtagCacheFile(storePath), 'utf-8'))
    return cache?.namespaces ? cache : null
  } catch {
    return null
  }
}

const writeEhtagCache = async (storePath, namespaces) => {
  const cacheFile = getEhtagCacheFile(storePath)
  await fs.promises.mkdir(path.dirname(cacheFile), { recursive: true })
  const tempPath = `${cacheFile}.tmp`
  await fs.promises.writeFile(tempPath, JSON.stringify({
    cachedAt: new Date().toISOString(),
    namespaces
  }), 'utf-8')
  await fs.promises.rename(tempPath, cacheFile)
}

const cacheIsFresh = (cache) => {
  if (!cache?.cachedAt) return false
  const time = Date.parse(cache.cachedAt)
  return Number.isFinite(time) && Date.now() - time <= EHTAG_CACHE_TTL_MS
}

const loadEhtagDb = async (storePath, setting = {}) => {
  const cached = await readEhtagCache(storePath)
  if (cacheIsFresh(cached)) {
    return createEhtagDb({ loaded: true, source: 'cache', namespaces: cached.namespaces })
  }

  try {
    const buffer = await fetchBuffer(EHTAG_DATABASE_URL, createPlainFetchOptions(setting))
    const namespaces = parseEhtagDatabase(buffer)
    await writeEhtagCache(storePath, namespaces)
    return createEhtagDb({ loaded: true, source: 'network', namespaces })
  } catch (error) {
    if (cached?.namespaces) {
      return createEhtagDb({
        loaded: true,
        source: 'stale-cache',
        namespaces: cached.namespaces,
        error: error.message
      })
    }
    return createEhtagDb({ loaded: false, source: 'unavailable', error: error.message })
  }
}

const getTagsByType = (gallery, type) => {
  return (gallery.tags || [])
    .filter(tag => tag.type === type)
    .map(tag => tag.name)
}

const createEmptyManagerTags = () => {
  return MANAGER_TAG_GROUPS.reduce((result, namespace) => {
    result[namespace] = []
    return result
  }, {})
}

const hasTagInNamespace = (ehtagDb, namespace, rawName) => {
  if (!ehtagDb.loaded) return false
  const namespaceSet = ehtagDb.namespaceIndex[namespace]
  return namespaceSet ? namespaceSet.has(String(rawName || '').toLowerCase()) : false
}

const findTagNamespaces = (ehtagDb, rawName, candidates) => {
  return candidates.filter(namespace => hasTagInNamespace(ehtagDb, namespace, rawName))
}

const resolveNhentaiNamespace = (tag, ehtagDb) => {
  const rawType = String(tag.type || '').toLowerCase()
  const rawName = String(tag.name || '')

  if (rawType === 'category') return null
  if (DIRECT_NAMESPACE_MAP[rawType]) return DIRECT_NAMESPACE_MAP[rawType]

  if (rawType === 'tag' || rawType === 'mixed') {
    const matchedNamespaces = findTagNamespaces(ehtagDb, rawName, ['female', 'male', 'mixed', 'other'])
    if (matchedNamespaces.length > 0) return matchedNamespaces[0]
    return rawType === 'mixed' ? 'mixed' : 'other'
  }

  return 'other'
}

const pushUnique = (list, value) => {
  if (value && !list.includes(value)) list.push(value)
}

const groupTagsForManager = (gallery, ehtagDb) => {
  const groups = createEmptyManagerTags()
  for (const tag of gallery.tags || []) {
    const namespace = resolveNhentaiNamespace(tag, ehtagDb)
    if (!namespace) continue
    pushUnique(groups[namespace] || groups.other, tag.name)
  }
  return groups
}

const normalizeCategoryKey = (value) => {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

const resolveManagerCategory = (gallery) => {
  for (const category of getTagsByType(gallery, 'category')) {
    const mapped = CATEGORY_MAP[normalizeCategoryKey(category)]
    if (mapped) return mapped
  }
  return 'Doujinshi'
}

const toTimestamp = (value) => {
  if (!value) return undefined
  if (typeof value === 'number') return value > 9999999999 ? Math.floor(value / 1000) : Math.floor(value)
  const time = Date.parse(value)
  return Number.isFinite(time) ? Math.floor(time / 1000) : undefined
}

const toManagerMetadata = (gallery, ehtagDb) => {
  const metadata = {
    url: `${NHENTAI_BASE_URL}/g/${gallery.id}/`,
    title: gallery.title?.english || gallery.title?.pretty || getGalleryTitle(gallery),
    title_jpn: getGalleryJpnTitle(gallery),
    category: resolveManagerCategory(gallery),
    tags: groupTagsForManager(gallery, ehtagDb),
    status: 'tagged'
  }

  const filecount = gallery.num_pages || gallery.page_count || (Array.isArray(gallery.pages) ? gallery.pages.length : undefined)
  if (filecount) metadata.filecount = +filecount

  const posted = toTimestamp(gallery.upload_date || gallery.uploaded_at || gallery.created_at || gallery.createdAt)
  if (posted) metadata.posted = posted

  return metadata
}

const titleMatchesQuery = (item, query) => {
  const normalizedQuery = normalizeSearchText(query)
  if (!normalizedQuery) return true
  const titles = [
    item.english_title,
    item.japanese_title,
    item.title?.english,
    item.title?.japanese,
    item.title?.pretty
  ].map(normalizeSearchText)
  return titles.some(title => title.includes(normalizedQuery))
}

const searchNhentai = async ({ title, filepath, setting } = {}) => {
  const exactId = resolveNhentaiId({ title, filepath })
  if (exactId) {
    const gallery = await fetchGallery(exactId, setting)
    return [createResultFromGallery(gallery, 'exact')]
  }

  const query = String(title || '').trim()
  if (!query) return []

  const result = await fetchSearch(query, setting)
  return (result?.result || [])
    .filter(item => titleMatchesQuery(item, query))
    .slice(0, SEARCH_RESULT_LIMIT)
    .map(item => createResultFromGallery(item, 'title'))
}

const getNhentaiMetadata = async ({ id, url, filepath, title, setting, storePath } = {}) => {
  const galleryId = resolveNhentaiId({ id, url, filepath, title })
  if (!galleryId) return null

  const gallery = await fetchGallery(galleryId, setting)
  const ehtagDb = await loadEhtagDb(storePath, setting)
  return toManagerMetadata(gallery, ehtagDb)
}

module.exports = {
  searchNhentai,
  getNhentaiMetadata,
  extractNhentaiId,
  toManagerMetadata,
  loadEhtagDb
}

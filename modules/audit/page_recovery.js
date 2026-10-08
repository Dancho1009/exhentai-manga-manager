const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')
const { nanoid } = require('nanoid')
const AdmZip = require('adm-zip')
const sharp = require('sharp')
const yauzl = require('yauzl')
const {
  buildCookie,
  buildGalleryUrl,
  extractGalleryIdentity,
  getGalleryPage,
  requestText,
  requestBinary
} = require('../ehentai.js')
const { inspectBookHealth, extractImageSequenceNumber } = require('./archive_inspector.js')
const { getBookFileSnapshot } = require('./ehviewer_repair.js')
const { extractNhentaiId, getNhentaiRecoveryManifest, fetchNhentaiImage } = require('../nhentai.js')
const { extractJmComicId, getJmComicRecoveryManifest, fetchJmComicImage } = require('../jmcomic.js')

const isJmComicUrl = value => /(?:18comic|jmcomic|jm365|jm[-.]?comic)/i.test(String(value || ''))

const IMAGE_MIME_EXTENSIONS = new Map([
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/avif', '.avif'],
  ['image/gif', '.gif']
])

const MAX_BOUNDARY_PAGES = 200
const PAGE_RECOVERY_REMAINING_PAGES = 'PAGE_RECOVERY_REMAINING_PAGES'

const normalizeEntryPath = value => String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '')
const normalizePageNumbers = values => [...new Set((Array.isArray(values) ? values : [])
  .map(value => Number.parseInt(value, 10))
  .filter(value => Number.isSafeInteger(value) && value >= 1))].sort((a, b) => a - b)

const normalizeSourceOffset = value => {
  const offset = Number(value ?? 0)
  if (!Number.isSafeInteger(offset) || Math.abs(offset) > 1000) throw new Error('PAGE_RECOVERY_SOURCE_OFFSET_INVALID')
  return offset
}

const resolveSourcePageNumber = (pageNumber, sourceOffset) => {
  const sourcePageNumber = pageNumber + sourceOffset
  if (!Number.isSafeInteger(sourcePageNumber) || sourcePageNumber < 1) {
    throw new Error(`PAGE_RECOVERY_SOURCE_PAGE_INVALID:${pageNumber}:${sourcePageNumber}`)
  }
  return sourcePageNumber
}

const getMappedLocalPageCount = (onlinePageCount, sourceOffset) => {
  const count = Number(onlinePageCount)
  return Number.isSafeInteger(count) && count > 0 ? Math.max(0, count - sourceOffset) : 0
}

const decodeHtml = value => String(value || '')
  .replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))

const absoluteUrl = (value, baseUrl) => {
  try {
    return new URL(decodeHtml(value), baseUrl).toString()
  } catch {
    return null
  }
}

const parseGalleryPageManifest = ({ html, galleryUrl }) => {
  const pages = []
  const seen = new Set()
  const anchorPattern = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi
  for (const match of String(html || '').matchAll(anchorPattern)) {
    const pageUrl = absoluteUrl(match[1], galleryUrl)
    if (!pageUrl || !/[\/]s\/[0-9a-z]+/i.test(new URL(pageUrl).pathname) || seen.has(pageUrl)) continue
    seen.add(pageUrl)
    const pageMatch = path.posix.basename(new URL(pageUrl).pathname).match(/-(\d+)$/)
    pages.push({ index: pages.length + 1, pageNumber: pageMatch ? Number(pageMatch[1]) : pages.length + 1, pageUrl })
  }
  return pages
}

const parseGalleryPagination = ({ html, galleryUrl }) => {
  const pageUrls = new Map([[0, new URL(galleryUrl).toString()]])
  const anchorPattern = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi
  for (const match of String(html || '').matchAll(anchorPattern)) {
    const pageUrl = absoluteUrl(match[1], galleryUrl)
    if (!pageUrl) continue
    try {
      const parsed = new URL(pageUrl)
      const pageIndex = parsed.searchParams.get('p')
      if (/^\d+$/.test(pageIndex || '')) pageUrls.set(Number(pageIndex), pageUrl)
    } catch {
      // Ignore malformed pagination links and keep the first page.
    }
  }

  const text = String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
  const showing = text.match(/Showing\s+(\d+)\s*-\s*(\d+)\s+of\s+(\d+)\s+images/i)
  const first = showing ? Number(showing[1]) : 0
  const last = showing ? Number(showing[2]) : 0
  const total = showing ? Number(showing[3]) : 0
  const pageSize = last >= first && first > 0 ? last - first + 1 : 0
  const pageCount = total > 0 && pageSize > 0
    ? Math.ceil(total / pageSize)
    : (pageUrls.size ? Math.max(...pageUrls.keys()) + 1 : 1)
  const base = new URL(galleryUrl)
  for (let index = 0; index < pageCount; index += 1) {
    if (pageUrls.has(index)) continue
    const pageUrl = new URL(base.toString())
    if (index > 0) pageUrl.searchParams.set('p', String(index))
    pageUrls.set(index, pageUrl.toString())
  }
  return {
    total,
    pageSize,
    pageCount,
    pageUrls: [...pageUrls.entries()].sort(([left], [right]) => left - right).map(([, value]) => value)
  }
}

const parseImagePageSource = ({ html, pageUrl }) => {
  const patterns = [
    /<img\b[^>]*\bid\s*=\s*["']img["'][^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/i,
    /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*\bid\s*=\s*["']img["'][^>]*>/i,
    /<a\b[^>]*\bhref\s*=\s*["']([^"']+\.(?:jpg|jpeg|png|webp|avif|gif)(?:\?[^"']*)?)["'][^>]*>/i
  ]
  for (const pattern of patterns) {
    const match = String(html || '').match(pattern)
    const imageUrl = match ? absoluteUrl(match[1], pageUrl) : null
    if (imageUrl) return imageUrl
  }
  return null
}

const hashBuffer = buffer => createHash('sha256').update(buffer).digest('hex')

const getImageExtension = ({ contentType, imageUrl }) => {
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (IMAGE_MIME_EXTENSIONS.has(mime)) return IMAGE_MIME_EXTENSIONS.get(mime)
  const extension = path.extname(new URL(imageUrl).pathname).toLowerCase()
  return IMAGE_MIME_EXTENSIONS.has(`image/${extension.slice(1)}`) ? extension : '.jpg'
}

const getSequenceTemplate = (imagePaths, directory) => {
  const values = imagePaths
    .filter(value => path.posix.dirname(normalizeEntryPath(value)) === directory)
    .map(value => normalizeEntryPath(value))
    .map(value => {
      const basename = path.posix.basename(value)
      const match = basename.match(/^(.*?)(\d+)(\.[^.]+)$/)
      return match ? { path: value, prefix: match[1], width: match[2].length, suffix: match[3] } : null
    })
    .filter(Boolean)
  if (values.length < 3) return null
  const first = values[0]
  if (!values.every(value => value.prefix === first.prefix)) return null
  return {
    directory,
    prefix: first.prefix,
    width: first.width,
    suffix: first.suffix
  }
}

const createPreviewBuffer = buffer => sharp(buffer, { failOnError: false })
  .resize(720, 1020, { fit: 'inside', withoutEnlargement: true })
  .jpeg({ quality: 88 })
  .toBuffer()

const resolveLocalPageContext = ({ health, targetPath, pageNumber }) => {
  const directory = path.posix.dirname(normalizeEntryPath(targetPath))
  const pageEntries = new Map((health.imagePaths || [])
    .map(normalizeEntryPath)
    .filter(value => path.posix.dirname(value) === directory)
    .map(value => [extractImageSequenceNumber(value), value])
    .filter(([number]) => number !== null))
  // Show the immediate numeric neighbors so a consecutive gap remains visibly uncertain.
  const group = (health.imageSequence?.gaps || []).find(item => item.directory === directory && (item.missingNumbers || []).includes(pageNumber))
  const contextFor = number => {
    const entryPath = pageEntries.get(number)
    const base = { pageNumber: number, path: entryPath || null, status: 'missing', previewDataUrl: null }
    if (entryPath) return { ...base, status: 'unreadable' }
    if (!group || number < (group.recoveryFirst ?? group.first) || number > (group.recoveryLast ?? group.last)) return { ...base, status: 'boundary' }
    return base
  }
  return {
    directory,
    previous: contextFor(pageNumber - 1),
    next: contextFor(pageNumber + 1)
  }
}

const readLocalPagePreviews = async (book, entryPaths) => {
  const previews = new Map()
  const pending = new Set(entryPaths)
  const capture = async (entryPath, readBuffer) => {
    try {
      const buffer = await createPreviewBuffer(await readBuffer())
      previews.set(entryPath, `data:image/jpeg;base64,${buffer.toString('base64')}`)
    } catch {
      previews.set(entryPath, null)
    }
    pending.delete(entryPath)
  }
  if (book.type === 'folder') {
    const root = path.resolve(book.filepath)
    for (const entryPath of pending) {
      await capture(entryPath, async () => {
        const filepath = path.resolve(root, ...entryPath.split('/'))
        const relative = path.relative(root, filepath)
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('PAGE_RECOVERY_LOCAL_PATH_INVALID')
        return await fs.promises.readFile(filepath)
      })
    }
    return previews
  }
  if (!pending.size) return previews
  const zipfile = await new Promise((resolve, reject) => {
    yauzl.open(book.filepath, { lazyEntries: true, autoClose: true }, (error, zip) => error ? reject(error) : resolve(zip))
  })
  await new Promise((resolve, reject) => {
    zipfile.on('error', reject)
    zipfile.on('end', resolve)
    zipfile.on('entry', async entry => {
      const entryPath = normalizeEntryPath(entry.fileName)
      if (pending.has(entryPath)) {
        await capture(entryPath, async () => {
          const stream = await new Promise((resolveStream, rejectStream) => {
            zipfile.openReadStream(entry, (error, value) => error ? rejectStream(error) : resolveStream(value))
          })
          const chunks = []
          for await (const chunk of stream) chunks.push(chunk)
          return Buffer.concat(chunks)
        })
      }
      if (pending.size) zipfile.readEntry()
      else {
        zipfile.close()
        resolve()
      }
    })
    zipfile.readEntry()
  }).finally(() => zipfile.close())
  return previews
}

const linkFetchedNeighborPages = candidates => {
  const byPageNumber = new Map(candidates.map(candidate => [candidate.pageNumber, candidate]))
  for (const candidate of candidates) {
    for (const [direction, offset] of [['previous', -1], ['next', 1]]) {
      const neighbor = byPageNumber.get(candidate.pageNumber + offset)
      if (!neighbor) continue
      candidate.localContext[direction] = {
        pageNumber: neighbor.pageNumber,
        sourcePageNumber: neighbor.sourcePageNumber,
        path: neighbor.targetPath,
        status: 'fetched',
        previewDataUrl: neighbor.previewDataUrl
      }
    }
  }
}

const buildRecoveryHealth = (health, onlinePageCount = 0) => {
  const sequence = health.imageSequence || {}
  const groups = sequence.checkedGroups || sequence.gaps || []
  const checkedGroups = groups.map(group => {
    const leadingCount = group.first > 1 ? group.first - 1 : 0
    const trailingCount = groups.length === 1 && group.first >= 1 && Number.isSafeInteger(onlinePageCount)
      ? Math.max(0, onlinePageCount - group.last) : 0
    const leadingPages = leadingCount > 0 && leadingCount <= MAX_BOUNDARY_PAGES
      ? Array.from({ length: leadingCount }, (_value, index) => index + 1) : []
    const trailingPages = trailingCount > 0 && trailingCount <= MAX_BOUNDARY_PAGES
      ? Array.from({ length: trailingCount }, (_value, index) => group.last + index + 1) : []
    const leadingRanges = leadingPages.length
      ? [{ start: 1, end: group.first - 1, count: leadingPages.length }] : []
    const trailingRanges = trailingPages.length
      ? [{ start: group.last + 1, end: onlinePageCount, count: trailingPages.length }] : []
    return {
      ...group,
      leadingPages,
      trailingPages,
      recoveryFirst: leadingPages.length ? 1 : group.first,
      recoveryLast: trailingPages.length ? onlinePageCount : group.last,
      missingCount: group.missingCount + leadingPages.length + trailingPages.length,
      missingRanges: [...leadingRanges, ...(group.missingRanges || []), ...trailingRanges],
      missingNumbers: normalizePageNumbers([...leadingPages, ...(group.missingNumbers || []), ...trailingPages])
    }
  })
  const gaps = checkedGroups.filter(group => group.missingCount > 0)
  return {
    ...health,
    imageSequence: {
      ...sequence,
      checkedGroups,
      gaps,
      gapCount: gaps.reduce((total, group) => total + group.missingCount, 0)
    }
  }
}

const getRecoveryPageOptions = health => ({
  availablePages: normalizePageNumbers((health.imageSequence?.gaps || []).flatMap(group => group.missingNumbers || [])),
  leadingPages: normalizePageNumbers((health.imageSequence?.gaps || []).flatMap(group => group.leadingPages || [])),
  trailingPages: normalizePageNumbers((health.imageSequence?.gaps || []).flatMap(group => group.trailingPages || []))
})

const assessPageMapping = ({ health, onlinePageCount, pageNumbers }) => {
  const selectedPages = normalizePageNumbers(pageNumbers)
  const gaps = health.imageSequence?.gaps || []
  const selectedGroups = gaps.filter(group => selectedPages.some(page => (group.missingNumbers || []).includes(page)))
  const allSelectedPagesCovered = selectedPages.length > 0 && selectedPages.every(page => selectedGroups.some(group => (group.missingNumbers || []).includes(page)))
  const anchored = allSelectedPagesCovered && selectedGroups.length === 1 &&
    selectedGroups.every(group => group.first === 1 || group.last === onlinePageCount)
  const exact = anchored && gaps.every(group => group.last === onlinePageCount && group.first === 1) &&
    health.pageCount + health.imageSequence.gapCount === onlinePageCount
  return {
    supported: anchored,
    confidence: exact ? 'exact' : anchored ? 'anchored' : 'uncertain'
  }
}

const assessBatchPageMapping = ({ health, onlinePageCount, pageNumbers }) => {
  const recoveryHealth = buildRecoveryHealth(health, onlinePageCount)
  const mapping = assessPageMapping({ health: recoveryHealth, onlinePageCount, pageNumbers })
  const pageOptions = getRecoveryPageOptions(recoveryHealth)
  const selectedPages = normalizePageNumbers(pageNumbers)
  const selectedTrailingPages = selectedPages.filter(page => pageOptions.trailingPages.includes(page))
  const batchSupported = mapping.supported && selectedTrailingPages.length === 0
  return {
    ...mapping,
    batchSupported,
    batchReason: batchSupported ? null : selectedTrailingPages.length ? 'PAGE_RECOVERY_BATCH_TRAILING_UNCONFIRMED' : 'PAGE_RECOVERY_BATCH_MAPPING_UNCERTAIN',
    leadingPages: pageOptions.leadingPages,
    trailingPages: pageOptions.trailingPages,
    selectedTrailingPages
  }
}

const resolveTargetPath = ({ health, pageNumber }) => {
  const groups = (health.imageSequence?.gaps || []).filter(group => (group.missingNumbers || []).includes(pageNumber))
  if (groups.length !== 1) throw new Error('PAGE_RECOVERY_TARGET_AMBIGUOUS')
  const group = groups[0]
  const template = getSequenceTemplate(health.imagePaths || [], group.directory)
  if (!template) throw new Error('PAGE_RECOVERY_FILENAME_TEMPLATE_UNCERTAIN')
  const basename = `${template.prefix}${String(pageNumber).padStart(template.width, '0')}`
  return normalizeEntryPath(path.posix.join(template.directory, `${basename}${template.suffix}`))
}

const createRecoveryId = () => `${new Date().toISOString().replace(/[:.]/g, '-')}_${nanoid(8)}`

const ensureRecoveryPath = value => {
  const resolved = path.resolve(value)
  if (!resolved) throw new Error('PAGE_RECOVERY_PATH_INVALID')
  return resolved
}

const readJson = async filepath => JSON.parse(await fs.promises.readFile(filepath, 'utf8'))
const writeJson = async (filepath, value) => {
  await fs.promises.mkdir(path.dirname(filepath), { recursive: true })
  await fs.promises.writeFile(filepath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
const createSessionSummary = session => ({
  recoveryId: session.recoveryId,
  reportId: session.reportId,
  anomalyId: String(session.anomalyId || ''),
  bookId: String(session.bookId || ''),
  filepath: session.filepath,
  bookType: session.bookType,
  source: session.source || null,
  sourceOffset: normalizeSourceOffset(session.sourceOffset),
  snapshot: session.snapshot || null,
  online: session.online || null,
  status: session.status,
  error: session.error || null,
  writeBackSupported: session.writeBackSupported === true,
  mappingConfidence: session.mappingConfidence || 'unknown',
  batchWriteBackSupported: session.batchWriteBackSupported === true,
  batchWriteBackReason: session.batchWriteBackReason || null,
  remainingMissingPages: normalizePageNumbers(session.remainingMissingPages),
  appliedAt: session.appliedAt || null,
  selectedPages: normalizePageNumbers(session.selectedPages),
  availablePages: normalizePageNumbers(session.availablePages),
  leadingPages: normalizePageNumbers(session.leadingPages),
  trailingPages: normalizePageNumbers(session.trailingPages),
  candidatePages: Array.isArray(session.candidates)
    ? normalizePageNumbers(session.candidates.map(candidate => candidate.pageNumber))
    : [],
  candidateCount: Array.isArray(session.candidates) ? session.candidates.length : 0
})
const getSessionSummaryPath = jobDir => path.join(jobDir, 'summary.json')

const getRecoveryRecordKey = summary => {
  const bookId = String(summary?.bookId || '').trim()
  if (bookId) return `book:${bookId}`
  return `path:${normalizeEntryPath(summary?.filepath || '')}`
}

const listRecoveryRecords = async storePath => {
  const jobsPath = path.join(storePath, 'audit', 'page-recovery', 'jobs')
  const entries = await fs.promises.readdir(jobsPath, { withFileTypes: true }).catch(() => [])
  const records = []
  for (const entry of entries.filter(item => item.isDirectory())) {
    const record = await readSessionRecord(path.join(jobsPath, entry.name), entry.name)
    if (record?.summary) records.push(record)
  }
  return records
}

const latestRecoveryRecords = (records, keyOf = record => getRecoveryRecordKey(record.summary)) => {
  const latest = new Map()
  for (const record of records) {
    const key = keyOf(record)
    const current = latest.get(key)
    if (!current || current.mtimeMs < record.mtimeMs) latest.set(key, record)
  }
  return [...latest.values()]
}

const readPersistedRemainingMissingPages = async statePath => {
  const stat = await fs.promises.stat(statePath).catch(() => null)
  if (!stat || stat.size === 0) return []
  const length = Math.min(Number(stat.size), 128 * 1024)
  const handle = await fs.promises.open(statePath, 'r').catch(() => null)
  if (!handle) return []
  try {
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, Math.max(0, stat.size - length))
    const text = buffer.toString('utf8')
    const marker = '"remainingMissingPages"'
    const markerIndex = text.lastIndexOf(marker)
    if (markerIndex < 0) return []
    const start = text.indexOf('[', markerIndex + marker.length)
    const end = text.indexOf(']', start + 1)
    if (start < 0 || end < 0) return []
    return normalizePageNumbers(JSON.parse(text.slice(start, end + 1)))
  } catch {
    return []
  } finally {
    await handle.close().catch(() => {})
  }
}

const normalizePendingSummary = (summary, remainingMissingPages) => {
  const remaining = normalizePageNumbers(remainingMissingPages)
  if (!remaining.length) return summary
  return {
    ...summary,
    status: 'awaiting-confirmation',
    error: null,
    writeBackSupported: false,
    mappingConfidence: 'unknown',
    batchWriteBackSupported: false,
    batchWriteBackReason: PAGE_RECOVERY_REMAINING_PAGES,
    remainingMissingPages: remaining,
    selectedPages: remaining,
    availablePages: remaining,
    candidateCount: 0
  }
}

const readSessionRecord = async (jobDir, recoveryId) => {
  const statePath = path.join(jobDir, 'state.json')
  const summaryPath = getSessionSummaryPath(jobDir)
  const stateStat = await fs.promises.stat(statePath).catch(() => null)
  if (!stateStat) return null
  const storedSummary = await readJson(summaryPath).catch(() => null)
  if (storedSummary) {
    const remaining = Array.isArray(storedSummary.remainingMissingPages)
      ? normalizePageNumbers(storedSummary.remainingMissingPages)
      : storedSummary.status === 'completed' ? await readPersistedRemainingMissingPages(statePath) : []
    const summary = storedSummary.status === 'completed' && remaining.length
      ? normalizePendingSummary(storedSummary, remaining)
      : { ...storedSummary, remainingMissingPages: remaining }
    return { summary, statePath, mtimeMs: stateStat.mtimeMs, session: null }
  }
  const session = await readJson(statePath).catch(() => null)
  if (!session) return null
  const stored = createSessionSummary(session)
  const summary = session.status === 'completed' && stored.remainingMissingPages.length
    ? normalizePendingSummary(stored, stored.remainingMissingPages)
    : stored
  void writeJson(summaryPath, summary).catch(() => {})
  return { summary, statePath, mtimeMs: stateStat.mtimeMs, session }
}
const toSerializableSession = session => {
  const serialized = JSON.parse(JSON.stringify(session))
  serialized.sourceOffset = normalizeSourceOffset(serialized.sourceOffset)
  if (Number(serialized.online?.pageCount) > 0) {
    serialized.online.localPageCount = getMappedLocalPageCount(serialized.online.pageCount, serialized.sourceOffset)
    serialized.online.sourceOffset = serialized.sourceOffset
  }
  for (const candidate of serialized.candidates || []) {
    candidate.sourcePageNumber ??= candidate.pageNumber + serialized.sourceOffset
  }
  return serialized
}
const isContinuablePageRecoveryReport = report => report?.staleReason === 'page-recovery'
const isPendingRecoverySummary = summary => ['awaiting-confirmation', 'failed'].includes(summary?.status) ||
  (summary?.status === 'completed' && normalizePageNumbers(summary?.remainingMissingPages).length > 0)

const listPendingRecoverySummaries = async storePath => {
  const records = latestRecoveryRecords(await listRecoveryRecords(storePath))
  return records
    .map(record => record.summary)
    .filter(summary => (summary.status === 'awaiting-confirmation' || summary.status === 'completed') &&
      normalizePageNumbers(summary.remainingMissingPages).length > 0)
}

class PageRecoveryManager {
  constructor({ storePath, Manga, getSetting, sevenZipPath, getGalleryPage: galleryPageFetcher, requestText: textRequester, requestBinary: binaryRequester, getNhentaiRecoveryManifest: nhentaiManifestFetcher, requestNhentaiImage: nhentaiImageRequester, getJmComicRecoveryManifest: jmcomicManifestFetcher, requestJmComicImage: jmcomicImageRequester }) {
    this.storePath = storePath
    this.Manga = Manga
    this.getSetting = getSetting
    this.sevenZipPath = sevenZipPath
    this.getGalleryPage = galleryPageFetcher || getGalleryPage
    this.requestText = textRequester || requestText
    this.requestBinary = binaryRequester || requestBinary
    this.getNhentaiRecoveryManifest = nhentaiManifestFetcher || getNhentaiRecoveryManifest
    this.requestNhentaiImage = nhentaiImageRequester || fetchNhentaiImage
    this.getJmComicRecoveryManifest = jmcomicManifestFetcher || getJmComicRecoveryManifest
    this.requestJmComicImage = jmcomicImageRequester || fetchJmComicImage
    this.sessions = new Map()
  }

  getJobDir(recoveryId) {
    return path.join(this.storePath, 'audit', 'page-recovery', 'jobs', recoveryId)
  }

  async saveSession(session) {
    const serializable = toSerializableSession(session)
    const jobDir = this.getJobDir(serializable.recoveryId)
    await writeJson(path.join(jobDir, 'state.json'), serializable)
    await writeJson(getSessionSummaryPath(jobDir), createSessionSummary(serializable)).catch(() => {})
    this.sessions.set(serializable.recoveryId, serializable)
    return serializable
  }

  async getSession(recoveryId) {
    const normalized = String(recoveryId || '').trim()
    if (!normalized) throw new Error('PAGE_RECOVERY_ID_MISSING')
    if (this.sessions.has(normalized)) return this.sessions.get(normalized)
    const stored = await readJson(path.join(this.getJobDir(normalized), 'state.json')).catch(() => null)
    if (!stored) throw new Error('PAGE_RECOVERY_SESSION_MISSING')
    const session = toSerializableSession(stored)
    this.sessions.set(normalized, session)
    return session
  }

  async getLatestSession({ reportId, anomalyId, recoveryId } = {}) {
    const requestedReportId = String(reportId || '').trim()
    const requestedAnomalyId = String(anomalyId || '').trim()
    const jobsPath = path.join(this.storePath, 'audit', 'page-recovery', 'jobs')
    const candidates = []
    const requestedRecoveryId = String(recoveryId || '').trim()
    if (requestedRecoveryId) {
      const record = await readSessionRecord(this.getJobDir(requestedRecoveryId), requestedRecoveryId)
      if (record && String(record.summary.anomalyId) === requestedAnomalyId && isPendingRecoverySummary(record.summary)) candidates.push(record)
    } else {
      const entries = await fs.promises.readdir(jobsPath, { withFileTypes: true }).catch(() => [])
      for (const entry of entries.filter(item => item.isDirectory())) {
        const record = await readSessionRecord(path.join(jobsPath, entry.name), entry.name)
        if (!record || String(record.summary.anomalyId) !== requestedAnomalyId || !isPendingRecoverySummary(record.summary)) continue
        candidates.push(record)
      }
    }
    const latestRecord = candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)[0]
    const stored = latestRecord?.session || (latestRecord ? await readJson(latestRecord.statePath).catch(() => null) : null)
    if (!stored) return null
    const latest = toSerializableSession(stored)
    const book = await this.Manga.findByPk(latest.bookId, { raw: true }).catch(() => null)
    if (!book || book.filepath !== latest.filepath) return null
    const currentSnapshot = await getBookFileSnapshot(book).catch(() => null)
    const legacyRemaining = latest.status === 'completed' ? normalizePageNumbers(latest.remainingMissingPages) : []
    const legacyPending = legacyRemaining.length > 0
    if (!currentSnapshot) return null
    if (!legacyPending && (Number(currentSnapshot.bundleSize) !== Number(latest.snapshot?.bundleSize) || Number(currentSnapshot.mtimeMs) !== Number(latest.snapshot?.mtimeMs))) return null
    const health = legacyPending
      ? await inspectBookHealth(book, { sevenZipPath: this.sevenZipPath }).catch(() => null)
      : latest.local?.sequence
      ? {
          pageCount: Number(latest.local.pageCount) || 0,
          imagePaths: latest.local.imagePaths || [],
          imageSequence: latest.local.sequence
        }
      : await inspectBookHealth(book, { sevenZipPath: this.sevenZipPath }).catch(() => null)
    if (!health) return null
    if (legacyPending) latest.local = { pageCount: health.pageCount, sequence: health.imageSequence }
    const localPageCount = getMappedLocalPageCount(latest.online?.pageCount, latest.sourceOffset)
    const recoveryHealth = buildRecoveryHealth(health, localPageCount)
    const selectedPages = legacyPending ? legacyRemaining : normalizePageNumbers(latest.selectedPages)
    const availablePages = new Set(getRecoveryPageOptions(recoveryHealth).availablePages)
    if (!selectedPages.length || (latest.status === 'awaiting-confirmation' && selectedPages.some(page => !availablePages.has(page)))) return null
    const hasOnlinePageCount = localPageCount > 0
    const mapping = hasOnlinePageCount
      ? assessPageMapping({ health: recoveryHealth, onlinePageCount: localPageCount, pageNumbers: selectedPages })
      : { supported: false, confidence: 'unknown' }
    const batchMapping = hasOnlinePageCount
      ? assessBatchPageMapping({ health, onlinePageCount: localPageCount, pageNumbers: selectedPages })
      : { batchSupported: false, batchReason: 'PAGE_RECOVERY_BATCH_MAPPING_UNCERTAIN' }
    const previousReportId = String(latest.reportId || '')
    const previousStatus = latest.status
    const previousSelectedPages = JSON.stringify(latest.selectedPages || [])
    const previousOnline = JSON.stringify(latest.online || {})
    const previousBatchSupport = latest.batchWriteBackSupported
    const previousBatchReason = latest.batchWriteBackReason || null
    const previousRemaining = JSON.stringify(latest.remainingMissingPages || [])
    const previousCandidateCount = Array.isArray(latest.candidates) ? latest.candidates.length : 0
    if (legacyPending) {
      latest.status = 'awaiting-confirmation'
      latest.error = null
      latest.snapshot = currentSnapshot
      latest.candidates = []
      latest.remainingMissingPages = selectedPages
      latest.availablePages = selectedPages
      latest.writeBackSupported = false
      latest.mappingConfidence = 'unknown'
      latest.batchWriteBackSupported = false
      latest.batchWriteBackReason = PAGE_RECOVERY_REMAINING_PAGES
    }
    latest.selectedPages = selectedPages
    if (!legacyPending) {
      latest.writeBackSupported = mapping.supported
      latest.mappingConfidence = mapping.confidence
      latest.batchWriteBackSupported = batchMapping.batchSupported
      latest.batchWriteBackReason = batchMapping.batchReason || null
      latest.availablePages = [...availablePages]
    }
    latest.online = { ...latest.online, mappingConfirmed: mapping.supported }
    if (requestedReportId) latest.reportId = requestedReportId
    const changed = previousStatus !== latest.status ||
      previousReportId !== String(latest.reportId || '') ||
      previousSelectedPages !== JSON.stringify(selectedPages) ||
      previousOnline !== JSON.stringify(latest.online) ||
      previousBatchSupport !== latest.batchWriteBackSupported ||
      previousBatchReason !== latest.batchWriteBackReason ||
      previousRemaining !== JSON.stringify(latest.remainingMissingPages || []) ||
      previousCandidateCount !== (Array.isArray(latest.candidates) ? latest.candidates.length : 0)
    if (changed) await this.saveSession(latest)
    this.sessions.set(latest.recoveryId, latest)
    return toSerializableSession(latest)
  }

  async listLatestSessionSummaries({ reportId, anomalyIds = [] } = {}) {
    const requestedReportId = String(reportId || '').trim()
    const requestedAnomalyIds = new Set((Array.isArray(anomalyIds) ? anomalyIds : []).map(value => String(value)))
    if (!requestedAnomalyIds.size) return []
    const jobsPath = path.join(this.storePath, 'audit', 'page-recovery', 'jobs')
    const entries = await fs.promises.readdir(jobsPath, { withFileTypes: true }).catch(() => [])
    const latestByAnomaly = new Map()
    for (const entry of entries.filter(item => item.isDirectory())) {
      const record = await readSessionRecord(path.join(jobsPath, entry.name), entry.name)
      const summary = record?.summary
      if (!summary || !isPendingRecoverySummary(summary) || !requestedAnomalyIds.has(String(summary.anomalyId))) continue
      const current = latestByAnomaly.get(String(summary.anomalyId))
      if (current && current.mtimeMs >= record.mtimeMs) continue
      latestByAnomaly.set(String(summary.anomalyId), { summary, mtimeMs: record.mtimeMs })
    }
    return [...latestByAnomaly.values()].map(({ summary }) => ({
      recoveryId: summary.recoveryId,
      reportId: requestedReportId || summary.reportId,
      previousReportId: requestedReportId && requestedReportId !== String(summary.reportId || '') ? summary.reportId : null,
      anomalyId: String(summary.anomalyId),
      status: summary.status,
      error: summary.error || null,
      writeBackSupported: summary.writeBackSupported === true,
      mappingConfidence: summary.mappingConfidence || 'unknown',
      batchWriteBackSupported: summary.batchWriteBackSupported == null ? null : summary.batchWriteBackSupported === true,
      batchWriteBackReason: summary.batchWriteBackReason || null,
      remainingMissingPages: normalizePageNumbers(summary.remainingMissingPages),
      selectedPages: normalizePageNumbers(summary.selectedPages),
      leadingPages: normalizePageNumbers(summary.leadingPages),
      trailingPages: normalizePageNumbers(summary.trailingPages),
      candidatePages: normalizePageNumbers(summary.candidatePages),
      candidateCount: Number(summary.candidateCount) || 0,
      source: summary.source || null,
      sourceOffset: normalizeSourceOffset(summary.sourceOffset)
    }))
  }

  resolveSource(anomaly, source, book = null, { sourceUrl = null, nhentaiId = null, jmcomicId = null } = {}) {
    const evidence = anomaly?.evidence || {}
    const currentUrl = String(sourceUrl || evidence.currentUrl || evidence.url || book?.url || '').trim()
    if (source === 'nhentai' || (source === 'current' && /nhentai\.net\/g\/\d+/i.test(currentUrl))) {
      const galleryId = extractNhentaiId(nhentaiId || currentUrl || book?.filepath || book?.title)
      if (!galleryId) throw new Error('PAGE_RECOVERY_SOURCE_MISSING')
      return {
        type: 'nhentai',
        id: galleryId,
        url: `https://nhentai.net/g/${galleryId}/`
      }
    }
    if (source === 'jmcomic' || (source === 'current' && /\/(?:album|photo)\/\d+/i.test(currentUrl) && isJmComicUrl(currentUrl))) {
      const galleryId = extractJmComicId(jmcomicId || currentUrl || book?.filepath || book?.title)
      if (!galleryId) throw new Error('PAGE_RECOVERY_SOURCE_MISSING')
      return {
        type: 'jmcomic',
        id: galleryId,
        url: currentUrl && /\/(?:album|photo)\/\d+/i.test(currentUrl)
          ? currentUrl
          : `https://18comic.vip/album/${galleryId}/`
      }
    }
    if (source === 'current') return { type: 'ehentai', url: currentUrl }
    if (source === 'ehviewer') {
      if (evidence.ehviewerUrl) return { type: 'ehentai', url: String(evidence.ehviewerUrl).trim() }
      const identity = evidence.ehviewer
      if (identity?.gid && identity?.token) return { type: 'ehentai', url: buildGalleryUrl('exhentai', identity.gid, identity.token) }
    }
    throw new Error('PAGE_RECOVERY_SOURCE_MISSING')
  }

  async getRecoveryBook({ report, anomalyId, source, sourceUrl, nhentaiId, jmcomicId }) {
    if (!report?.reportId || (report.stale && !isContinuablePageRecoveryReport(report))) throw new Error('PAGE_RECOVERY_REPORT_INVALID')
    const anomaly = (report.anomalies || []).find(item => String(item.id) === String(anomalyId))
    if (!anomaly || anomaly.type !== 'archive-image-sequence-gap' || !anomaly.bookId) throw new Error('PAGE_RECOVERY_ANOMALY_INVALID')
    const book = await this.Manga.findByPk(anomaly.bookId, { raw: true })
    if (!book?.filepath) throw new Error('PAGE_RECOVERY_BOOK_MISSING')
    if (!['folder', 'zip'].includes(book.type)) throw new Error('PAGE_RECOVERY_FORMAT_UNSUPPORTED')
    const sourceInfo = this.resolveSource(anomaly, source, book, { sourceUrl, nhentaiId, jmcomicId })
    const identity = sourceInfo.type === 'ehentai' ? extractGalleryIdentity(sourceInfo.url) : null
    if (sourceInfo.type === 'ehentai' && !identity) throw new Error('PAGE_RECOVERY_SOURCE_INVALID')
    const health = await inspectBookHealth(book, { sevenZipPath: this.sevenZipPath })
    return { anomaly, book, source: sourceInfo, sourceUrl: sourceInfo.url, identity, health }
  }

  async loadGalleryManifest({ sourceUrl, setting, requestedPages = [] }) {
    const galleryPage = await this.getGalleryPage({ url: sourceUrl, setting })
    if (galleryPage.status !== 'available') throw new Error(`PAGE_RECOVERY_SOURCE_${String(galleryPage.status || 'UNAVAILABLE').toUpperCase()}`)
    const pagination = parseGalleryPagination({ html: galleryPage.html, galleryUrl: sourceUrl })
    const pagesByNumber = new Map(parseGalleryPageManifest({ html: galleryPage.html, galleryUrl: sourceUrl }).map(page => [page.pageNumber, page]))
    const loadedUrls = new Set([pagination.pageUrls[0]])
    const loadPage = async url => {
      if (loadedUrls.has(url)) return
      const page = await this.getGalleryPage({ url, setting })
      if (page.status !== 'available') throw new Error(`PAGE_RECOVERY_SOURCE_${String(page.status || 'UNAVAILABLE').toUpperCase()}`)
      parseGalleryPageManifest({ html: page.html, galleryUrl: url }).forEach(page => pagesByNumber.set(page.pageNumber, page))
      loadedUrls.add(url)
    }
    // A partial first thumbnail page cannot establish the gallery's last page.
    if (!pagination.total && pagination.pageUrls.length > 1) await loadPage(pagination.pageUrls[pagination.pageUrls.length - 1])
    for (const url of pagination.pageUrls.slice(1)) {
      if (requestedPages.every(page => pagesByNumber.has(page))) break
      await loadPage(url)
    }
    if (!pagesByNumber.size) throw new Error('PAGE_RECOVERY_PAGE_MANIFEST_INCOMPLETE')
    const onlinePageCount = pagination.total || Math.max(...pagesByNumber.keys())
    return { onlinePageCount, pagesByNumber, loadPage, pagination }
  }

  async fetchSelectedPages({ report, anomalyId, source = 'current', sourceUrl = null, nhentaiId = null, jmcomicId = null, sourceOffset = 0, pageNumbers, includeBoundaryPages = false }) {
    sourceOffset = normalizeSourceOffset(sourceOffset)
    const requestedPages = normalizePageNumbers(pageNumbers)
    if (requestedPages.length === 0) throw new Error('PAGE_RECOVERY_PAGE_SELECTION_EMPTY')
    const requestedSourcePages = requestedPages.map(page => resolveSourcePageNumber(page, sourceOffset))
    const { anomaly, book, source: sourceInfo, sourceUrl: resolvedSourceUrl, identity, health } = await this.getRecoveryBook({ report, anomalyId, source, sourceUrl, nhentaiId, jmcomicId })
    const snapshot = await getBookFileSnapshot(book)
    const recoveryId = createRecoveryId()
    const jobDir = this.getJobDir(recoveryId)
    await fs.promises.mkdir(path.join(jobDir, 'downloads'), { recursive: true })
    await fs.promises.mkdir(path.join(jobDir, 'previews'), { recursive: true })

    const session = {
      recoveryId,
      reportId: report.reportId,
      anomalyId: String(anomalyId),
      bookId: String(anomaly.bookId),
      filepath: book.filepath,
      bookType: book.type,
      sourceOffset,
      source: {
        type: sourceInfo.type,
        url: resolvedSourceUrl,
        site: new URL(resolvedSourceUrl).hostname,
        ...(sourceInfo.id ? { galleryId: String(sourceInfo.id) } : {}),
        ...(sourceInfo.mediaId ? { mediaId: String(sourceInfo.mediaId) } : {}),
        ...(identity || {})
      },
      snapshot,
      local: { pageCount: health.pageCount, sequence: health.imageSequence },
      online: {},
      writeBackSupported: false,
      mappingConfidence: 'unknown',
      availablePages: requestedPages,
      leadingPages: [],
      trailingPages: [],
      unconfirmedLeadingPages: [],
      unconfirmedTrailingPages: [],
      unconfirmedBoundaryPages: [],
      selectedPages: requestedPages,
      candidates: [],
      status: 'fetching',
      error: null
    }
    await this.saveSession(session)

    try {
      const setting = this.getSetting() || {}
      let onlinePageCount
      let pagesByNumber
      let pagination
      let loadPage
      if (sourceInfo.type === 'nhentai') {
        const manifest = await this.getNhentaiRecoveryManifest({
          id: sourceInfo.id,
          url: resolvedSourceUrl,
          filepath: book.filepath,
          title: book.title || book.title_jpn,
          setting
        })
        onlinePageCount = manifest.onlinePageCount
        pagesByNumber = new Map((manifest.pages || []).map(page => [page.pageNumber, page]))
        pagination = { pageUrls: [] }
        loadPage = async () => {}
        Object.assign(session.source, {
          galleryId: String(manifest.galleryId || sourceInfo.id),
          mediaId: String(manifest.mediaId || '')
        })
      } else if (sourceInfo.type === 'jmcomic') {
        const manifest = await this.getJmComicRecoveryManifest({
          id: sourceInfo.id,
          url: resolvedSourceUrl,
          filepath: book.filepath,
          title: book.title || book.title_jpn,
          setting
        })
        onlinePageCount = manifest.onlinePageCount
        pagesByNumber = new Map((manifest.pages || []).map(page => [page.pageNumber, page]))
        pagination = { pageUrls: [] }
        loadPage = async () => {}
        Object.assign(session.source, {
          galleryId: String(manifest.galleryId || sourceInfo.id)
        })
      } else {
        const manifest = await this.loadGalleryManifest({ sourceUrl: resolvedSourceUrl, setting, requestedPages: requestedSourcePages })
        onlinePageCount = manifest.onlinePageCount
        pagesByNumber = manifest.pagesByNumber
        pagination = manifest.pagination
        loadPage = manifest.loadPage
      }
      const localPageCount = getMappedLocalPageCount(onlinePageCount, sourceOffset)
      session.online = { pageCount: onlinePageCount, localPageCount, sourceOffset, checkedAt: Date.now() }
      const recoveryHealth = buildRecoveryHealth(health, localPageCount)
      const pageOptions = getRecoveryPageOptions(recoveryHealth)
      const boundaryPages = includeBoundaryPages
        ? [...pageOptions.leadingPages, ...pageOptions.trailingPages]
        : []
      const selectedPages = normalizePageNumbers([...requestedPages, ...boundaryPages])
      if (selectedPages.some(page => !pageOptions.availablePages.includes(page))) {
        throw new Error('PAGE_RECOVERY_PAGE_NOT_MISSING')
      }
      const selectedSourcePages = selectedPages.map(page => resolveSourcePageNumber(page, sourceOffset))
      for (let index = 0; index < selectedPages.length; index += 1) {
        if (selectedSourcePages[index] > onlinePageCount) {
          throw new Error(`PAGE_RECOVERY_SOURCE_PAGE_UNAVAILABLE:${selectedPages[index]}:${selectedSourcePages[index]}`)
        }
      }
      for (const url of pagination.pageUrls.slice(1)) {
        if (selectedSourcePages.every(page => pagesByNumber.has(page))) break
        await loadPage(url)
      }
      const unavailablePages = selectedPages.filter(page => !pagesByNumber.has(page + sourceOffset))
      if (unavailablePages.length) {
        if (sourceOffset === 0) throw new Error(`PAGE_RECOVERY_PAGE_UNAVAILABLE:${unavailablePages.join(',')}:${pagesByNumber.size}`)
        throw new Error(`PAGE_RECOVERY_SOURCE_PAGE_UNAVAILABLE:${unavailablePages[0]}:${unavailablePages[0] + sourceOffset}`)
      }
      const mapping = assessPageMapping({ health: recoveryHealth, onlinePageCount: localPageCount, pageNumbers: selectedPages })
      const batchMapping = assessBatchPageMapping({ health, onlinePageCount: localPageCount, pageNumbers: selectedPages })
      const mappingConfirmed = mapping.supported
      Object.assign(session, {
        online: { ...session.online, mappingConfirmed },
        writeBackSupported: Boolean(mappingConfirmed),
        mappingConfidence: mapping.confidence,
        batchWriteBackSupported: batchMapping.batchSupported,
        batchWriteBackReason: batchMapping.batchReason || null,
        ...pageOptions,
        unconfirmedLeadingPages: mappingConfirmed ? [] : selectedPages.filter(page => pageOptions.leadingPages.includes(page)),
        unconfirmedTrailingPages: mappingConfirmed ? [] : selectedPages.filter(page => pageOptions.trailingPages.includes(page)),
        unconfirmedBoundaryPages: mappingConfirmed ? [] : selectedPages.filter(page => pageOptions.leadingPages.includes(page) || pageOptions.trailingPages.includes(page)),
        selectedPages
      })
      await this.saveSession(session)

      const localContexts = new Map(selectedPages.map(pageNumber => [pageNumber, resolveLocalPageContext({
        health: recoveryHealth, pageNumber, targetPath: resolveTargetPath({ health: recoveryHealth, pageNumber })
      })]))
      const localPreviews = await readLocalPagePreviews(book, [...new Set([...localContexts.values()]
        .flatMap(context => [context.previous.path, context.next.path]).filter(Boolean))])
      for (const context of localContexts.values()) {
        for (const neighbor of [context.previous, context.next]) {
          neighbor.previewDataUrl = localPreviews.get(neighbor.path) || null
          if (neighbor.previewDataUrl) neighbor.status = 'available'
        }
      }

      for (const pageNumber of selectedPages) {
        const sourcePageNumber = resolveSourcePageNumber(pageNumber, sourceOffset)
        const page = pagesByNumber.get(sourcePageNumber)
        let imageUrl
        let image
        if (sourceInfo.type === 'nhentai') {
          imageUrl = page.imageUrl
          if (!imageUrl) throw new Error(`PAGE_RECOVERY_IMAGE_SOURCE_MISSING:${pageNumber}`)
          image = await this.requestNhentaiImage({
            imageUrl,
            setting,
            referer: resolvedSourceUrl
          })
        } else if (sourceInfo.type === 'jmcomic') {
          imageUrl = page.imageUrl
          if (!imageUrl) throw new Error(`PAGE_RECOVERY_IMAGE_SOURCE_MISSING:${pageNumber}`)
          image = await this.requestJmComicImage({
            imageUrl,
            imageUrls: page.imageUrls,
            setting,
            referer: page.imageReferer || resolvedSourceUrl,
            photoId: page.photoId,
            scrambleId: page.scrambleId,
            pageFileName: page.pageFileName
          })
        } else {
          const detail = await this.requestText({
            url: page.pageUrl,
            setting,
            headers: { Cookie: buildCookie(setting), Referer: resolvedSourceUrl }
          })
          if (detail.error) throw detail.error
          imageUrl = parseImagePageSource({ html: detail.body, pageUrl: page.pageUrl })
          if (!imageUrl) throw new Error(`PAGE_RECOVERY_IMAGE_SOURCE_MISSING:${pageNumber}`)
          image = await this.requestBinary({
            url: imageUrl,
            setting,
            headers: { Cookie: buildCookie(setting), Referer: page.pageUrl }
          })
        }
        if (image.error) throw image.error
        if (image.httpStatus < 200 || image.httpStatus >= 300) throw new Error(`PAGE_RECOVERY_IMAGE_HTTP_${image.httpStatus}`)
        const metadata = await sharp(image.buffer).metadata()
        if (!metadata.width || !metadata.height) throw new Error(`PAGE_RECOVERY_IMAGE_INVALID:${pageNumber}`)
        const extension = getImageExtension({ contentType: image.contentType, imageUrl })
        const targetPath = resolveTargetPath({ health: recoveryHealth, pageNumber }).replace(/\.[^.]+$/, extension)
        const downloadName = `page-${String(pageNumber).padStart(6, '0')}${extension}`
        const downloadPath = path.join(jobDir, 'downloads', downloadName)
        const previewBuffer = await createPreviewBuffer(image.buffer)
        const previewPath = path.join(jobDir, 'previews', `${downloadName}.jpg`)
        await fs.promises.writeFile(downloadPath, image.buffer)
        await fs.promises.writeFile(previewPath, previewBuffer)
        session.candidates.push({
          id: `${recoveryId}:${pageNumber}`,
          pageNumber,
          sourcePageNumber,
          pageUrl: page.pageUrl,
          imageUrl,
          targetPath,
          downloadPath,
          previewPath,
          previewDataUrl: `data:image/jpeg;base64,${previewBuffer.toString('base64')}`,
          localContext: localContexts.get(pageNumber),
          size: image.buffer.length,
          sha256: hashBuffer(image.buffer),
          width: metadata.width,
          height: metadata.height,
          status: 'downloaded',
          selected: false
        })
        await this.saveSession(session)
      }
      linkFetchedNeighborPages(session.candidates)
      session.status = 'awaiting-confirmation'
      return await this.saveSession(session)
    } catch (error) {
      session.status = 'failed'
      session.error = String(error?.message || error)
      session.failedAt = Date.now()
      await this.saveSession(session).catch(() => {})
      throw error
    }
  }

  async apply({ report, recoveryId, candidateIds, confirmPageMapping = false }) {
    const session = await this.getSession(recoveryId)
    if (!report?.reportId || report.reportId !== session.reportId) throw new Error('PAGE_RECOVERY_REVIEW_MISMATCH')
    if (session.status !== 'awaiting-confirmation') throw new Error('PAGE_RECOVERY_SESSION_NOT_READY')
    const selected = new Set((Array.isArray(candidateIds) ? candidateIds : []).map(String))
    const candidates = session.candidates.filter(item => selected.has(String(item.id)) && item.status === 'downloaded')
    if (candidates.length === 0) throw new Error('PAGE_RECOVERY_CANDIDATE_SELECTION_EMPTY')
    const book = await this.Manga.findByPk(session.bookId, { raw: true })
    if (!book || book.filepath !== session.filepath) throw new Error('PAGE_RECOVERY_BOOK_CHANGED')
    const currentSnapshot = await getBookFileSnapshot(book)
    if (Number(currentSnapshot.bundleSize) !== Number(session.snapshot.bundleSize) || Number(currentSnapshot.mtimeMs) !== Number(session.snapshot.mtimeMs)) {
      throw new Error('PAGE_RECOVERY_STALE_FILE')
    }
    const health = await inspectBookHealth(book, { sevenZipPath: this.sevenZipPath })
    const localPageCount = getMappedLocalPageCount(session.online?.pageCount, session.sourceOffset)
    const recoveryHealth = buildRecoveryHealth(health, localPageCount)
    const mapping = assessPageMapping({
      health: recoveryHealth,
      onlinePageCount: localPageCount,
      pageNumbers: candidates.map(candidate => candidate.pageNumber)
    })
    if (!mapping.supported && confirmPageMapping !== true) throw new Error('PAGE_RECOVERY_MAPPING_UNCERTAIN')
    session.writeBackSupported = true
    session.mappingConfidence = mapping.supported ? mapping.confidence : 'manual'
    session.online = { ...session.online, mappingConfirmed: mapping.supported }
    if (!mapping.supported) session.manuallyConfirmedAt = Date.now()
    const existing = new Set((health.imagePaths || []).map(normalizeEntryPath))
    const availablePages = getRecoveryPageOptions(recoveryHealth).availablePages
    if (candidates.some(item => !availablePages.includes(item.pageNumber))) throw new Error('PAGE_RECOVERY_PAGE_NOT_MISSING')
    if (candidates.some(item => (health.imagePaths || []).some(entry => path.posix.dirname(normalizeEntryPath(entry)) === path.posix.dirname(item.targetPath) && extractImageSequenceNumber(entry) === item.pageNumber))) throw new Error('PAGE_RECOVERY_TARGET_EXISTS')
    if (candidates.some(item => existing.has(normalizeEntryPath(item.targetPath)))) throw new Error('PAGE_RECOVERY_TARGET_EXISTS')

    session.status = 'applying'
    await this.saveSession(session)
    const appliedPaths = []
    let preparedPath = null
    let backupPath = null
    let rollbackPath = null
    const jobDir = this.getJobDir(session.recoveryId)
    try {
      if (session.bookType === 'folder') {
        for (const candidate of candidates) {
          const targetPath = ensureRecoveryPath(path.join(session.filepath, ...candidate.targetPath.split('/')))
          const relative = path.relative(path.resolve(session.filepath), targetPath)
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('PAGE_RECOVERY_TARGET_INVALID')
          await fs.promises.mkdir(path.dirname(targetPath), { recursive: true })
          const tempPath = `${targetPath}.page-recovery-${nanoid(8)}.tmp`
          await fs.promises.copyFile(candidate.downloadPath, tempPath)
          await fs.promises.rename(tempPath, targetPath)
          appliedPaths.push(targetPath)
        }
      } else {
        const zip = new AdmZip(session.filepath)
        for (const candidate of candidates) {
          const normalized = normalizeEntryPath(candidate.targetPath)
          zip.addLocalFile(candidate.downloadPath, path.posix.dirname(normalized) === '.' ? '' : path.posix.dirname(normalized), path.posix.basename(normalized))
        }
        const archiveDirectory = path.dirname(session.filepath)
        const archiveExtension = path.extname(session.filepath)
        preparedPath = path.join(archiveDirectory, `.page-recovery-${nanoid(8)}.tmp${archiveExtension}`)
        await fs.promises.writeFile(preparedPath, zip.toBuffer())
        backupPath = path.join(jobDir, 'backups', `original${archiveExtension || '.zip'}`)
        await fs.promises.mkdir(path.dirname(backupPath), { recursive: true })
        await fs.promises.copyFile(session.filepath, backupPath)
        rollbackPath = path.join(archiveDirectory, `.page-recovery-${nanoid(8)}.rollback${archiveExtension}`)
        await fs.promises.rename(session.filepath, rollbackPath)
        try {
          await fs.promises.rename(preparedPath, session.filepath)
        } catch (error) {
          await fs.promises.rename(rollbackPath, session.filepath).catch(() => {})
          rollbackPath = null
          throw error
        }
        preparedPath = null
      }

      const verified = await inspectBookHealth({ filepath: session.filepath, type: session.bookType }, { sevenZipPath: this.sevenZipPath })
      const remainingOptions = getRecoveryPageOptions(buildRecoveryHealth(verified, localPageCount))
      const remainingMissing = remainingOptions.availablePages
      for (const candidate of candidates) {
        if (remainingMissing.includes(candidate.pageNumber)) throw new Error(`PAGE_RECOVERY_VERIFY_GAP_REMAINS:${candidate.pageNumber}`)
        candidate.status = 'applied'
      }
      const hasRemainingMissing = remainingMissing.length > 0
      session.status = hasRemainingMissing ? 'awaiting-confirmation' : 'completed'
      session.remainingMissingPages = remainingMissing
      session.local = { pageCount: verified.pageCount, sequence: verified.imageSequence }
      if (hasRemainingMissing) {
        session.selectedPages = remainingMissing
        session.availablePages = remainingMissing
        session.leadingPages = remainingOptions.leadingPages
        session.trailingPages = remainingOptions.trailingPages
        session.unconfirmedLeadingPages = remainingMissing.filter(page => remainingOptions.leadingPages.includes(page))
        session.unconfirmedTrailingPages = remainingMissing.filter(page => remainingOptions.trailingPages.includes(page))
        session.unconfirmedBoundaryPages = [...new Set([...session.unconfirmedLeadingPages, ...session.unconfirmedTrailingPages])]
        session.writeBackSupported = false
        session.mappingConfidence = 'unknown'
        session.batchWriteBackSupported = false
        session.batchWriteBackReason = PAGE_RECOVERY_REMAINING_PAGES
        session.candidates = []
      }
      session.snapshot = await getBookFileSnapshot({ filepath: session.filepath, type: session.bookType })
      session.appliedAt = Date.now()
      session.appliedCandidateIds = candidates.map(item => item.id)
      await this.saveSession(session)
      if (rollbackPath) {
        await fs.promises.rm(rollbackPath, { force: true })
        rollbackPath = null
      }
      return { session, health: verified }
    } catch (error) {
      if (session.bookType === 'folder') {
        await Promise.all(appliedPaths.map(filepath => fs.promises.rm(filepath, { force: true }).catch(() => {})))
      }
      if (preparedPath) await fs.promises.rm(preparedPath, { force: true }).catch(() => {})
      if (rollbackPath) {
        await fs.promises.rm(session.filepath, { force: true }).catch(() => {})
        await fs.promises.rename(rollbackPath, session.filepath).catch(() => {})
      }
      session.status = 'failed'
      session.error = error.message
      await this.saveSession(session)
      throw error
    }
  }

  async cancel(recoveryId) {
    const session = await this.getSession(recoveryId)
    session.status = 'cancelled'
    await this.saveSession(session)
    return session
  }

  async cleanup(recoveryId) {
    const session = await this.getSession(recoveryId)
    if (session.status === 'applying') throw new Error('PAGE_RECOVERY_BUSY')
    await fs.promises.rm(this.getJobDir(session.recoveryId), { recursive: true, force: true })
    this.sessions.delete(session.recoveryId)
    return { recoveryId: session.recoveryId, status: 'cleaned' }
  }
}

module.exports = {
  PageRecoveryManager,
  parseGalleryPageManifest,
  parseGalleryPagination,
  parseImagePageSource,
  getSequenceTemplate,
  resolveTargetPath,
  assessBatchPageMapping,
  listPendingRecoverySummaries,
  getRecoveryMissingPages: (health, onlinePageCount) => getRecoveryPageOptions(
    buildRecoveryHealth(health, Number.isSafeInteger(Number(onlinePageCount)) ? Number(onlinePageCount) : 0)
  ).availablePages
}

const fs = require('fs')
const path = require('path')
const { createHash, randomUUID } = require('crypto')

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif'])
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.cbz', '.rar', '.cbr', '.7z', '.cb7'])
const ATOMIC_RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const atomicWriteJson = async (filepath, value) => {
  const directory = path.dirname(filepath)
  await fs.promises.mkdir(directory, { recursive: true })
  const tempPath = path.join(directory, `.${path.basename(filepath)}.${process.pid}.${randomUUID()}.tmp`)
  const payload = JSON.stringify(value, null, 2)
  let handle
  try {
    handle = await fs.promises.open(tempPath, 'wx')
    await handle.writeFile(payload, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.promises.rename(tempPath, filepath)
        return
      } catch (error) {
        if (!ATOMIC_RENAME_RETRY_CODES.has(error.code) || attempt >= 7) throw error
        await wait(Math.min(25 * (2 ** attempt), 1000))
      }
    }
  } finally {
    await handle?.close().catch(() => {})
    await fs.promises.rm(tempPath, { force: true }).catch(() => {})
  }
}

const readJson = async (filepath, fallback = null) => {
  try {
    return JSON.parse(await fs.promises.readFile(filepath, 'utf8'))
  } catch {
    return fallback
  }
}

const normalizePath = value => path.resolve(String(value || '')).toLowerCase()

const stableId = (...parts) => createHash('sha1')
  .update(parts.map(value => JSON.stringify(value)).join('\u0000'))
  .digest('hex')

const hashFile = filepath => new Promise((resolve, reject) => {
  const hash = createHash('sha256')
  const stream = fs.createReadStream(filepath)
  stream.on('data', chunk => hash.update(chunk))
  stream.on('error', reject)
  stream.on('end', () => resolve(hash.digest('hex')))
})

const extractGalleryIdentity = value => {
  const match = String(value || '').match(/(?:e[x-]?hentai\.org|nhentai\.net)\/g\/(\d+)(?:\/([0-9a-z]+))?/i)
  return match ? { gid: match[1], token: match[2] || null } : null
}

const getMetadataSourceProvider = value => {
  try {
    const url = new URL(String(value || '').trim())
    if (!['http:', 'https:'].includes(url.protocol)) return null
    if (['e-hentai.org', 'exhentai.org', 'ehentai.org'].includes(url.hostname.toLowerCase())) return 'ehentai'
    if (['nhentai.net', 'www.nhentai.net'].includes(url.hostname.toLowerCase())) return 'nhentai'
  } catch {}
  return null
}

const extractMetadataSourceIdentity = value => {
  const provider = getMetadataSourceProvider(value)
  if (!provider) return null
  const pathname = new URL(String(value).trim()).pathname
  const match = provider === 'ehentai'
    ? pathname.match(/^\/g\/([1-9]\d*)\/([0-9a-z]+)\/?$/i)
    : pathname.match(/^\/g\/([1-9]\d*)\/?$/)
  return match ? { provider, id: match[1], token: match[2]?.toLowerCase() || null } : null
}

const isSameMetadataSource = (left, right) => Boolean(left && right &&
  left.provider === right.provider && left.id === right.id && left.token === right.token)

const isAutomaticSourceReplacementBlocked = action => Boolean(action?.type === 'repair-url' &&
  action.repairKind !== 'manual-source-selection' && String(action.currentUrl || '').trim() &&
  extractMetadataSourceIdentity(action.currentUrl)?.provider !== 'ehentai')

const extractFilenameIdentity = value => {
  const match = path.basename(String(value || '')).match(/^(?:(nhentai)[-_\s]*)?(\d{4,})\b/i)
  if (!match) return null
  return { id: match[2], namespace: match[1] ? 'nhentai' : 'ehentai' }
}

const extractFilenameId = value => extractFilenameIdentity(value)?.id || null

const parseTags = value => {
  if (!value) return {}
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

const metadataFingerprint = metadata => {
  const values = {}
  for (const key of ['hash', 'title', 'status', 'rating', 'title_jpn', 'filecount', 'posted', 'filesize', 'category', 'url']) {
    values[key] = metadata?.[key] ?? null
  }
  values.mark = Boolean(metadata?.mark)
  values.tags = parseTags(metadata?.tags)
  return stableId('metadata-row', values)
}

module.exports = {
  IMAGE_EXTENSIONS,
  ARCHIVE_EXTENSIONS,
  atomicWriteJson,
  readJson,
  normalizePath,
  stableId,
  hashFile,
  extractGalleryIdentity,
  getMetadataSourceProvider,
  extractMetadataSourceIdentity,
  isSameMetadataSource,
  isAutomaticSourceReplacementBlocked,
  extractFilenameIdentity,
  extractFilenameId,
  parseTags,
  metadataFingerprint
}

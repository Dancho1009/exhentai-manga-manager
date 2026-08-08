const fs = require('fs')
const path = require('path')
const { createHash } = require('crypto')

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif'])
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.cbz', '.rar', '.cbr', '.7z', '.cb7'])

const atomicWriteJson = async (filepath, value) => {
  await fs.promises.mkdir(path.dirname(filepath), { recursive: true })
  const tempPath = `${filepath}.tmp`
  await fs.promises.writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8')
  await fs.promises.rename(tempPath, filepath)
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

const extractFilenameId = value => {
  const match = path.basename(String(value || '')).match(/^(?:nhentai[-_\s]*)?(\d{4,})\b/i)
  return match?.[1] || null
}

const parseTags = value => {
  if (!value) return {}
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
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
  extractFilenameId,
  parseTags
}

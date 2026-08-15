const EHENTAI_HOSTS = new Set(['e-hentai.org', 'exhentai.org'])

export const extractEhviewerIdentity = value => {
  try {
    const parsed = new URL(String(value || '').trim())
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
    if (!EHENTAI_HOSTS.has(parsed.hostname.toLowerCase())) return null
    const match = parsed.pathname.match(/^\/g\/(\d+)\/([0-9a-f]{10})(?:\/|$)/i)
    return match ? { gid: match[1], token: match[2].toLowerCase() } : null
  } catch {
    return null
  }
}

const normalizeTitleLine = (title, gid) => String(title || '')
  .replace(/[\u0000-\u001F\u007F]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim() || `Gallery ${gid}`

export const buildEhviewerRecoveryPreview = ({ url, title } = {}) => {
  const identity = extractEhviewerIdentity(url)
  if (!identity) return null
  const normalizedTitle = normalizeTitleLine(title, identity.gid)
  return {
    format: 'VERSION2',
    sourceUrl: String(url).trim(),
    title: normalizedTitle,
    ...identity,
    content: `VERSION2\n${normalizedTitle}\n${identity.gid}\n${identity.token}\n`
  }
}

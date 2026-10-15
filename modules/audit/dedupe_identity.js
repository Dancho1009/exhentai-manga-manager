const { extractMetadataSourceIdentity, isSameMetadataSource, stableId } = require('./utils.js')

const resolveBookIdentity = (wrapped, ehviewer = {}) => {
  const rawUrl = wrapped.raw?.url || ''
  const effectiveUrl = wrapped.effective?.url || rawUrl
  const sources = [
    { source: 'database', value: rawUrl, identity: extractMetadataSourceIdentity(rawUrl) },
    { source: 'effective', value: effectiveUrl, identity: extractMetadataSourceIdentity(effectiveUrl) },
    { source: 'ehviewer', value: ehviewer.entryPath || '.ehviewer', identity: /^[1-9]\d*$/.test(String(ehviewer.gid || '')) && /^[0-9a-z]+$/i.test(String(ehviewer.token || ''))
      ? extractMetadataSourceIdentity(`https://exhentai.org/g/${ehviewer.gid}/${ehviewer.token}/`) : null }
  ]
  const identities = sources.map(item => item.identity).filter(Boolean)
  const conflict = identities.some(item => !isSameMetadataSource(item, identities[0]))
  const markerInvalid = ['invalid', 'ambiguous'].includes(ehviewer.status) || (ehviewer.status === 'parsed' && !sources[2].identity)
  const invalidUrl = sources.slice(0, 2).some(item => item.value && !item.identity)
  const status = conflict ? 'conflict' : markerInvalid ? ehviewer.status === 'ambiguous' ? 'ambiguous' : 'invalid' : invalidUrl ? 'invalid' : identities.length ? 'known' : 'missing'
  const identity = identities[0] || null
  return { status, identity, key: identity ? `${identity.provider}:${identity.id}:${identity.token || ''}` : null,
    sources, ehviewer, fingerprint: stableId(sources, ehviewer.status) }
}

module.exports = { resolveBookIdentity }

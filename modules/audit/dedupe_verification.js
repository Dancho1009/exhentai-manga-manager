const { hashFile, metadataFingerprint, normalizePath } = require('./utils.js')
const { ensureExpectedFile } = require('./execution_common.js')
const { enumerateBookEntries } = require('./dedupe_manifest.js')
const { inspectBookContent } = require('./archive_inspector.js')
const { contentProof } = require('./dedupe_comparison.js')
const { mergeEffectiveBook } = require('../book_detail.js')
const { resolveBookIdentity } = require('./dedupe_identity.js')

const verifyDedupeItem = async (item, { Manga, Metadata, sevenZipPath, isCancelled }) => {
  await ensureExpectedFile(item)
  const raw = await Manga.findByPk(item.id, { raw: true })
  if (!raw || normalizePath(raw.filepath) !== normalizePath(item.filepath) || raw.hash !== item.hash) throw new Error('DEDUPE_RECORD_CHANGED: ' + item.id)
  const [metadata, peers] = await Promise.all([
    item.hash ? Metadata.findByPk(item.hash, { raw: true }) : null,
    item.hash ? Manga.findAll({ where: { hash: item.hash }, raw: true }) : []
  ])
  const effective = mergeEffectiveBook({ manga: raw, metadata, hashPeers: peers })
  if (item.metadataFingerprint && metadataFingerprint(effective) !== item.metadataFingerprint) throw new Error('DEDUPE_METADATA_CHANGED: ' + item.id)
  let ehviewer = item.sourceEvidence?.ehviewer || {}
  if (item.archiveSha256 && item.type !== 'folder') {
    if (await hashFile(item.filepath, isCancelled) !== item.archiveSha256) throw new Error('DEDUPE_CONTENT_CHANGED: ' + item.id)
  } else {
    const options = { sevenZipPath, isCancelled }
    const manifest = await enumerateBookEntries(item, options)
    const inspection = await inspectBookContent(item, { ...options, manifest })
    if (!item.contentProof || contentProof(inspection) !== item.contentProof || manifest.folderFingerprint !== item.folderFingerprint) throw new Error('DEDUPE_CONTENT_CHANGED: ' + item.id)
    ehviewer = inspection.ehviewer
  }
  if (item.sourceEvidence && resolveBookIdentity({ raw, effective }, ehviewer).fingerprint !== item.sourceEvidence.fingerprint) throw new Error('DEDUPE_SOURCE_CHANGED: ' + item.id)
  await ensureExpectedFile(item)
  return raw
}
module.exports = { verifyDedupeItem }

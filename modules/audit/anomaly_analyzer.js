const fs = require('fs')
const {
  normalizePath,
  stableId,
  extractGalleryIdentity,
  extractFilenameId
} = require('./utils.js')

const makeAnomaly = (type, severity, data = {}) => ({
  id: stableId(type, data.bookId, data.filepath, data.groupKey, data.metadataHash),
  type,
  severity,
  title: data.title || type,
  bookId: data.bookId || null,
  filepath: data.filepath || null,
  reason: data.reason || '',
  evidence: data.evidence || {},
  recommendedAction: data.recommendedAction || 'review',
  action: data.action || null
})

const analyzeEntityAnomalies = snapshot => {
  const anomalies = []
  const actualByPath = new Map(snapshot.actualItems.map(item => [normalizePath(item.filepath), item]))
  const databasePaths = new Set(snapshot.books.map(item => normalizePath(item.raw.filepath)))
  const metadataHashes = new Set(snapshot.metadataRows.map(row => row.hash))

  for (const wrapped of snapshot.books) {
    const { raw, effective } = wrapped
    const actual = actualByPath.get(normalizePath(raw.filepath))
    if (!actual) {
      anomalies.push(makeAnomaly('database-file-missing', 'critical', {
        bookId: raw.id, filepath: raw.filepath, reason: '数据库记录指向的文件不存在', evidence: { databasePath: raw.filepath }
      }))
      continue
    }
    if (Number(raw.bundleSize) !== Number(actual.size)) {
      anomalies.push(makeAnomaly('scan-stale-size', 'high', {
        bookId: raw.id, filepath: raw.filepath, reason: '文件实际大小与数据库快照不一致',
        evidence: { databaseSize: raw.bundleSize, actualSize: actual.size }, recommendedAction: 'targeted-rescan'
      }))
    }
    const storedMtime = new Date(raw.mtime || 0).getTime()
    if (Number.isFinite(storedMtime) && storedMtime > 0 && Math.abs(storedMtime - actual.mtimeMs) > 2000) {
      anomalies.push(makeAnomaly('scan-stale-mtime', 'medium', {
        bookId: raw.id, filepath: raw.filepath, reason: '文件修改时间与数据库快照不一致',
        evidence: { databaseMtime: raw.mtime, actualMtime: actual.mtime }, recommendedAction: 'targeted-rescan'
      }))
    }
    if (raw.coverPath && !fs.existsSync(raw.coverPath)) {
      anomalies.push(makeAnomaly('cover-missing', 'medium', {
        bookId: raw.id, filepath: raw.filepath, reason: '数据库封面路径不存在', evidence: { coverPath: raw.coverPath }, recommendedAction: 'targeted-rescan'
      }))
    }
    if (!metadataHashes.has(raw.hash)) {
      anomalies.push(makeAnomaly('metadata-missing', 'high', {
        bookId: raw.id, filepath: raw.filepath, metadataHash: raw.hash, reason: 'metadata.sqlite 中没有对应 hash'
      }))
    }
    const identity = extractGalleryIdentity(effective.url)
    const filenameId = extractFilenameId(raw.filepath)
    if (identity?.gid && filenameId && identity.gid !== filenameId) {
      anomalies.push(makeAnomaly('filename-url-id-conflict', 'high', {
        bookId: raw.id, filepath: raw.filepath, reason: '文件名前缀编号与元数据 URL gid 不一致',
        evidence: { filenameId, urlGid: identity.gid, url: effective.url }, recommendedAction: 'source-identity-check'
      }))
    }
    if (effective.status === 'tagged' && !effective.url) {
      anomalies.push(makeAnomaly('tagged-without-source', 'high', {
        bookId: raw.id, filepath: raw.filepath, reason: '状态为 tagged，但没有来源 URL', recommendedAction: 'source-identity-check'
      }))
    }
    const tags = effective.tags || {}
    const tagCount = Object.values(tags).reduce((sum, values) => sum + (Array.isArray(values) ? values.length : 0), 0)
    if (!effective.title || !effective.category || !effective.filecount || tagCount === 0) {
      anomalies.push(makeAnomaly('metadata-incomplete', 'low', {
        bookId: raw.id, filepath: raw.filepath, reason: '存在缺失的常用元数据字段',
        evidence: { title: Boolean(effective.title), category: Boolean(effective.category), filecount: effective.filecount, tagCount }
      }))
    }
  }

  for (const actual of snapshot.actualItems) {
    if (!databasePaths.has(normalizePath(actual.filepath))) {
      anomalies.push(makeAnomaly('library-file-untracked', 'high', {
        filepath: actual.filepath, reason: 'Library 中的作品没有数据库记录', evidence: { actualSize: actual.size }, recommendedAction: 'targeted-import'
      }))
    }
  }
  const mangaHashes = new Set(snapshot.books.map(item => item.raw.hash))
  for (const metadata of snapshot.metadataRows) {
    if (!mangaHashes.has(metadata.hash)) {
      anomalies.push(makeAnomaly('orphan-metadata', 'low', {
        metadataHash: metadata.hash, reason: 'metadata.sqlite 记录没有对应 Manga', evidence: { title: metadata.title, url: metadata.url }
      }))
    }
  }
  return anomalies
}

module.exports = { makeAnomaly, analyzeEntityAnomalies }

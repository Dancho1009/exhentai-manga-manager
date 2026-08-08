const path = require('path')
const { parentPort, workerData } = require('worker_threads')
const { buildSnapshot, analyzeSnapshot, makeAnomaly } = require('./library_snapshot.js')
const { AuditCache } = require('./cache.js')
const { inspectBookContent } = require('./archive_inspector.js')
const {
  atomicWriteJson,
  normalizePath,
  stableId,
  hashFile,
  extractGalleryIdentity
} = require('./utils.js')

let cancelled = false
parentPort.on('message', message => {
  if (message?.type === 'cancel') cancelled = true
})

const post = message => parentPort.postMessage(message)
const progress = (phase, completed, total) => post({ type: 'progress', phase, completed, total })
const log = message => post({ type: 'log', message })
const isCancelled = () => cancelled

const groupBy = (items, keySelector) => {
  const groups = new Map()
  for (const item of items) {
    const key = keySelector(item)
    if (key === null || key === undefined || key === '') continue
    const group = groups.get(key) || []
    group.push(item)
    groups.set(key, group)
  }
  return groups
}

const summarizeBook = wrapped => ({
  id: wrapped.raw.id,
  filepath: wrapped.raw.filepath,
  type: wrapped.raw.type,
  size: wrapped.actual?.size ?? wrapped.raw.bundleSize,
  mtimeMs: wrapped.actual?.mtimeMs ?? null,
  title: wrapped.effective.title || wrapped.raw.title || path.basename(wrapped.raw.filepath),
  url: wrapped.effective.url || null,
  status: wrapped.effective.status || wrapped.raw.status,
  readCount: Number(wrapped.raw.readCount || 0),
  mark: Boolean(wrapped.raw.mark),
  hiddenBook: Boolean(wrapped.raw.hiddenBook),
  hash: wrapped.raw.hash,
  coverHash: wrapped.raw.coverHash,
  pageCount: wrapped.raw.pageCount
})

const scoreKeeper = wrapped => {
  let score = 0
  if (wrapped.effective.status === 'tagged') score += 100
  if (wrapped.effective.url) score += 50
  if (wrapped.raw.mark) score += 20
  if (!wrapped.raw.hiddenBook) score += 5
  score += Math.min(Number(wrapped.raw.readCount || 0), 20)
  return score
}

const createDuplicateGroup = (kind, wrappedItems, evidence, eligible, reviewReason) => {
  const sorted = [...wrappedItems].sort((a, b) => scoreKeeper(b) - scoreKeeper(a) || a.raw.filepath.localeCompare(b.raw.filepath))
  const items = sorted.map(summarizeBook)
  const suggestedKeepId = items[0]?.id || null
  const potentialBytes = items.filter(item => item.id !== suggestedKeepId).reduce((sum, item) => sum + Number(item.size || 0), 0)
  return {
    id: stableId('duplicate', kind, items.map(item => item.id).sort()),
    kind,
    severity: kind === 'exact-archive' ? 'high' : eligible ? 'medium' : 'high',
    eligible,
    reviewReason: reviewReason || null,
    suggestedKeepId,
    potentialBytes,
    evidence,
    items
  }
}

const run = async () => {
  const { options, jobDir } = workerData
  const cache = await AuditCache.open(options.auditStorePath)
  try {
    log(`开始读取 Library: ${options.library}`)
    const snapshot = await buildSnapshot({
      library: options.library,
      databasePath: options.databasePath,
      metadataPath: options.metadataPath,
      excludeFile: options.excludeFile,
      onProgress: progress,
      isCancelled
    })
    const anomalies = analyzeSnapshot(snapshot)
    const actualByPath = new Map(snapshot.actualItems.map(item => [normalizePath(item.filepath), item]))
    const wrappedBooks = snapshot.books.map(wrapped => ({ ...wrapped, actual: actualByPath.get(normalizePath(wrapped.raw.filepath)) }))
    const wrappedById = new Map(wrappedBooks.map(item => [item.raw.id, item]))
    const wrappedByPath = new Map(wrappedBooks.map(item => [normalizePath(item.raw.filepath), item]))
    const duplicateGroups = []

    if (options.mode === 'deep') {
      const sizeGroups = groupBy(
        wrappedBooks.filter(item => item.actual && item.raw.type !== 'folder'),
        item => item.actual.size
      )
      const archiveHashTargets = [...sizeGroups.values()].filter(group => group.length > 1).flat()
      const archiveHashes = new Map()
      let completed = 0
      for (const wrapped of archiveHashTargets) {
        if (isCancelled()) throw new Error('AUDIT_CANCELLED')
        const cached = await cache.get(wrapped.raw, wrapped.actual)
        const sha256 = cached?.archiveSha256 || await hashFile(wrapped.raw.filepath)
        if (!cached?.archiveSha256) await cache.update(wrapped.raw, wrapped.actual, { archiveSha256: sha256 })
        archiveHashes.set(wrapped.raw.id, sha256)
        completed += 1
        progress('hashing-archives', completed, archiveHashTargets.length)
      }
      for (const sizeGroup of [...sizeGroups.values()].filter(group => group.length > 1)) {
        const shaGroups = groupBy(sizeGroup, item => archiveHashes.get(item.raw.id))
        for (const [sha256, group] of shaGroups) {
          if (group.length > 1) duplicateGroups.push(createDuplicateGroup('exact-archive', group, { sha256, size: group[0].actual.size }, true))
        }
      }

      const contentPrefilter = groupBy(
        wrappedBooks.filter(item => item.actual && item.raw.pageCount && item.raw.hash && item.raw.coverHash),
        item => `${item.raw.pageCount}|${item.raw.hash}|${item.raw.coverHash}`
      )
      const contentCandidates = [...contentPrefilter.values()].filter(group => group.length > 1).flat()
      const anomalyBookIds = new Set(anomalies.filter(item => item.bookId && [
        'filename-url-id-conflict', 'tagged-without-source', 'page-count-mismatch'
      ].includes(item.type)).map(item => item.bookId))
      const targetIds = new Set()
      if (options.deepScope === 'all') {
        wrappedBooks.filter(item => item.actual).forEach(item => targetIds.add(item.raw.id))
      } else if (options.deepScope === 'changed') {
        const changedIds = new Set()
        for (const wrapped of wrappedBooks.filter(item => item.actual)) {
          const cached = await cache.get(wrapped.raw, wrapped.actual)
          if (!cached?.inspection) changedIds.add(wrapped.raw.id)
        }
        for (const group of [...contentPrefilter.values()].filter(group => group.length > 1)) {
          if (group.some(item => changedIds.has(item.raw.id))) group.forEach(item => targetIds.add(item.raw.id))
        }
        for (const id of anomalyBookIds) targetIds.add(id)
      } else {
        contentCandidates.forEach(item => targetIds.add(item.raw.id))
        for (const id of anomalyBookIds) targetIds.add(id)
      }

      const inspections = new Map()
      completed = 0
      for (const id of targetIds) {
        if (isCancelled()) throw new Error('AUDIT_CANCELLED')
        const wrapped = wrappedById.get(id)
        if (!wrapped?.actual) continue
        const cached = await cache.get(wrapped.raw, wrapped.actual)
        let inspection = cached?.inspection
        if (!inspection) {
          try {
            inspection = await inspectBookContent(wrapped.raw, { sevenZipPath: options.sevenZipPath })
            await cache.update(wrapped.raw, wrapped.actual, { inspection })
          } catch (error) {
            anomalies.push(makeAnomaly('archive-inspection-failed', 'high', {
              bookId: wrapped.raw.id,
              filepath: wrapped.raw.filepath,
              reason: '压缩包深度检查失败',
              evidence: { error: error.message }
            }))
          }
        }
        if (inspection) inspections.set(id, inspection)
        completed += 1
        progress('inspecting-content', completed, targetIds.size)
      }

      for (const id of anomalyBookIds) {
        const wrapped = wrappedById.get(id)
        const inspection = inspections.get(id)
        if (!wrapped || !inspection) continue
        const ehviewer = inspection.ehviewer
        const urlIdentity = extractGalleryIdentity(wrapped.effective.url)
        if (ehviewer.status === 'ambiguous' || ehviewer.status === 'invalid') {
          anomalies.push(makeAnomaly(`ehviewer-${ehviewer.status}`, 'high', {
            bookId: id, filepath: wrapped.raw.filepath,
            reason: ehviewer.status === 'ambiguous' ? '压缩包内存在多个 .ehviewer，无法自动确认身份' : '.ehviewer 无法解析',
            evidence: ehviewer
          }))
        }
        if (ehviewer.gid && ehviewer.token) {
          const newUrl = `https://exhentai.org/g/${ehviewer.gid}/${ehviewer.token}/`
          if (urlIdentity?.gid && urlIdentity.gid !== ehviewer.gid) {
            anomalies.push(makeAnomaly('ehviewer-url-conflict', 'critical', {
              bookId: id, filepath: wrapped.raw.filepath, reason: '.ehviewer 身份与当前 URL 冲突',
              evidence: { ehviewer, currentUrl: wrapped.effective.url }, recommendedAction: 'repair-url-after-approval',
              action: { type: 'repair-url', bookId: id, filepath: wrapped.raw.filepath, expectedSize: wrapped.actual.size, expectedMtimeMs: wrapped.actual.mtimeMs, currentUrl: wrapped.effective.url, newUrl }
            }))
          } else if (!wrapped.effective.url && wrapped.effective.status === 'tagged') {
            anomalies.push(makeAnomaly('ehviewer-source-recoverable', 'high', {
              bookId: id, filepath: wrapped.raw.filepath, reason: '可由 .ehviewer 恢复来源 URL',
              evidence: { ehviewer }, recommendedAction: 'repair-url-after-approval',
              action: { type: 'repair-url', bookId: id, filepath: wrapped.raw.filepath, expectedSize: wrapped.actual.size, expectedMtimeMs: wrapped.actual.mtimeMs, currentUrl: null, newUrl }
            }))
          }
          const pageDiff = Math.abs(Number(wrapped.raw.pageCount || 0) - Number(wrapped.effective.filecount || 0))
          if (wrapped.effective.filecount && pageDiff > 5) {
            anomalies.push(makeAnomaly(urlIdentity?.gid === ehviewer.gid ? 'exact-source-page-mismatch' : 'unverified-page-mismatch', 'medium', {
              bookId: id, filepath: wrapped.raw.filepath,
              reason: urlIdentity?.gid === ehviewer.gid ? '已确认同一作品，但本地与来源页数不同' : '页数不同且作品身份尚未完全确认',
              evidence: { localPages: wrapped.raw.pageCount, remotePages: wrapped.effective.filecount, ehviewer, currentUrl: wrapped.effective.url }
            }))
          }
        }
      }

      for (const candidateGroup of [...contentPrefilter.values()].filter(group => group.length > 1)) {
        const inspected = candidateGroup.filter(item => inspections.has(item.raw.id))
        const imageGroups = groupBy(inspected, item => inspections.get(item.raw.id).imageSignature)
        for (const [imageSignature, group] of imageGroups) {
          if (group.length < 2) continue
          const groupInspections = group.map(item => inspections.get(item.raw.id))
          const ancillarySignatures = new Set(groupInspections.map(item => item.ancillarySignature))
          const identityKeys = new Set(group.map((item, index) => {
            const ehviewer = groupInspections[index].ehviewer
            if (ehviewer.gid && ehviewer.token) return `eh:${ehviewer.gid}:${ehviewer.token}`
            const identity = extractGalleryIdentity(item.effective.url)
            return identity?.gid ? `url:${identity.gid}:${identity.token || ''}` : ''
          }).filter(Boolean))
          const eligible = ancillarySignatures.size === 1 && identityKeys.size === 1
          duplicateGroups.push(createDuplicateGroup(
            eligible ? 'strict-content' : 'content-review',
            group,
            {
              imageSignature,
              imageCount: groupInspections[0].pageCount,
              ancillarySignatures: [...ancillarySignatures],
              identities: [...identityKeys],
              ehviewer: groupInspections.map((item, index) => ({ bookId: group[index].raw.id, ...item.ehviewer }))
            },
            eligible,
            eligible ? null : '图片一致，但附属文件或作品身份不一致'
          ))
        }
      }
    }

    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 }
    anomalies.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || a.type.localeCompare(b.type))
    const report = {
      version: 1,
      jobId: workerData.jobId,
      mode: options.mode,
      deepScope: options.deepScope,
      createdAt: snapshot.createdAt,
      source: { library: options.library, databasePath: options.databasePath, metadataPath: options.metadataPath },
      summary: {
        libraryItems: snapshot.actualItems.length,
        mangaRows: snapshot.books.length,
        metadataRows: snapshot.metadataRows.length,
        anomalies: anomalies.length,
        actionableAnomalies: anomalies.filter(item => item.action).length,
        duplicateGroups: duplicateGroups.length,
        eligibleDuplicateGroups: duplicateGroups.filter(group => group.eligible).length,
        potentialBytes: duplicateGroups.filter(group => group.eligible).reduce((sum, group) => sum + group.potentialBytes, 0)
      },
      anomalies,
      duplicates: duplicateGroups
    }
    const reportPath = path.join(jobDir, 'report.json')
    await atomicWriteJson(reportPath, report)
    post({ type: 'completed', reportPath, summary: report.summary })
    parentPort.close()
  } finally {
    await cache.close()
  }
}

run().catch(error => {
  if (error.message === 'AUDIT_CANCELLED') post({ type: 'cancelled' })
  else post({ type: 'failed', error: error.stack || error.message || String(error) })
  parentPort.close()
})

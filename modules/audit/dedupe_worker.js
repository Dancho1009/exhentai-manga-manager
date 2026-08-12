const path = require('path')
const { workerData } = require('worker_threads')
const { buildSnapshot } = require('./library_snapshot.js')
const { AuditCache } = require('./cache.js')
const { inspectBookContent } = require('./archive_inspector.js')
const {
  groupBy,
  createDuplicateGroup,
  analyzeBookRelations
} = require('./dedupe_analyzer.js')
const {
  atomicWriteJson,
  normalizePath,
  hashFile,
  extractGalleryIdentity
} = require('./utils.js')
const { REPORT_SCHEMA_VERSION, getReportId } = require('./report_repository.js')
const { createWorkerRuntime, mapWithConcurrency } = require('./worker_runtime.js')

const HASH_CONCURRENCY = 2
const CONTENT_INSPECTION_CONCURRENCY = 2
const runtime = createWorkerRuntime()

runtime.run(async ({ isCancelled, assertNotCancelled, progress, log }) => {
  const { options, jobDir, jobId } = workerData
  let cache
  try {
    cache = await AuditCache.open(options.auditStorePath)
    log(`开始读取 Library: ${options.library}`)
    const snapshot = await buildSnapshot({
      library: options.library,
      databasePath: options.databasePath,
      metadataPath: options.metadataPath,
      excludeFile: options.excludeFile,
      onProgress: progress,
      isCancelled
    })
    const actualByPath = new Map(snapshot.actualItems.map(item => [normalizePath(item.filepath), item]))
    const wrappedBooks = snapshot.books.map(wrapped => ({ ...wrapped, actual: actualByPath.get(normalizePath(wrapped.raw.filepath)) }))
    const groups = analyzeBookRelations(wrappedBooks)
    const excludedItems = []

    const sizeGroups = groupBy(
      wrappedBooks.filter(item => item.actual && item.raw.type !== 'folder'),
      item => item.actual.size
    )
    const archiveHashTargets = [...sizeGroups.values()].filter(group => group.length > 1).flat()
    const archiveHashes = new Map()
    let completed = 0
    const hashResults = await mapWithConcurrency(archiveHashTargets, HASH_CONCURRENCY, async wrapped => {
      assertNotCancelled()
      try {
        const cached = options.forceContent ? null : await cache.get(wrapped.raw, wrapped.actual)
        const sha256 = cached?.archiveSha256 || await hashFile(wrapped.raw.filepath)
        if (!cached?.archiveSha256 || options.forceContent) await cache.update(wrapped.raw, wrapped.actual, { archiveSha256: sha256 })
        return { wrapped, sha256 }
      } catch (error) {
        return { wrapped, error }
      } finally {
        completed += 1
        progress('hashing-archives', completed, archiveHashTargets.length)
      }
    }, isCancelled)
    for (const result of hashResults) {
      if (result.error) {
        excludedItems.push({
          bookId: result.wrapped.raw.id,
          filepath: result.wrapped.raw.filepath,
          phase: 'hashing-archives',
          reason: result.error.message
        })
      } else {
        archiveHashes.set(String(result.wrapped.raw.id), result.sha256)
      }
    }
    for (const sizeGroup of [...sizeGroups.values()].filter(group => group.length > 1)) {
      const shaGroups = groupBy(
        sizeGroup.filter(item => archiveHashes.has(String(item.raw.id))),
        item => archiveHashes.get(String(item.raw.id))
      )
      for (const [sha256, group] of shaGroups) {
        if (group.length > 1) groups.push(createDuplicateGroup('exact-archive', group, { sha256, size: group[0].actual.size }, true))
      }
    }

    const contentPrefilter = groupBy(
      wrappedBooks.filter(item => item.actual && item.raw.pageCount && item.raw.hash && item.raw.coverHash),
      item => `${item.raw.pageCount}|${item.raw.hash}|${item.raw.coverHash}`
    )
    const contentTargets = [...contentPrefilter.values()].filter(group => group.length > 1).flat()
    const inspections = new Map()
    completed = 0
    const inspectionResults = await mapWithConcurrency(contentTargets, CONTENT_INSPECTION_CONCURRENCY, async wrapped => {
      assertNotCancelled()
      try {
        const cached = options.forceContent ? null : await cache.get(wrapped.raw, wrapped.actual)
        const inspection = cached?.contentInspection || await inspectBookContent(wrapped.raw, { sevenZipPath: options.sevenZipPath })
        if (!cached?.contentInspection || options.forceContent) await cache.update(wrapped.raw, wrapped.actual, {
          contentInspection: inspection,
          ehviewerInspection: inspection.ehviewer
        })
        return { wrapped, inspection }
      } catch (error) {
        return { wrapped, error }
      } finally {
        completed += 1
        progress('inspecting-content', completed, contentTargets.length)
      }
    }, isCancelled)
    for (const result of inspectionResults) {
      if (result.error) {
        excludedItems.push({
          bookId: result.wrapped.raw.id,
          filepath: result.wrapped.raw.filepath,
          phase: 'inspecting-content',
          reason: result.error.message
        })
      } else {
        inspections.set(String(result.wrapped.raw.id), result.inspection)
      }
    }

    for (const candidateGroup of [...contentPrefilter.values()].filter(group => group.length > 1)) {
      const inspected = candidateGroup.filter(item => inspections.has(String(item.raw.id)))
      const imageGroups = groupBy(inspected, item => inspections.get(String(item.raw.id)).imageSignature)
      for (const [imageSignature, group] of imageGroups) {
        if (group.length < 2) continue
        const groupInspections = group.map(item => inspections.get(String(item.raw.id)))
        const ancillarySignatures = new Set(groupInspections.map(item => item.ancillarySignature))
        const identityKeys = new Set(group.map((item, index) => {
          const ehviewer = groupInspections[index].ehviewer
          if (ehviewer.gid && ehviewer.token) return `eh:${ehviewer.gid}:${ehviewer.token}`
          const identity = extractGalleryIdentity(item.effective.url)
          return identity?.gid ? `url:${identity.gid}:${identity.token || ''}` : ''
        }).filter(Boolean))
        const eligible = ancillarySignatures.size === 1 && identityKeys.size === 1
        groups.push(createDuplicateGroup(
          eligible ? 'strict-content' : 'content-review',
          group,
          {
            imageSignature,
            imageCount: groupInspections[0].pageCount,
            ancillarySignatures: [...ancillarySignatures],
            identities: [...identityKeys],
            ehviewer: groupInspections.map((inspection, index) => ({ bookId: group[index].raw.id, ...inspection.ehviewer }))
          },
          eligible,
          eligible ? null : '图片一致，但附属文件或作品身份不一致'
        ))
      }
    }

    const kindOrder = {
      'duplicate-database-path': 0,
      'metadata-shadow-conflict': 1,
      'exact-archive': 2,
      'strict-content': 3,
      'content-review': 4,
      'shared-hash-review': 5
    }
    groups.sort((left, right) => (kindOrder[left.kind] ?? 99) - (kindOrder[right.kind] ?? 99) || right.potentialBytes - left.potentialBytes)
    const report = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      reportType: 'dedupe',
      reportId: getReportId('dedupe', jobId),
      jobId,
      legacy: false,
      executable: true,
      createdAt: snapshot.createdAt,
      source: { library: options.library, databasePath: options.databasePath, metadataPath: options.metadataPath },
      options: { forceContent: Boolean(options.forceContent) },
      summary: {
        libraryItems: snapshot.actualItems.length,
        mangaRows: snapshot.books.length,
        metadataRows: snapshot.metadataRows.length,
        duplicateGroups: groups.length,
        eligibleDuplicateGroups: groups.filter(group => group.eligible).length,
        excludedItems: excludedItems.length,
        potentialBytes: groups.filter(group => group.eligible).reduce((sum, group) => sum + group.potentialBytes, 0)
      },
      groups,
      excludedItems
    }
    const reportPath = path.join(jobDir, 'report.json')
    await atomicWriteJson(reportPath, report)
    return { reportPath, summary: report.summary }
  } finally {
    if (cache) await cache.close()
  }
})

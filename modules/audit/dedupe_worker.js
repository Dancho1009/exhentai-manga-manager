const fs = require('fs')
const path = require('path')
const { workerData } = require('worker_threads')
const { performance } = require('perf_hooks')
const { buildSnapshot } = require('./library_snapshot.js')
const { AuditCache } = require('./cache.js')
const { inspectBookContent } = require('./archive_inspector.js')
const { enumerateBookEntries } = require('./dedupe_manifest.js')
const { collectDuplicateCandidates, buildDuplicateGroups } = require('./dedupe_candidates.js')
const { DEDUPE_RULES_VERSION } = require('./dedupe_title.js')
const { groupBy } = require('./dedupe_analyzer.js')
const { atomicWriteJson, normalizePath, hashFile, stableId } = require('./utils.js')
const { REPORT_SCHEMA_VERSION, getReportId } = require('./report_repository.js')
const { createWorkerRuntime, mapWithConcurrency } = require('./worker_runtime.js')

const runtime = createWorkerRuntime()
const toCurrentItem = wrapped => ({ id: String(wrapped.raw.id), title: wrapped.effective.title || path.basename(wrapped.raw.filepath), filepath: wrapped.raw.filepath })

runtime.run(async ({ isCancelled, assertNotCancelled, progress, log }) => {
  const { options, jobDir, jobId } = workerData
  const forceRecompute = Boolean(options.forceRecompute || options.forceContent)
  const scanMode = options.scanMode === 'full' ? 'full' : 'daily'
  let cache
  try {
    cache = await AuditCache.open(options.auditStorePath)
    const snapshot = await buildSnapshot({ ...options, onProgress: progress, isCancelled })
    const actualByPath = new Map(snapshot.actualItems.map(item => [normalizePath(item.filepath), item]))
    const allBooks = snapshot.books.map(wrapped => ({ ...wrapped, actual: actualByPath.get(normalizePath(wrapped.raw.filepath)) }))
    const selectedIds = options.baseReport ? new Set(options.baseReport.groups.filter(group => options.groupIds.includes(group.id)).flatMap(group => group.items.map(item => String(item.id)))) : null
    const books = selectedIds ? allBooks.filter(item => selectedIds.has(String(item.raw.id))) : allBooks
    const physicalBooks = [...groupBy(books.filter(item => item.actual), item => normalizePath(item.raw.filepath)).values()].map(items => items[0])
    for (const wrapped of physicalBooks) {
      if (wrapped.raw.type !== 'folder') continue
      const prefix = normalizePath(wrapped.raw.filepath) + path.sep
      wrapped.nestedBookIds = allBooks.filter(book => normalizePath(book.raw.filepath).startsWith(prefix)).map(book => String(book.raw.id))
    }
    const excluded = new Map()
    const metrics = { phasesMs: {}, archiveHashBytes: 0, contentHashBytes: 0, cacheHits: { manifests: 0, archives: 0, content: 0 } }
    const readOptions = { sevenZipPath: options.sevenZipPath, isCancelled }
    const perform = async (phase, targets, work) => {
      const started = performance.now()
      let completed = 0
      const active = new Map()
      await mapWithConcurrency(targets, 2, async wrapped => {
        assertNotCancelled()
        const current = toCurrentItem(wrapped)
        active.set(current.id, current)
        progress(phase, completed, targets.length, current, [...active.values()])
        try { await work(wrapped) }
        catch (error) {
          if (error.message === 'AUDIT_CANCELLED') throw error
          if (phase === 'hashing-archives') wrapped.archiveSha256 = null
          if (phase === 'inspecting-content') { wrapped.inspection = null; wrapped.evidenceRef = null }
          excluded.set(String(wrapped.raw.id), { bookId: wrapped.raw.id, filepath: wrapped.raw.filepath, phase, reason: error.message })
          log(phase + ': ' + wrapped.raw.filepath + ': ' + error.message, 'warning')
        } finally {
          completed += 1
          active.delete(current.id)
          progress(phase, completed, targets.length, [...active.values()][0] || null, [...active.values()])
        }
      }, isCancelled)
      progress(phase, completed, targets.length)
      metrics.phasesMs[phase] = Math.round(performance.now() - started)
    }
    const verifyStat = async wrapped => {
      const stat = await fs.promises.stat(wrapped.raw.filepath)
      if (wrapped.raw.type !== 'folder' && (stat.size !== wrapped.actual.size || Math.abs(stat.mtimeMs - wrapped.actual.mtimeMs) > 1)) throw new Error('FILE_CHANGED_DURING_CHECK')
      if (wrapped.raw.type === 'folder') {
        const current = await enumerateBookEntries(wrapped.raw, readOptions)
        if (current.folderFingerprint !== wrapped.manifest.folderFingerprint) throw new Error('FILE_CHANGED_DURING_CHECK')
      }
    }
    await perform('enumerating-manifests', physicalBooks, async wrapped => {
      const cached = !forceRecompute && await cache.getManifest(wrapped.raw, wrapped.actual)
      if (cached) metrics.cacheHits.manifests++
      wrapped.manifest = cached || await enumerateBookEntries(wrapped.raw, readOptions)
      await verifyStat(wrapped)
      await cache.updateManifest(wrapped.raw, wrapped.actual, wrapped.manifest)
    })
    const hashTargets = [...groupBy(physicalBooks.filter(item => item.raw.type !== 'folder'), item => item.actual.size).values()].filter(items => items.length > 1).flat()
    await perform('hashing-archives', hashTargets, async wrapped => {
      const cached = forceRecompute ? null : await cache.get(wrapped.raw, wrapped.actual)
      wrapped.archiveSha256 = cached?.archiveSha256 || await hashFile(wrapped.raw.filepath, isCancelled)
      if (cached?.archiveSha256) metrics.cacheHits.archives++
      else metrics.archiveHashBytes += wrapped.actual.size
      await verifyStat(wrapped)
      await cache.update(wrapped.raw, wrapped.actual, { archiveSha256: wrapped.archiveSha256 })
    })
    const candidates = collectDuplicateCandidates(physicalBooks)
    const strongKinds = new Set(['archive-sha256', 'manifest-order', 'manifest-set', 'page-sizes', 'cover-pages'])
    const candidateIds = new Set(candidates.filter(bucket => strongKinds.has(bucket.kind) ||
      (['source', 'title-author', 'publication-issue'].includes(bucket.kind) && bucket.items.every(item => item.manifest?.pageCount > 0)))
      .flatMap(bucket => bucket.items.map(item => String(item.raw.id))))
    const inspectTargets = physicalBooks.filter(item => scanMode === 'full' || selectedIds || candidateIds.has(String(item.raw.id)))
    const representatives = new Map()
    await perform('inspecting-content', inspectTargets, async wrapped => {
      const inspect = async () => {
        const cached = forceRecompute ? null : await cache.get(wrapped.raw, wrapped.actual)
        let inspection = cached?.contentInspection
        if (inspection?.formatVersion !== 2 || inspection.folderFingerprint !== (wrapped.manifest?.folderFingerprint || null)) inspection = null
        const fromCache = Boolean(inspection)
        inspection ||= await inspectBookContent(wrapped.raw, { ...readOptions, manifest: wrapped.manifest })
        if (fromCache) metrics.cacheHits.content++
        else metrics.contentHashBytes += [...inspection.images, ...inspection.ancillary].reduce((sum, entry) => sum + entry.size, 0)
        await verifyStat(wrapped)
        await cache.update(wrapped.raw, wrapped.actual, { contentInspection: inspection, ehviewerInspection: inspection.ehviewer })
        return { ...inspection, fromCache }
      }
      if (wrapped.archiveSha256) {
        if (!representatives.has(wrapped.archiveSha256)) representatives.set(wrapped.archiveSha256, { bookId: String(wrapped.raw.id), promise: inspect() })
        const representative = representatives.get(wrapped.archiveSha256)
        wrapped.inspection = { ...await representative.promise, representativeBookId: representative.bookId,
          verificationMethod: representative.bookId === String(wrapped.raw.id) ? 'content' : 'archive-equivalence' }
        await verifyStat(wrapped)
      } else wrapped.inspection = { ...await inspect(), representativeBookId: String(wrapped.raw.id), verificationMethod: 'content' }
      const filename = stableId(String(wrapped.raw.id)) + '.json'
      await atomicWriteJson(path.join(jobDir, 'evidence', filename), { bookId: String(wrapped.raw.id), filepath: wrapped.raw.filepath, inspection: wrapped.inspection, manifest: wrapped.manifest })
      wrapped.evidenceRef = { jobId, filename }
    })
    const physicalByPath = new Map(physicalBooks.map(item => [normalizePath(item.raw.filepath), item]))
    for (const wrapped of books) {
      const physical = physicalByPath.get(normalizePath(wrapped.raw.filepath))
      if (physical) Object.assign(wrapped, { manifest: physical.manifest, inspection: physical.inspection, archiveSha256: physical.archiveSha256, evidenceRef: physical.evidenceRef, nestedBookIds: physical.nestedBookIds })
    }
    progress('classifying-relations', 0, 1)
    let groups = buildDuplicateGroups(books)
    const booksById = new Map(books.map(book => [String(book.raw.id), book]))
    for (const group of groups) for (const item of group.items) item.evidenceRef = booksById.get(item.id)?.evidenceRef || null
    if (options.baseReport) {
      const remaining = new Set(groups)
      groups = options.baseReport.groups.flatMap(group => {
        if (!group.items.some(item => selectedIds.has(String(item.id)))) return [group]
        const memberIds = new Set(group.items.map(item => String(item.id)))
        const replacements = [...remaining].filter(candidate => candidate.items.some(item => memberIds.has(String(item.id))))
        replacements.forEach(candidate => remaining.delete(candidate))
        return replacements
      })
    }
    progress('classifying-relations', 1, 1)
    const excludedItems = options.baseReport ? [...(options.baseReport.excludedItems || []).filter(item => !selectedIds.has(String(item.bookId))), ...excluded.values()] : [...excluded.values()]
    const registeredPaths = new Set(allBooks.map(item => normalizePath(item.raw.filepath)))
    const report = {
      schemaVersion: REPORT_SCHEMA_VERSION, dedupeVersion: 2, dedupeRulesVersion: DEDUPE_RULES_VERSION, reportType: 'dedupe', reportId: getReportId('dedupe', jobId), jobId,
      legacy: false, executable: true, createdAt: snapshot.createdAt,
      source: { library: options.library, databasePath: options.databasePath, metadataPath: options.metadataPath },
      options: { scanMode, forceRecompute, forceContent: forceRecompute, scope: selectedIds ? 'groups' : 'library' },
      summary: { libraryItems: snapshot.actualItems.length, mangaRows: allBooks.length, metadataRows: snapshot.metadataRows.length,
        unregisteredItems: snapshot.actualItems.filter(item => !registeredPaths.has(normalizePath(item.filepath))).length,
        missingItems: allBooks.filter(item => !item.actual).length, checkedItems: physicalBooks.length,
        duplicateGroups: groups.length, eligibleDuplicateGroups: groups.filter(group => group.eligible).length,
        excludedItems: excludedItems.length, potentialBytes: groups.reduce((sum, group) => sum + group.potentialBytes, 0) },
      groups, excludedItems, performance: metrics
    }
    progress('finalizing-report', 0, 1)
    const reportPath = path.join(jobDir, 'report.json')
    await atomicWriteJson(reportPath, report)
    progress('finalizing-report', 1, 1)
    return { reportPath, summary: report.summary }
  } finally { if (cache) await cache.close() }
})

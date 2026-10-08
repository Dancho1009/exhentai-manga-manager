const path = require('path')
const { workerData } = require('worker_threads')
const { performance } = require('perf_hooks')
const { buildSnapshot } = require('./library_snapshot.js')
const { analyzeEntityAnomalies, makeAnomaly, buildLocalScanAction } = require('./anomaly_analyzer.js')
const { AuditCache } = require('./cache.js')
const { EhentaiAvailabilityCache } = require('../ehentai_availability_cache.js')
const {
  checkGallerySites,
  getGalleryMetadata,
  getGdataBatch,
  buildGalleryUrl,
  extractGalleryIdentity: extractEhentaiIdentity,
  isIdentityWebAvailable
} = require('../ehentai.js')
const {
  summarizeAvailability,
  pickAvailableUrl,
  getSameIdentityFallbackUrl,
  decideIdentityConflict,
  buildSourceRecoveryAction,
  buildEhviewerSyncAction,
  getGalleryVersionRelation,
  isVersionChainNoise,
  isConclusiveUnavailable
} = require('./online_decision.js')
const { inspectBookHealth } = require('./archive_inspector.js')
const { getEhviewerRepairSupport, normalizeEhviewerIdentity, sanitizeEhviewerTitle } = require('./ehviewer_repair.js')
const { atomicWriteJson, normalizePath, getMetadataSourceProvider } = require('./utils.js')
const { REPORT_SCHEMA_VERSION, getReportId } = require('./report_repository.js')
const { createWorkerRuntime, mapWithConcurrency } = require('./worker_runtime.js')
const { classifyAnomalies, getWorkflowSummary } = require('./action_policy.js')
const { listPendingRecoverySummaries, getRecoveryMissingPages } = require('./page_recovery.js')
const {
  IDENTITY_ANOMALY_TYPES, confirmationKey, matchesSourceConfirmation, loadSourceConfirmations, restoreSourceConfirmations
} = require('./source_confirmation.js')

const LOCAL_INSPECTION_CONCURRENCY = 4
const HEALTH_CACHE_BATCH_SIZE = 32
const runtime = createWorkerRuntime()

const toCurrentItem = wrapped => ({
  id: wrapped?.raw?.id ? String(wrapped.raw.id) : null,
  title: wrapped?.effective?.title || wrapped?.raw?.title || path.basename(wrapped?.raw?.filepath || ''),
  filepath: wrapped?.raw?.filepath || null
})

const toPageSourceEvidence = ({ url, gdata } = {}) => {
  const count = Number(gdata?.metadata?.filecount)
  return {
    url: url || null,
    status: gdata?.status || 'unchecked',
    pages: gdata?.status === 'available' && Number.isFinite(count) && count >= 0 ? count : null,
    error: gdata?.error || null
  }
}

const sortAnomalies = anomalies => {
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 }
  anomalies.sort((left, right) => severityOrder[left.severity] - severityOrder[right.severity] || left.type.localeCompare(right.type))
}

const removeVersionChainNoise = (anomalies, bookId, relation) => {
  for (let index = anomalies.length - 1; index >= 0; index -= 1) {
    if (isVersionChainNoise(anomalies[index], bookId, relation)) anomalies.splice(index, 1)
  }
}

runtime.run(async ({ isCancelled, assertNotCancelled, progress, log }) => {
  const { options, jobDir, jobId } = workerData
  const started = performance.now()
  const performanceData = {
    timings: { cacheWriteMs: 0 },
    local: { concurrency: LOCAL_INSPECTION_CONCURRENCY, cacheHits: 0, inspected: 0, failed: 0, readCalls: 0, readBytes: 0 }
  }
  const timingLabels = {
    libraryEnumerationMs: '目录枚举', databaseReadMs: '数据库读取', fileStatsMs: '文件属性读取',
    snapshotMs: '全库快照', cacheReadMs: '本地缓存读取', localHealthMs: '本地文件检查',
    cacheWriteMs: '缓存提交', localAnalysisMs: '本地异常分析', recoveryReviewMs: '恢复记录核对',
    siteAvailabilityMs: '双站可用性检查', gdataMs: '来源元数据读取', onlineMs: '在线核验'
  }
  const recordTiming = (key, elapsed) => {
    performanceData.timings[key] = Math.round(elapsed)
    log(`${timingLabels[key]}耗时 ${(elapsed / 1000).toFixed(2)} 秒`)
  }
  let cache
  let availabilityCache
  try {
    cache = await AuditCache.open(options.auditStorePath)
    availabilityCache = await EhentaiAvailabilityCache.open(options.auditStorePath)
    log(`开始读取 Library: ${options.library}`)
    const snapshot = await buildSnapshot({
      library: options.library,
      databasePath: options.databasePath,
      metadataPath: options.metadataPath,
      excludeFile: options.excludeFile,
      onProgress: progress,
      isCancelled,
      onTiming: recordTiming
    })
    const anomalies = analyzeEntityAnomalies(snapshot)
    const actualByPath = new Map(snapshot.actualItems.map(item => [normalizePath(item.filepath), item]))
    const wrappedBooks = snapshot.books.map(wrapped => ({ ...wrapped, actual: actualByPath.get(normalizePath(wrapped.raw.filepath)) }))
    const healthById = new Map()
    let completed = 0
    const inspectTargets = wrappedBooks.filter(item => item.actual)
    const activeHealthItems = new Map()
    progress('inspecting-book-health', 0, inspectTargets.length, null)
    const cacheReadStarted = performance.now()
    const cachedHealth = options.forceLocal ? new Map() : await cache.getHealthMany(inspectTargets)
    recordTiming('cacheReadMs', performance.now() - cacheReadStarted)
    let pendingCacheEntries = []
    let cacheWriteQueue = Promise.resolve()
    const flushHealthCache = () => {
      if (!pendingCacheEntries.length) return cacheWriteQueue
      const entries = pendingCacheEntries
      pendingCacheEntries = []
      cacheWriteQueue = cacheWriteQueue.then(async () => {
        const writeStarted = performance.now()
        try {
          await cache.updateHealthMany(entries)
        } finally {
          performanceData.timings.cacheWriteMs += performance.now() - writeStarted
        }
      })
      return cacheWriteQueue
    }
    const healthStarted = performance.now()
    let healthResults
    try {
      healthResults = await mapWithConcurrency(inspectTargets, LOCAL_INSPECTION_CONCURRENCY, async wrapped => {
        assertNotCancelled()
        const currentItem = toCurrentItem(wrapped)
        const currentKey = currentItem.id || currentItem.filepath
        activeHealthItems.set(currentKey, currentItem)
        progress('inspecting-book-health', completed, inspectTargets.length, currentItem, [...activeHealthItems.values()])
        try {
          let health = cachedHealth.get(normalizePath(wrapped.raw.filepath))
          if (health) {
            performanceData.local.cacheHits += 1
          } else {
            try {
              health = await inspectBookHealth(wrapped.raw, { sevenZipPath: options.sevenZipPath, ioStats: performanceData.local })
            } catch (error) {
              performanceData.local.failed += 1
              return {
                wrapped,
                health: null,
                anomaly: makeAnomaly('archive-inspection-failed', 'high', {
                  bookId: wrapped.raw.id,
                  filepath: wrapped.raw.filepath,
                  reason: '作品内部结构检查失败',
                  evidence: { error: error.message }
                })
              }
            }
            performanceData.local.inspected += 1
            pendingCacheEntries.push({ book: wrapped.raw, stat: wrapped.actual, health })
            if (pendingCacheEntries.length >= HEALTH_CACHE_BATCH_SIZE) await flushHealthCache()
          }
          return { wrapped, health, anomaly: null }
        } finally {
          completed += 1
          activeHealthItems.delete(currentKey)
          const remainingItems = [...activeHealthItems.values()]
          progress('inspecting-book-health', completed, inspectTargets.length, remainingItems[0] || null, remainingItems)
        }
      }, isCancelled)
    } finally {
      // Finish in-flight files and persist the last partial batch before closing SQLite.
      try {
        await flushHealthCache()
      } finally {
        recordTiming('localHealthMs', performance.now() - healthStarted)
        recordTiming('cacheWriteMs', performanceData.timings.cacheWriteMs)
        const stats = performanceData.local
        log(`本地检查统计：缓存命中 ${stats.cacheHits} 本，重新读取 ${stats.inspected} 本，失败 ${stats.failed} 本；ZIP 读取 ${stats.readCalls} 次，${(stats.readBytes / 1024 / 1024).toFixed(2)} MiB`)
      }
    }

    const analysisStarted = performance.now()
    for (const { wrapped, health, anomaly } of healthResults) {
      if (anomaly) {
        anomalies.push(anomaly)
        continue
      }
      healthById.set(String(wrapped.raw.id), health)
      const filenameConflict = anomalies.find(item => item.type === 'filename-url-id-conflict' && String(item.bookId) === String(wrapped.raw.id))
      if (filenameConflict && health.ehviewer?.status === 'parsed' && health.ehviewer.gid && health.ehviewer.token) {
        const currentIdentity = extractEhentaiIdentity(wrapped.effective.url)
        const ehviewerIdentity = {
          gid: String(health.ehviewer.gid),
          token: String(health.ehviewer.token).toLowerCase()
        }
        const sameIdentity = currentIdentity && currentIdentity.gid === ehviewerIdentity.gid && currentIdentity.token === ehviewerIdentity.token
        if (sameIdentity) {
          anomalies.splice(anomalies.indexOf(filenameConflict), 1)
        } else {
          filenameConflict.evidence = {
            ...(filenameConflict.evidence || {}),
            ehviewer: health.ehviewer,
            candidateUrl: buildGalleryUrl('exhentai', health.ehviewer.gid, health.ehviewer.token)
          }
        }
      }
      if (health.pageCount === 0) {
        anomalies.push(makeAnomaly('archive-no-images', 'high', {
          bookId: wrapped.raw.id,
          filepath: wrapped.raw.filepath,
          reason: '作品中没有支持的图片文件',
          evidence: { pageCount: health.pageCount }
        }))
      }
      if (health.imageSequence?.gapCount > 0) {
        const gapGroups = health.imageSequence.gaps || []
        const gapSummary = gapGroups
          .map(group => `${group.directory === '.' ? '根目录' : group.directory}: ${group.missingCount} 个编号`)
          .join('；')
        anomalies.push(makeAnomaly('archive-image-sequence-gap', 'high', {
          bookId: wrapped.raw.id,
          filepath: wrapped.raw.filepath,
          reason: `图片序号存在缺口（${gapSummary}）`,
          evidence: {
            basis: 'local-image-entry-names',
            pageCount: health.pageCount,
            currentUrl: wrapped.raw.url || null,
            ehviewer: health.ehviewer?.gid && health.ehviewer?.token ? health.ehviewer : null,
            ehviewerUrl: health.ehviewer?.gid && health.ehviewer?.token
              ? buildGalleryUrl('exhentai', health.ehviewer.gid, health.ehviewer.token)
              : null,
            imageSequence: health.imageSequence
          },
          recommendedAction: 'review'
        }))
      }
      if (Number(wrapped.raw.pageCount || 0) !== Number(health.pageCount || 0)) {
        const pageCountAnomaly = makeAnomaly('scan-page-count-stale', 'medium', {
          bookId: wrapped.raw.id,
          filepath: wrapped.raw.filepath,
          reason: '数据库本地页数与实际图片数量不一致',
          evidence: { databasePages: wrapped.raw.pageCount, actualPages: health.pageCount },
          recommendedAction: 'targeted-rescan'
        })
        const canRepairPageCount = Number(health.pageCount) > 0
        const existingLocalScan = canRepairPageCount
          ? anomalies.find(item => String(item.bookId) === String(wrapped.raw.id) && item.action?.repairKind === 'local-scan-sync')
          : null
        if (existingLocalScan) {
          existingLocalScan.action.expectedPageCount = Number(health.pageCount)
          existingLocalScan.action.updates.pageCount = Number(health.pageCount)
          pageCountAnomaly.evidence.repairActionId = existingLocalScan.id
        } else if (canRepairPageCount) {
          pageCountAnomaly.action = buildLocalScanAction({
            raw: wrapped.raw,
            actual: wrapped.actual,
            pageCount: health.pageCount
          })
        }
        anomalies.push(pageCountAnomaly)
      }
      const ehviewer = health.ehviewer
      if (['ambiguous', 'invalid'].includes(ehviewer?.status)) {
        const recoverySupport = ehviewer.status === 'invalid'
          ? getEhviewerRepairSupport({ filepath: wrapped.raw.filepath, type: wrapped.raw.type })
          : null
        anomalies.push(makeAnomaly(`ehviewer-${ehviewer.status}`, 'high', {
          bookId: wrapped.raw.id,
          filepath: wrapped.raw.filepath,
          reason: ehviewer.status === 'ambiguous' ? '存在多个 .ehviewer，无法自动确认身份' : '.ehviewer 无法解析',
          evidence: ehviewer.status === 'invalid' ? { ehviewer, recoverySupport } : ehviewer,
          recommendedAction: ehviewer.status === 'invalid' && !recoverySupport.supported
            ? 'manual-replace-ehviewer'
            : null
        }))
      }
      if (!ehviewer?.gid || !ehviewer?.token) continue
      const currentIdentity = extractEhentaiIdentity(wrapped.effective.url)
      const identityMatches = currentIdentity?.gid === String(ehviewer.gid) && currentIdentity?.token === String(ehviewer.token).toLowerCase()
      const candidateUrl = `https://exhentai.org/g/${ehviewer.gid}/${ehviewer.token}/`
      if (currentIdentity?.gid && !identityMatches) {
        anomalies.push(makeAnomaly('ehviewer-url-conflict', 'critical', {
          bookId: wrapped.raw.id,
          filepath: wrapped.raw.filepath,
          reason: '.ehviewer 身份与当前 URL 冲突',
          evidence: { ehviewer, currentUrl: wrapped.effective.url, candidateUrl },
          recommendedAction: 'online-source-check'
        }))
      } else if (!wrapped.effective.url && wrapped.effective.status === 'tagged') {
        anomalies.push(makeAnomaly('ehviewer-source-recoverable', 'high', {
          bookId: wrapped.raw.id,
          filepath: wrapped.raw.filepath,
          reason: '可由 .ehviewer 恢复来源 URL',
          evidence: { ehviewer, candidateUrl },
          recommendedAction: 'online-source-check'
        }))
      }
      const pageDiff = Math.abs(Number(health.pageCount || 0) - Number(wrapped.effective.filecount || 0))
      if (wrapped.effective.filecount && pageDiff > 5) {
        anomalies.push(makeAnomaly(identityMatches ? 'exact-source-page-mismatch' : 'unverified-page-mismatch', 'medium', {
          bookId: wrapped.raw.id,
          filepath: wrapped.raw.filepath,
          reason: identityMatches ? '已确认同一作品，但本地与来源页数不同' : '页数不同且作品身份尚未完全确认',
          evidence: { localPages: health.pageCount, remotePages: wrapped.effective.filecount, ehviewer, currentUrl: wrapped.effective.url }
        }))
      }
    }

    const confirmations = await loadSourceConfirmations(options.auditStorePath)
    const restored = await restoreSourceConfirmations({ storePath: options.auditStorePath, books: wrappedBooks, healthById, confirmations })
    const confirmedBookIds = new Set(wrappedBooks.filter(wrapped => matchesSourceConfirmation(
      confirmations.get(confirmationKey(wrapped.raw)),
      { book: { ...wrapped.raw, url: wrapped.effective.url }, stat: wrapped.actual, ehviewer: healthById.get(String(wrapped.raw.id))?.ehviewer }
    )).map(wrapped => String(wrapped.raw.id)))
    for (let index = anomalies.length - 1; index >= 0; index -= 1) {
      const item = anomalies[index]
      if (!confirmedBookIds.has(String(item.bookId))) continue
      if (IDENTITY_ANOMALY_TYPES.has(item.type)) anomalies.splice(index, 1)
      else if (item.type === 'unverified-page-mismatch') anomalies[index] = makeAnomaly('exact-source-page-mismatch', 'medium', {
        bookId: item.bookId, filepath: item.filepath, reason: '已人工确认来源，但本地与来源页数不同', evidence: item.evidence
      })
    }
    if (restored) log(`从成功执行日志恢复 ${restored} 本人工来源确认`)
    if (confirmedBookIds.size) log(`保留 ${confirmedBookIds.size} 本人工确认来源，仅跳过未变化的身份冲突`)
    recordTiming('localAnalysisMs', performance.now() - analysisStarted)
    const recoveryStarted = performance.now()
    // A previous write-back may have fixed internal gaps while leaving inferred
    // boundary pages pending. Keep that review state visible only while the
    // current archive still has an actionable local issue. Once the local
    // sequence is complete and the stored local page count matches it, an old
    // online mapping must not resurrect a false missing-tail anomaly.
    // `auditStorePath` already points at `<store>/audit`; the recovery manager
    // accepts the application store root and appends `audit/page-recovery`.
    const pendingRecoverySummaries = await listPendingRecoverySummaries(path.dirname(options.auditStorePath))
    const wrappedById = new Map(wrappedBooks.map(item => [String(item.raw.id), item]))
    for (const pending of pendingRecoverySummaries) {
      let remainingMissingPages = [...new Set((pending.remainingMissingPages || []).map(Number).filter(Number.isSafeInteger))].sort((a, b) => a - b)
      if (!remainingMissingPages.length) continue
      const wrapped = wrappedById.get(String(pending.bookId)) || wrappedBooks.find(item => normalizePath(item.raw.filepath) === normalizePath(pending.filepath))
      const health = wrapped ? healthById.get(String(wrapped.raw.id)) : null
      const actual = wrapped ? wrapped.actual : null
      if (!wrapped || !health || !actual) continue
      if (health.imageSequence?.status === 'checked') {
        const checkedGroups = health.imageSequence.checkedGroups || []
        const hasLocalSequenceIssue = Number(health.imageSequence.gapCount) > 0 ||
          checkedGroups.some(group => Number(group.first) > 1)
        const storedPageCount = Number(wrapped.raw.pageCount)
        if (!hasLocalSequenceIssue && Number.isSafeInteger(storedPageCount) && storedPageCount === Number(health.pageCount)) continue
        const currentMissingPages = new Set(getRecoveryMissingPages(health, 0))
        remainingMissingPages = remainingMissingPages.filter(page => currentMissingPages.has(page))
        if (!remainingMissingPages.length) continue
      }
      const currentUrl = wrapped.effective.url || null
      const pendingEvidence = {
        recoveryId: pending.recoveryId,
        onlinePageCount: Number(pending.online?.pageCount) || null,
        remainingMissingPages,
        source: pending.source || null,
        appliedAt: pending.appliedAt || null
      }
      const existing = anomalies.find(item => item.type === 'archive-image-sequence-gap' && String(item.bookId) === String(wrapped.raw.id))
      if (existing) {
        existing.reason = `${existing.reason}；写回后仍有 ${remainingMissingPages.length} 个待确认缺页`
        existing.evidence = {
          ...(existing.evidence || {}),
          currentUrl: currentUrl || existing.evidence?.currentUrl || null,
          pendingPageRecovery: pendingEvidence
        }
        continue
      }
      anomalies.push(makeAnomaly('archive-image-sequence-gap', 'high', {
        bookId: wrapped.raw.id,
        filepath: wrapped.raw.filepath,
        reason: `写回后仍有 ${remainingMissingPages.length} 个待确认缺页`,
        evidence: {
          basis: 'page-recovery-remaining-pages',
          pageCount: health.pageCount,
          currentUrl,
          ehviewer: health.ehviewer?.gid && health.ehviewer?.token ? health.ehviewer : null,
          ehviewerUrl: health.ehviewer?.gid && health.ehviewer?.token
            ? buildGalleryUrl('exhentai', health.ehviewer.gid, health.ehviewer.token)
            : null,
          imageSequence: health.imageSequence,
          pendingPageRecovery: pendingEvidence
        },
        recommendedAction: 'review'
      }))
    }

    recordTiming('recoveryReviewMs', performance.now() - recoveryStarted)
    const onlineStarted = performance.now()
    const onlineChecks = []
    let versionChainMatches = 0
    const onlinePolicy = options.onlinePolicy || 'none'
    if (onlinePolicy !== 'none') {
      const requestedIds = new Set((options.onlineBookIds || []).map(value => String(value)))
      const localConflictIds = new Set(anomalies
        .filter(item => item.bookId && [
          'filename-url-id-conflict',
          'tagged-without-source',
          'ehviewer-invalid',
          'ehviewer-url-conflict',
          'ehviewer-source-recoverable',
          'unverified-page-mismatch'
        ].includes(item.type))
        .map(item => String(item.bookId)))
      const sources = []
      for (const wrapped of wrappedBooks) {
        if (!wrapped.actual || (requestedIds.size && !requestedIds.has(String(wrapped.raw.id)))) continue
        // A non-EH metadata source is not a missing or unavailable EH identity.
        if (String(wrapped.effective.url || '').trim() && getMetadataSourceProvider(wrapped.effective.url) !== 'ehentai') continue
        const currentIdentity = extractEhentaiIdentity(wrapped.effective.url)
        const ehviewer = healthById.get(String(wrapped.raw.id))?.ehviewer || null
        const ehviewerIdentity = !confirmedBookIds.has(String(wrapped.raw.id)) && ehviewer?.status === 'parsed' && ehviewer.gid && ehviewer.token
          ? { gid: String(ehviewer.gid), token: String(ehviewer.token).toLowerCase() }
          : null
        const identitiesConflict = Boolean(ehviewerIdentity) && (!currentIdentity || currentIdentity.gid !== ehviewerIdentity.gid || currentIdentity.token !== ehviewerIdentity.token)
        const invalidEhviewer = ehviewer?.status === 'invalid'
        const include = onlinePolicy === 'urls'
          ? Boolean(currentIdentity)
          : onlinePolicy === 'ehviewer'
            ? Boolean(ehviewerIdentity || (invalidEhviewer && currentIdentity))
            : identitiesConflict || localConflictIds.has(String(wrapped.raw.id))
        if (include) sources.push({ wrapped, currentIdentity, ehviewer, ehviewerIdentity, invalidEhviewer })
      }

      const identities = new Map()
      for (const source of sources) {
        for (const identity of [source.currentIdentity, source.ehviewerIdentity]) {
          if (identity) identities.set(`${identity.gid}:${identity.token}`, {
            ...identity,
            currentItem: toCurrentItem(source.wrapped)
          })
        }
      }
      completed = 0
      const availabilityStarted = performance.now()
      for (const [key, identity] of identities) {
        assertNotCancelled()
        progress('checking-online-sources', completed, identities.size, identity.currentItem)
        const result = await checkGallerySites({
          ...identity,
          preferredSite: 'exhentai',
          strategy: 'both',
          force: Boolean(options.forceOnline),
          setting: options.ehentaiSetting || {},
          cache: availabilityCache
        })
        identities.set(key, result)
        onlineChecks.push(result)
        completed += 1
        progress('checking-online-sources', completed, identities.size, identity.currentItem)
      }

      recordTiming('siteAvailabilityMs', performance.now() - availabilityStarted)
      const gdataStarted = performance.now()
      const versionIdentities = new Map()
      for (const source of sources) {
        const recoverySupport = source.invalidEhviewer
          ? getEhviewerRepairSupport({ filepath: source.wrapped.raw.filepath, type: source.wrapped.raw.type })
          : null
        if (source.invalidEhviewer && source.currentIdentity && recoverySupport.supported) {
          versionIdentities.set(`${source.currentIdentity.gid}:${source.currentIdentity.token}`, {
            ...source.currentIdentity,
            currentItem: toCurrentItem(source.wrapped)
          })
        }
        if (!source.currentIdentity && source.ehviewerIdentity) {
          versionIdentities.set(`${source.ehviewerIdentity.gid}:${source.ehviewerIdentity.token}`, {
            ...source.ehviewerIdentity,
            currentItem: toCurrentItem(source.wrapped)
          })
        }
        if (!source.currentIdentity || !source.ehviewerIdentity) continue
        if (source.currentIdentity.gid === source.ehviewerIdentity.gid && source.currentIdentity.token === source.ehviewerIdentity.token) continue
        for (const identity of [source.currentIdentity, source.ehviewerIdentity]) {
          versionIdentities.set(`${identity.gid}:${identity.token}`, {
            ...identity,
            currentItem: toCurrentItem(source.wrapped)
          })
        }
      }
      const versionMetadata = versionIdentities.size > 0
        ? await getGdataBatch({
            identities: [...versionIdentities.values()],
            setting: options.ehentaiSetting || {},
            cache: availabilityCache,
            force: Boolean(options.forceOnline),
            onProgress: (done, total) => {
              const values = [...versionIdentities.values()]
              const current = values[Math.min(Math.max(done, 1), values.length) - 1]
              progress('checking-gallery-versions', done, total, current?.currentItem || null)
            }
          })
        : new Map()
      recordTiming('gdataMs', performance.now() - gdataStarted)

      for (const source of sources) {
        const { wrapped, currentIdentity, ehviewer, ehviewerIdentity } = source
        const currentAvailability = currentIdentity ? identities.get(`${currentIdentity.gid}:${currentIdentity.token}`) : null
        const ehviewerAvailability = ehviewerIdentity ? identities.get(`${ehviewerIdentity.gid}:${ehviewerIdentity.token}`) : null
        const currentPageGdata = currentIdentity ? versionMetadata.get(`${currentIdentity.gid}:${currentIdentity.token}`) : null
        const ehviewerPageGdata = ehviewerIdentity ? versionMetadata.get(`${ehviewerIdentity.gid}:${ehviewerIdentity.token}`) : null
        const currentUrl = wrapped.effective.url || null
        const localPages = healthById.get(String(wrapped.raw.id))?.pageCount ?? null
        const pageSources = {
          currentUrl: toPageSourceEvidence({ url: currentUrl, gdata: currentPageGdata }),
          ehviewerUrl: toPageSourceEvidence({
            url: ehviewerIdentity ? buildGalleryUrl('exhentai', ehviewerIdentity.gid, ehviewerIdentity.token) : null,
            gdata: ehviewerPageGdata
          })
        }
        const pageMismatchAnomaly = anomalies.find(item => String(item.bookId) === String(wrapped.raw.id) &&
          ['unverified-page-mismatch', 'exact-source-page-mismatch'].includes(item.type))
        if (pageMismatchAnomaly) {
          pageMismatchAnomaly.evidence = { ...(pageMismatchAnomaly.evidence || {}), pageSources }
        }
        const evidence = { currentUrl, ehviewer, currentAvailability, ehviewerAvailability, localPages, pageSources }
        const currentAvailable = isIdentityWebAvailable(currentAvailability)
        const currentStatus = summarizeAvailability(currentAvailability)
        if (currentAvailability && currentStatus !== 'available') {
          anomalies.push(makeAnomaly(`gallery-${currentStatus}`, currentStatus === 'copyright' ? 'high' : 'medium', {
            bookId: wrapped.raw.id,
            filepath: wrapped.raw.filepath,
            reason: '当前 gallery 网页不可正常访问',
            evidence,
            recommendedAction: 'review-source-availability'
          }))
        }
        if (currentIdentity && currentAvailability) {
          const availableUrl = getSameIdentityFallbackUrl(currentAvailability, currentUrl)
          if (availableUrl) {
            anomalies.push(makeAnomaly('gallery-domain-fallback', 'medium', {
              bookId: wrapped.raw.id,
              filepath: wrapped.raw.filepath,
              reason: '当前站点不可用，但另一站点可访问同一 gallery',
              evidence: { ...evidence, availableUrl },
              recommendedAction: 'repair-url-after-approval',
              action: {
                type: 'repair-url',
                repairKind: 'same-identity-domain-switch',
                bookId: wrapped.raw.id,
                filepath: wrapped.raw.filepath,
                expectedSize: wrapped.actual.size,
                expectedMtimeMs: wrapped.actual.mtimeMs,
                currentUrl,
                newUrl: availableUrl,
                availabilityProof: { checkedAt: Date.now(), current: currentAvailability, candidate: currentAvailability }
              }
            }))
          }
        }
        if (source.invalidEhviewer) {
          const invalidAnomaly = anomalies.find(item => item.type === 'ehviewer-invalid' && String(item.bookId) === String(wrapped.raw.id))
          const recoverySupport = getEhviewerRepairSupport({ filepath: wrapped.raw.filepath, type: wrapped.raw.type })
          const currentGdata = currentIdentity ? versionMetadata.get(`${currentIdentity.gid}:${currentIdentity.token}`) : null
          const recoveryIdentity = normalizeEhviewerIdentity(currentIdentity)
          const recoveryTitle = sanitizeEhviewerTitle(wrapped.effective.title_jpn || wrapped.effective.title)
          if (invalidAnomaly) {
            invalidAnomaly.evidence = {
              ...(invalidAnomaly.evidence || {}),
              currentUrl,
              currentAvailability,
              currentGdataStatus: currentGdata?.status || 'unchecked',
              recoverySupport
            }
            if (recoverySupport.supported && recoveryIdentity && recoveryTitle && currentGdata?.status === 'available') {
              invalidAnomaly.recommendedAction = 'rebuild-ehviewer-after-approval'
              invalidAnomaly.action = {
                type: 'repair-ehviewer',
                repairKind: 'ehviewer-rebuild-from-current-metadata',
                bookId: wrapped.raw.id,
                filepath: wrapped.raw.filepath,
                bookType: wrapped.raw.type,
                expectedSize: wrapped.actual.size,
                expectedMtimeMs: wrapped.actual.mtimeMs,
                currentUrl,
                expectedTitle: recoveryTitle,
                entryPath: ehviewer.entryPath || '.ehviewer',
                identity: recoveryIdentity,
                availabilityProof: {
                  checkedAt: Date.now(),
                  current: currentAvailability,
                  currentGdataStatus: currentGdata.status
                }
              }
            }
          }
        }
        if (!ehviewerIdentity || !ehviewerAvailability) continue
        const sourceRecoverableAnomaly = !currentIdentity
          ? anomalies.find(item => item.type === 'ehviewer-source-recoverable' && String(item.bookId) === String(wrapped.raw.id))
          : null
        if (sourceRecoverableAnomaly) {
          const candidateGdata = versionMetadata.get(`${ehviewerIdentity.gid}:${ehviewerIdentity.token}`)
          const sourceRecoveryAction = buildSourceRecoveryAction({
            bookId: wrapped.raw.id,
            filepath: wrapped.raw.filepath,
            expectedSize: wrapped.actual.size,
            expectedMtimeMs: wrapped.actual.mtimeMs,
            currentUrl,
            candidateIdentity: ehviewerIdentity,
            candidateAvailability: ehviewerAvailability,
            candidateGdata
          })
          sourceRecoverableAnomaly.evidence = {
            ...(sourceRecoverableAnomaly.evidence || {}),
            ehviewerAvailability,
            candidateGdataStatus: candidateGdata?.status || 'unchecked'
          }
          sourceRecoverableAnomaly.recommendedAction = sourceRecoveryAction
            ? 'recover-source-after-approval'
            : 'review-source-availability'
          sourceRecoverableAnomaly.action = sourceRecoveryAction
          continue
        }
        const currentGdata = currentIdentity ? versionMetadata.get(`${currentIdentity.gid}:${currentIdentity.token}`) : null
        const currentTitle = sanitizeEhviewerTitle(wrapped.effective.title_jpn || wrapped.effective.title)
        const currentRecoveryIdentity = normalizeEhviewerIdentity(currentIdentity)
        if (currentIdentity && currentAvailable && isConclusiveUnavailable(ehviewerAvailability)) {
          const recoverySupport = getEhviewerRepairSupport({ filepath: wrapped.raw.filepath, type: wrapped.raw.type })
          const syncAction = buildEhviewerSyncAction({
            bookId: wrapped.raw.id,
            filepath: wrapped.raw.filepath,
            bookType: wrapped.raw.type,
            expectedSize: wrapped.actual.size,
            expectedMtimeMs: wrapped.actual.mtimeMs,
            currentUrl,
            currentIdentity: currentRecoveryIdentity,
            currentTitle,
            entryPath: ehviewer.entryPath,
            recoverySupport,
            currentAvailability,
            candidateAvailability: ehviewerAvailability,
            currentGdata
          })
          const syncAnomaly = makeAnomaly('ehviewer-url-conflict-online', 'high', {
            bookId: wrapped.raw.id,
            filepath: wrapped.raw.filepath,
            reason: '当前 URL 可访问，但 .ehviewer 对应 Gallery 不可用',
            evidence: {
              ...evidence,
              currentGdataStatus: currentGdata?.status || 'unchecked',
              recoverySupport,
              repairTarget: 'current-url'
            },
            recommendedAction: syncAction
              ? 'rebuild-ehviewer-after-approval'
              : recoverySupport.supported ? 'manual-review' : 'manual-replace-ehviewer',
            action: syncAction
          })
          anomalies.push(syncAnomaly)
          continue
        }
        const sameIdentity = currentIdentity && currentIdentity.gid === ehviewerIdentity.gid && currentIdentity.token === ehviewerIdentity.token
        if (sameIdentity) continue
        const candidateGdata = versionMetadata.get(`${ehviewerIdentity.gid}:${ehviewerIdentity.token}`)
        const versionRelation = currentGdata?.status === 'available' && candidateGdata?.status === 'available'
          ? getGalleryVersionRelation({
              currentMetadata: currentGdata.metadata,
              candidateMetadata: candidateGdata.metadata,
              currentIdentity,
              candidateIdentity: ehviewerIdentity
            })
          : null
        if (versionRelation?.sameChain) {
          versionChainMatches += 1
          removeVersionChainNoise(anomalies, wrapped.raw.id, versionRelation)
          const versionEvidence = {
            ...evidence,
            versionRelation,
            currentVersion: {
              gid: String(currentGdata.metadata.gid),
              token: String(currentGdata.metadata.token || currentIdentity.token)
            },
            ehviewerVersion: {
              gid: String(candidateGdata.metadata.gid),
              token: String(candidateGdata.metadata.token || ehviewerIdentity.token)
            }
          }
          if (versionRelation.status === 'current-latest' || versionRelation.status === 'same-version') continue

          let versionAction = null
          let versionReason = '当前 URL 与 .ehviewer 属于同一 Gallery 版本链'
          if (versionRelation.status === 'candidate-latest' && isIdentityWebAvailable(ehviewerAvailability)) {
            const newUrl = pickAvailableUrl(ehviewerAvailability, 'exhentai')
            versionReason = '当前 URL 是历史版本，.ehviewer 指向最新 Gallery 版本'
            versionAction = {
              type: 'repair-url',
              repairKind: 'gallery-version-upgrade',
              bookId: wrapped.raw.id,
              filepath: wrapped.raw.filepath,
              expectedSize: wrapped.actual.size,
              expectedMtimeMs: wrapped.actual.mtimeMs,
              currentUrl,
              newUrl,
              availabilityProof: {
                checkedAt: Date.now(),
                current: currentAvailability,
                candidate: ehviewerAvailability,
                versionRelation
              }
            }
          } else if (versionRelation.status === 'latest-other') {
            versionReason = '当前 URL 与 .ehviewer 均为历史版本，Gallery 另有最新版本'
          }
          anomalies.push(makeAnomaly('gallery-version-outdated', 'medium', {
            bookId: wrapped.raw.id,
            filepath: wrapped.raw.filepath,
            reason: versionReason,
            evidence: versionEvidence,
            recommendedAction: versionAction ? 'upgrade-gallery-version-after-approval' : 'review-latest-gallery-version',
            action: versionAction
          }))
          continue
        }
        const decision = decideIdentityConflict({
          currentAvailability,
          candidateAvailability: ehviewerAvailability,
          currentIdentityPresent: Boolean(currentIdentity)
        })
        const candidateAvailable = isIdentityWebAvailable(ehviewerAvailability)
        let action = null
        let recommendation = 'manual-review'
        if (decision.actionable) {
          const metadataResult = candidateGdata || await getGalleryMetadata({
            ...ehviewerIdentity,
            preferredSite: 'exhentai',
            forceAvailability: false,
            setting: options.ehentaiSetting || {},
            cache: availabilityCache
          }).then(result => result.gdata)
          if (metadataResult.status === 'available') {
            const newUrl = pickAvailableUrl(ehviewerAvailability, 'exhentai')
            recommendation = 'repair-url-after-approval'
            action = {
              type: 'repair-url',
              repairKind: 'identity-replacement',
              bookId: wrapped.raw.id,
              filepath: wrapped.raw.filepath,
              expectedSize: wrapped.actual.size,
              expectedMtimeMs: wrapped.actual.mtimeMs,
              currentUrl,
              newUrl,
              availabilityProof: {
                checkedAt: Date.now(),
                current: currentAvailability,
                candidate: ehviewerAvailability,
                candidateGdataStatus: metadataResult.status
              }
            }
          }
        }
        anomalies.push(makeAnomaly('ehviewer-url-conflict-online', 'critical', {
          bookId: wrapped.raw.id,
          filepath: wrapped.raw.filepath,
          reason: currentAvailable && candidateAvailable
            ? '当前 URL 与 .ehviewer 均可访问，但指向不同 gallery'
            : candidateAvailable && !currentAvailable
              ? '.ehviewer gallery 可访问，当前 gallery 不可用'
              : '当前 URL 与 .ehviewer 身份冲突，在线状态不足以自动决策',
          evidence,
          recommendedAction: action ? recommendation : decision.outcome,
          action
        }))
      }
    }

    recordTiming('onlineMs', performance.now() - onlineStarted)
    progress('finalizing-report', 0, 1, null)
    const classifiedAnomalies = classifyAnomalies(anomalies)
    sortAnomalies(classifiedAnomalies)
    const workflowSummary = getWorkflowSummary({ anomalies: classifiedAnomalies })
    performanceData.timings.totalMs = Math.round(performance.now() - started)
    const report = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      workflowVersion: 2,
      reportType: 'anomaly',
      reportId: getReportId('anomaly', jobId),
      jobId,
      legacy: false,
      executable: true,
      createdAt: snapshot.createdAt,
      source: { library: options.library, databasePath: options.databasePath, metadataPath: options.metadataPath },
      options: {
        workflow: options.workflow === 'standard' ? 'standard' : 'legacy',
        forceLocal: Boolean(options.forceLocal),
        onlinePolicy,
        forceOnline: Boolean(options.forceOnline)
      },
      summary: {
        libraryItems: snapshot.actualItems.length,
        mangaRows: snapshot.books.length,
        metadataRows: snapshot.metadataRows.length,
        anomalies: classifiedAnomalies.length,
        anomalyBooks: new Set(classifiedAnomalies.filter(item => item.bookId).map(item => String(item.bookId))).size,
        actionableAnomalies: classifiedAnomalies.filter(item => item.action).length,
        ...workflowSummary,
        onlineIdentities: onlineChecks.length,
        onlineCopyright: onlineChecks.filter(item => Object.values(item.sites).some(site => site.status === 'copyright')).length,
        onlineAvailable: onlineChecks.filter(item => isIdentityWebAvailable(item)).length,
        versionChainMatches,
        confirmedSources: confirmedBookIds.size
      },
      anomalies: classifiedAnomalies,
      onlineChecks,
      performance: performanceData
    }
    const reportPath = path.join(jobDir, 'report.json')
    await atomicWriteJson(reportPath, report)
    progress('finalizing-report', 1, 1, null)
    return { reportPath, summary: report.summary }
  } finally {
    if (availabilityCache) await availabilityCache.close()
    if (cache) await cache.close()
  }
})

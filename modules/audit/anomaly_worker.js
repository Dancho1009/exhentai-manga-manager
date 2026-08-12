const path = require('path')
const { workerData } = require('worker_threads')
const { buildSnapshot } = require('./library_snapshot.js')
const { analyzeEntityAnomalies, makeAnomaly } = require('./anomaly_analyzer.js')
const { AuditCache } = require('./cache.js')
const { EhentaiAvailabilityCache } = require('../ehentai_availability_cache.js')
const {
  checkGallerySites,
  getGalleryMetadata,
  extractGalleryIdentity: extractEhentaiIdentity,
  isIdentityWebAvailable
} = require('../ehentai.js')
const {
  summarizeAvailability,
  pickAvailableUrl,
  getSameIdentityFallbackUrl,
  decideIdentityConflict
} = require('./online_decision.js')
const { inspectBookHealth } = require('./archive_inspector.js')
const { atomicWriteJson, normalizePath } = require('./utils.js')
const { REPORT_SCHEMA_VERSION, getReportId } = require('./report_repository.js')
const { createWorkerRuntime, mapWithConcurrency } = require('./worker_runtime.js')

const LOCAL_INSPECTION_CONCURRENCY = 4
const runtime = createWorkerRuntime()

const sortAnomalies = anomalies => {
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 }
  anomalies.sort((left, right) => severityOrder[left.severity] - severityOrder[right.severity] || left.type.localeCompare(right.type))
}

runtime.run(async ({ isCancelled, assertNotCancelled, progress, log }) => {
  const { options, jobDir, jobId } = workerData
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
      isCancelled
    })
    const anomalies = analyzeEntityAnomalies(snapshot)
    const actualByPath = new Map(snapshot.actualItems.map(item => [normalizePath(item.filepath), item]))
    const wrappedBooks = snapshot.books.map(wrapped => ({ ...wrapped, actual: actualByPath.get(normalizePath(wrapped.raw.filepath)) }))
    const healthById = new Map()
    let completed = 0
    const inspectTargets = wrappedBooks.filter(item => item.actual)
    const healthResults = await mapWithConcurrency(inspectTargets, LOCAL_INSPECTION_CONCURRENCY, async wrapped => {
      assertNotCancelled()
      let health
      try {
        const cached = options.forceLocal ? null : await cache.get(wrapped.raw, wrapped.actual)
        health = cached?.healthInspection || await inspectBookHealth(wrapped.raw, { sevenZipPath: options.sevenZipPath })
        if (!cached?.healthInspection || options.forceLocal) {
          await cache.update(wrapped.raw, wrapped.actual, {
            healthInspection: health,
            ehviewerInspection: health.ehviewer
          })
        }
      } catch (error) {
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
      } finally {
        completed += 1
        progress('inspecting-book-health', completed, inspectTargets.length)
      }
      return { wrapped, health, anomaly: null }
    }, isCancelled)

    for (const { wrapped, health, anomaly } of healthResults) {
      if (anomaly) {
        anomalies.push(anomaly)
        continue
      }
      healthById.set(String(wrapped.raw.id), health)
      if (health.pageCount === 0) {
        anomalies.push(makeAnomaly('archive-no-images', 'high', {
          bookId: wrapped.raw.id,
          filepath: wrapped.raw.filepath,
          reason: '作品中没有支持的图片文件',
          evidence: { pageCount: health.pageCount }
        }))
      }
      if (Number(wrapped.raw.pageCount || 0) !== Number(health.pageCount || 0)) {
        anomalies.push(makeAnomaly('scan-page-count-stale', 'medium', {
          bookId: wrapped.raw.id,
          filepath: wrapped.raw.filepath,
          reason: '数据库本地页数与实际图片数量不一致',
          evidence: { databasePages: wrapped.raw.pageCount, actualPages: health.pageCount },
          recommendedAction: 'targeted-rescan'
        }))
      }
      const ehviewer = health.ehviewer
      if (['ambiguous', 'invalid'].includes(ehviewer?.status)) {
        anomalies.push(makeAnomaly(`ehviewer-${ehviewer.status}`, 'high', {
          bookId: wrapped.raw.id,
          filepath: wrapped.raw.filepath,
          reason: ehviewer.status === 'ambiguous' ? '存在多个 .ehviewer，无法自动确认身份' : '.ehviewer 无法解析',
          evidence: ehviewer
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

    const onlineChecks = []
    const onlinePolicy = options.onlinePolicy || 'none'
    if (onlinePolicy !== 'none') {
      const requestedIds = new Set((options.onlineBookIds || []).map(value => String(value)))
      const localConflictIds = new Set(anomalies
        .filter(item => item.bookId && [
          'filename-url-id-conflict',
          'tagged-without-source',
          'ehviewer-url-conflict',
          'ehviewer-source-recoverable',
          'exact-source-page-mismatch',
          'unverified-page-mismatch'
        ].includes(item.type))
        .map(item => String(item.bookId)))
      const sources = []
      for (const wrapped of wrappedBooks) {
        if (!wrapped.actual || (requestedIds.size && !requestedIds.has(String(wrapped.raw.id)))) continue
        const currentIdentity = extractEhentaiIdentity(wrapped.effective.url)
        const ehviewer = healthById.get(String(wrapped.raw.id))?.ehviewer || null
        const ehviewerIdentity = ehviewer?.status === 'parsed' && ehviewer.gid && ehviewer.token
          ? { gid: String(ehviewer.gid), token: String(ehviewer.token).toLowerCase() }
          : null
        const identitiesConflict = Boolean(ehviewerIdentity) && (!currentIdentity || currentIdentity.gid !== ehviewerIdentity.gid || currentIdentity.token !== ehviewerIdentity.token)
        const include = onlinePolicy === 'urls'
          ? Boolean(currentIdentity)
          : onlinePolicy === 'ehviewer'
            ? Boolean(ehviewerIdentity)
            : identitiesConflict || localConflictIds.has(String(wrapped.raw.id))
        if (include) sources.push({ wrapped, currentIdentity, ehviewer, ehviewerIdentity })
      }

      const identities = new Map()
      for (const source of sources) {
        for (const identity of [source.currentIdentity, source.ehviewerIdentity]) {
          if (identity) identities.set(`${identity.gid}:${identity.token}`, identity)
        }
      }
      completed = 0
      for (const [key, identity] of identities) {
        assertNotCancelled()
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
        progress('checking-online-sources', completed, identities.size)
      }

      for (const source of sources) {
        const { wrapped, currentIdentity, ehviewer, ehviewerIdentity } = source
        const currentAvailability = currentIdentity ? identities.get(`${currentIdentity.gid}:${currentIdentity.token}`) : null
        const ehviewerAvailability = ehviewerIdentity ? identities.get(`${ehviewerIdentity.gid}:${ehviewerIdentity.token}`) : null
        const currentUrl = wrapped.effective.url || null
        const evidence = { currentUrl, ehviewer, currentAvailability, ehviewerAvailability }
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
        if (!ehviewerIdentity || !ehviewerAvailability) continue
        const sameIdentity = currentIdentity && currentIdentity.gid === ehviewerIdentity.gid && currentIdentity.token === ehviewerIdentity.token
        if (sameIdentity) continue
        const decision = decideIdentityConflict({
          currentAvailability,
          candidateAvailability: ehviewerAvailability,
          currentIdentityPresent: Boolean(currentIdentity)
        })
        const currentAvailable = isIdentityWebAvailable(currentAvailability)
        const candidateAvailable = isIdentityWebAvailable(ehviewerAvailability)
        let action = null
        let recommendation = 'manual-review'
        if (decision.actionable) {
          const metadataResult = await getGalleryMetadata({
            ...ehviewerIdentity,
            preferredSite: 'exhentai',
            forceAvailability: false,
            setting: options.ehentaiSetting || {},
            cache: availabilityCache
          })
          if (metadataResult.gdata.status === 'available') {
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
                candidateGdataStatus: metadataResult.gdata.status
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

    sortAnomalies(anomalies)
    const report = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      reportType: 'anomaly',
      reportId: getReportId('anomaly', jobId),
      jobId,
      legacy: false,
      executable: true,
      createdAt: snapshot.createdAt,
      source: { library: options.library, databasePath: options.databasePath, metadataPath: options.metadataPath },
      options: {
        forceLocal: Boolean(options.forceLocal),
        onlinePolicy,
        forceOnline: Boolean(options.forceOnline)
      },
      summary: {
        libraryItems: snapshot.actualItems.length,
        mangaRows: snapshot.books.length,
        metadataRows: snapshot.metadataRows.length,
        anomalies: anomalies.length,
        anomalyBooks: new Set(anomalies.filter(item => item.bookId).map(item => String(item.bookId))).size,
        actionableAnomalies: anomalies.filter(item => item.action).length,
        onlineIdentities: onlineChecks.length,
        onlineCopyright: onlineChecks.filter(item => Object.values(item.sites).some(site => site.status === 'copyright')).length,
        onlineAvailable: onlineChecks.filter(item => isIdentityWebAvailable(item)).length
      },
      anomalies,
      onlineChecks
    }
    const reportPath = path.join(jobDir, 'report.json')
    await atomicWriteJson(reportPath, report)
    return { reportPath, summary: report.summary }
  } finally {
    if (availabilityCache) await availabilityCache.close()
    if (cache) await cache.close()
  }
})

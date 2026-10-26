const fs = require('fs')
const path = require('path')
const { EventEmitter, setMaxListeners } = require('events')
const { randomUUID } = require('crypto')
const { normalizeAiConfig, resolveAiConfig, buildCompatibleRequestOptions } = require('../ai_service.js')
const { createAiLogger, safeAiLog } = require('../ai_logger.js')
const { AuditCache } = require('./cache.js')
const { atomicWriteJson, stableId } = require('./utils.js')
const { DEDUPE_RULES_VERSION } = require('./dedupe_title.js')
const { bookSnapshotKey, legacyBookSnapshotKey } = require('./ai_snapshot.js')
const { AI_PROMPT_VERSION, AI_CLASSIFY_VERSION, AI_VALIDATION_REASONS, AI_NORMALIZE_SYSTEM_PROMPT, AI_CLASSIFY_SYSTEM_PROMPT, AI_EVIDENCE_REPAIR_PROMPT, AI_RELATION_SCHEMA, AI_CLASSIFICATION_SCHEMA, buildRelationRequest, validateRelationResult } = require('./ai_relation_contract.js')
const { iterateSemanticCandidateChunks } = require('./semantic_candidates.js')
const { buildSeriesReport, collectPublicationRelations } = require('./series_analyzer.js')

const idleState = () => ({ status: 'idle', task: null, runId: null, phase: null, completed: 0, total: 0, cached: 0, failed: 0,
  requests: 0, classificationSucceeded: 0, classificationFailed: 0, classificationCached: 0, classificationMissing: 0,
  normalizationSucceeded: 0, normalizationCached: 0, normalizationRequested: 0, normalizationFailed: 0,
  normalizationSaved: 0, normalizationMigrated: 0, normalizationFailedBooks: 0, normalizationMissing: 0, normalizationSubmitted: 0,
  normalizationFirstPassSaved: 0, normalizationRetrySaved: 0, normalizationRetryPending: 0,
  candidateCount: 0, candidateTruncated: false,
  relationCounts: { same_work_same_part: 0, same_work_different_edition: 0, same_work_left_contains_right: 0,
    same_work_right_contains_left: 0, same_work_partial_overlap: 0, same_series_different_part: 0,
    same_publication_different_issue: 0, unrelated: 0, unknown: 0 },
  limited: false, candidateLimit: false, partial: false, error: null, errorDetail: null, currentTitle: null, startedAt: null, completedAt: null })
const loadJson = async (filename, fallback) => {
  try { return JSON.parse(await fs.promises.readFile(filename, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error }
}
const semanticCacheKey = (book, promptVersion = AI_PROMPT_VERSION) => stableId(
  'ai-semantic-v4', bookSnapshotKey(book), promptVersion
)
const semanticCacheIdentity = (book, snapshotKey, promptVersion, rulesVersion) => `${book.id}:${snapshotKey}:${promptVersion}:${rulesVersion}`
const cacheEnvelope = (value, { source, snapshotKey, promptVersion = AI_PROMPT_VERSION, rulesVersion = DEDUPE_RULES_VERSION, migratedFrom = null } = {}) => ({
  kind: 'book-semantic', version: 3, value, snapshotKey, promptVersion, rulesVersion,
  source: { ...source, ...(migratedFrom ? { migratedFrom } : {}) }, createdAt: new Date().toISOString()
})
const aborted = () => Object.assign(new Error('AI_CANCELLED'), { code: 'AI_CANCELLED' })
const stopsBatch = error => ['AI_AUTH_FAILED', 'AI_AUTH_REQUIRED', 'AI_OAUTH_REQUIRED', 'AI_OAUTH_EXPIRED',
  'AI_OAUTH_REFRESH_FAILED', 'AI_OAUTH_SCOPE_REQUIRED', 'AI_OAUTH_IDENTITY_INVALID', 'AI_OAUTH_RELOGIN_REQUIRED',
  'AI_REASONING_UNSUPPORTED', 'AI_REQUEST_OPTIONS_UNSUPPORTED', 'AI_RATE_LIMITED', 'AI_PLAN_UNAVAILABLE', 'AI_RESPONSE_TOO_LARGE'].includes(error.code)
const publicError = error => String(error.code || error.message || '').match(/^(AI_[A-Z_]+)(?::|$)/)?.[1] || 'AI_ANALYSIS_FAILED'
const publicErrorDetail = (error, books = []) => {
  const detail = error.validation
  if (publicError(error) !== 'AI_RESULT_INVALID' || !AI_VALIDATION_REASONS.includes(detail?.reason)) return null
  const result = { reason: detail.reason }
  if (typeof detail.path === 'string' && detail.path.length <= 200 && /^[a-zA-Z]+(?:\[\d+\])?(?:\.[a-zA-Z]+(?:\[\d+\])?)*$/.test(detail.path)) result.path = detail.path
  if (books.some(book => book.id === detail.bookId)) result.bookId = detail.bookId
  return result
}

class AiReviewService extends EventEmitter {
  constructor({ storePath, coordinator, aiService, getConfig, loadBooks, getDedupeReport, logger = createAiLogger(), now = Date.now, traceStore }) {
    super()
    this.root = path.join(storePath, 'audit', 'ai')
    this.auditPath = path.join(storePath, 'audit')
    Object.assign(this, { coordinator, aiService, getConfig, loadBooks, getDedupeReport, logger, now, traceStore })
    this.state = idleState()
    this.results = new Map()
    this.writeQueue = Promise.resolve()
    this.activePromise = null
    this.controller = null
    this.finishing = false
    this.loggedPhase = null
  }

  async initialize() {
    await fs.promises.mkdir(this.root, { recursive: true })
    await fs.promises.mkdir(path.join(this.root, 'runs'), { recursive: true })
    this.state = { ...idleState(), ...await loadJson(path.join(this.root, 'state.json'), {}) }
    const saved = await loadJson(path.join(this.root, 'results.json'), [])
    this.results = new Map(saved.map(result => [result.id, result]))
    if (['running', 'cancelling'].includes(this.state.status)) {
      this.state = { ...this.state, status: 'interrupted', currentTitle: null }
      await this.persist()
    }
  }

  get running() { return Boolean(this.activePromise || this.controller || this.finishing) }
  getState() { return { ...this.state } }
  trace(event, details) { safeAiLog(this.logger, event, details) }
  publish(patch) {
    Object.assign(this.state, patch)
    if (this.state.runId) this.traceStore?.run(this.state.runId, { ...this.state,
      totalBooks: this.state.totalBooks, cachedBooks: this.state.normalizationCached, savedBooks: this.state.normalizationSaved,
      failedBooks: this.state.normalizationFailedBooks, missingBooks: this.state.normalizationMissing })
    if (this.state.status === 'running' && this.state.phase !== this.loggedPhase) {
      this.loggedPhase = this.state.phase
      this.trace('task:progress', { task: this.state.task, phase: this.state.phase, status: 'running',
        totalCount: this.state.total, completedCount: this.state.completed, requestCount: this.state.requests, cachedCount: this.state.cached })
    }
    this.emit('state', this.getState())
  }
  persist() {
    const operation = this.writeQueue.then(async () => {
      await atomicWriteJson(path.join(this.root, 'results.json'), [...this.results.values()])
      await atomicWriteJson(path.join(this.root, 'state.json'), this.state)
    })
    this.writeQueue = operation.catch(() => {})
    return operation
  }

  persistRunManifest(manifest) {
    if (!manifest?.runId) return Promise.resolve()
    const operation = this.writeQueue.then(async () => {
      await fs.promises.mkdir(path.join(this.root, 'runs'), { recursive: true })
      await atomicWriteJson(path.join(this.root, 'runs', `${manifest.runId}.json`), manifest)
    })
    this.writeQueue = operation.catch(() => {})
    return operation
  }

  async waitForIdle() {
    const active = this.activePromise
    if (active) await active.catch(() => {})
    await this.writeQueue.catch(() => {})
  }

  async getResults({ task, reportId } = {}) {
    const results = [...this.results.values()].filter(item => (!task || item.task === task) && (!reportId || item.reportId === reportId))
    if (!results.length) return []
    const books = new Map((await this.loadBooks()).map(book => [book.id, book]))
    const report = results.some(item => item.task === 'dedupe') ? await this.getDedupeReport() : null
    const checked = await Promise.all(results.map(async result => {
      let stale = result.promptVersion !== AI_PROMPT_VERSION || result.rulesVersion !== DEDUPE_RULES_VERSION || result.books.some(book => !books.has(book.id) || bookSnapshotKey(books.get(book.id)) !== result.snapshotKeys[book.id])
      if (result.task === 'dedupe') {
        const group = report?.groups?.find(group => group.id === result.groupId)
        stale ||= Boolean(report?.stale || report?.outdatedRules || report?.reportId !== result.reportId || group?.evidenceRevision !== result.evidenceRevision)
        if (!stale) stale = !(await this.filesMatch(result.books))
      }
      return { ...result, stale }
    }))
    if (task === 'series') {
      const valid = checked.filter(result => !result.stale && result.status === 'completed')
      if (valid.length) {
        const members = [...new Map(valid.flatMap(result => result.books).map(book => [book.id, book])).values()]
        const relations = valid.flatMap(result => result.relations)
        const series = buildSeriesReport({ books: members, relations })
        return [{ id: 'series-summary', task: 'series', createdAt: valid.map(item => item.createdAt).sort().at(-1),
          books: members, relations: [], series, status: 'completed', stale: false }, ...checked.filter(result => result.stale || result.status === 'failed')]
      }
    }
    return checked
  }

  async filesMatch(books) {
    for (const book of books) {
      if (!Number.isFinite(book.mtimeMs)) continue
      try {
        const stat = await fs.promises.stat(book.filepath)
        if (Math.abs(stat.mtimeMs - book.mtimeMs) > 1 || (book.type !== 'folder' && stat.size !== book.size)) return false
      } catch { return false }
    }
    return true
  }

  async start(request = {}) {
    if (this.finishing) await this.waitForIdle()
    if (this.running) throw new Error('AI_ALREADY_RUNNING')
    if (!['dedupe', 'discovery', 'series'].includes(request.task)) throw new Error('AI_INVALID_TASK')
    const config = normalizeAiConfig(this.getConfig())
    if (!config.enabled || (request.task === 'series' ? !config.seriesEnabled : !config.dedupeEnabled)) throw new Error('AI_DISABLED')
    const jobId = `ai-${randomUUID()}`
    const runId = String(request.runId || `${request.task}-${randomUUID()}`)
    this.coordinator.beginAudit(jobId)
    const startedAt = this.now(), resolved = resolveAiConfig(config)
    this.controller = new AbortController()
    // Each in-flight request subscribes to this task's cancellation signal.
    setMaxListeners(Math.max(10, config.concurrency), this.controller.signal)
    this.loggedPhase = null
    this.state = { ...idleState(), status: 'running', task: request.task, runId, phase: 'preparing', startedAt: new Date().toISOString(),
      batchSize: config.normalizationBatchSize, concurrency: config.concurrency, force: request.force === true, provider: resolved.provider, model: resolved.model }
    this.trace('task:start', { task: request.task, provider: resolved.provider, model: resolved.model, status: 'running',
      ...(resolved.provider !== 'compatible' ? { reasoningEffort: resolved.reasoningEffort } : {}),
      normalizationBatchSize: config.normalizationBatchSize, concurrency: config.concurrency,
      stream: resolved.provider !== 'compatible' || resolved.stream })
    this.publish({})
    let finalState
    this.activePromise = this.run(request, config, this.controller.signal).then(() => {
      const allFailed = this.state.phase === 'normalizing'
        ? this.state.normalizationFailedBooks > 0 && this.state.normalizationSucceeded === 0
        : this.state.total > 0
        ? this.state.classificationFailed > 0 && this.state.classificationSucceeded === 0
        : this.state.failed > 0 && this.state.normalizationSucceeded === 0
      const incomplete = this.state.partial || this.state.failed > 0 || this.state.limited || this.state.normalizationMissing > 0 ||
        this.state.classificationMissing > 0 || (request.task !== 'dedupe' && this.state.normalizationSucceeded < this.state.totalBooks)
      finalState = { status: allFailed ? 'failed' : 'completed', phase: allFailed || incomplete ? this.state.phase : 'completed', partial: !allFailed && incomplete,
        error: allFailed ? this.state.error || 'AI_ANALYSIS_FAILED' : this.state.error }
    }).catch(error => {
      const cancelled = this.controller?.signal.aborted || error.code === 'AI_CANCELLED'
      finalState = { status: cancelled ? 'cancelled' : 'failed', error: cancelled ? null : publicError(error),
        errorDetail: cancelled ? null : publicErrorDetail(error) }
    }).finally(async () => {
      // Keep the service running until the final state is persisted. This
      // prevents a second IPC start from racing the cleanup of the prior job.
      this.finishing = true
      Object.assign(this.state, { currentTitle: null })
      this.controller = null
      this.coordinator.endAudit(jobId)
      // Save the interrupted/running marker first, then expose the completed
      // state only after its final write has finished. Consumers can therefore
      // safely use a completed state as the end of the job.
      await this.persist().catch(() => {})
      Object.assign(this.state, { ...(finalState || { status: 'failed', error: 'AI_ANALYSIS_FAILED' }), completedAt: new Date().toISOString() })
      try { await this.persist() }
      catch { Object.assign(this.state, { status: 'failed', error: 'AI_SAVE_FAILED' }); await this.persist().catch(() => {}) }
      this.activePromise = null
      this.finishing = false
      this.trace('task:finish', { task: this.state.task, status: this.state.partial ? 'partial' : this.state.status,
        durationMs: Math.max(0, Math.round(this.now() - startedAt)), totalCount: this.state.total, completedCount: this.state.completed,
        failedCount: this.state.failed, requestCount: this.state.requests, cachedCount: this.state.cached,
        firstPassSavedCount: this.state.normalizationFirstPassSaved, retrySavedCount: this.state.normalizationRetrySaved,
        retryPendingCount: this.state.normalizationRetryPending, missingBookCount: this.state.normalizationMissing,
        failedBookCount: this.state.normalizationFailedBooks, submittedBookCount: this.state.normalizationSubmitted,
        errorCode: this.state.error || undefined })
      this.publish({})
    })
    return this.getState()
  }

  async run(request, config, signal) {
    const check = () => { if (signal.aborted) throw aborted() }
    const allBooks = await this.loadBooks()
    check()
    this.publish({ totalBooks: allBooks.length })
    const current = new Map(allBooks.map(book => [book.id, book]))
    const resolvedConfig = resolveAiConfig(config)
    const profile = stableId('ai-transport-v4', config.provider || 'compatible', resolvedConfig.baseUrl,
      resolvedConfig.model, resolvedConfig.responseMode,
      ...(config.provider && config.provider !== 'compatible' ? [resolvedConfig.reasoningEffort] : []), AI_CLASSIFY_VERSION)
    const cache = await AuditCache.open(this.auditPath)
    const semanticSource = {
      provider: resolvedConfig.provider,
      model: resolvedConfig.model,
      reasoningEffort: resolvedConfig.provider === 'compatible' ? undefined : resolvedConfig.reasoningEffort,
      ...(resolvedConfig.provider === 'compatible' ? { requestOptions: buildCompatibleRequestOptions(resolvedConfig) } : {}),
      runId: this.state.runId
    }
    const legacySemanticAliases = new Map()
    const loadLegacySemanticAliases = async () => {
      let filenames = []
      try { filenames = (await fs.promises.readdir(path.join(this.root, 'runs'))).filter(name => name.endsWith('.json')) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      const manifests = await Promise.all(filenames.map(filename => loadJson(path.join(this.root, 'runs', filename), null)))
      for (const manifest of manifests.filter(item => item?.profile && item.books && typeof item.books === 'object')) {
        const promptVersion = Number.isInteger(manifest.promptVersion) ? manifest.promptVersion : AI_PROMPT_VERSION
        const rulesVersion = Number.isInteger(manifest.rulesVersion) ? manifest.rulesVersion : DEDUPE_RULES_VERSION
        if (promptVersion !== AI_PROMPT_VERSION || ![3, DEDUPE_RULES_VERSION].includes(rulesVersion)) continue
        for (const [bookId, snapshotKey] of Object.entries(manifest.books)) {
          if (typeof snapshotKey !== 'string' || !snapshotKey) continue
          const identity = `${bookId}:${snapshotKey}:${promptVersion}:${rulesVersion}`
          const fingerprint = stableId('ai-semantic-v2', manifest.profile, snapshotKey, promptVersion)
          const candidates = legacySemanticAliases.get(identity) || []
          candidates.push({ fingerprint, runId: manifest.runId, createdAt: manifest.createdAt || '' })
          legacySemanticAliases.set(identity, candidates)
        }
      }
      for (const candidates of legacySemanticAliases.values()) candidates.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    }
    await loadLegacySemanticAliases()
    const saveCache = async (key, value) => {
      try { await cache.putAiResult(key, value) }
      catch { throw Object.assign(new Error('AI 结果缓存写入失败。'), { code: 'AI_SAVE_FAILED' }) }
    }
    const validateSemanticCache = (saved, book) => {
      const envelope = saved?.kind === 'book-semantic' && saved.version >= 3 ? saved : { value: saved, source: { provider: 'legacy-unknown', model: 'legacy-unknown' } }
      if (!envelope.value || typeof envelope.value !== 'object') return null
      try {
        const payload = buildRelationRequest({ task: 'normalize', books: [book], pairs: [] })
        const value = validateRelationResult({ books: [envelope.value], relations: [] }, payload, { mode: 'normalize' }).books[0]
        if (value.uncertainties.includes('AI omitted this book; its semantics remain unknown.')) return null
        return { value, source: envelope.source || { provider: 'legacy-unknown', model: 'legacy-unknown' } }
      } catch { return null }
    }
    const getSemanticCache = async book => {
      const snapshotKey = bookSnapshotKey(book)
      const canonicalKey = semanticCacheKey(book)
      const canonical = validateSemanticCache(await cache.getAiResult(canonicalKey), book)
      if (canonical) return { ...canonical, migrated: false }
      const legacySnapshot = legacyBookSnapshotKey(book)
      if (legacySnapshot) {
        const legacyKey = stableId('ai-semantic-v3', legacySnapshot, AI_PROMPT_VERSION, 3)
        const legacy = validateSemanticCache(await cache.getAiResult(legacyKey), book)
        if (legacy) {
          await saveCache(canonicalKey, cacheEnvelope(legacy.value, { source: legacy.source, snapshotKey, migratedFrom: legacyKey }))
          return { ...legacy, migrated: true }
        }
      }
      const identities = [semanticCacheIdentity(book, snapshotKey, AI_PROMPT_VERSION, DEDUPE_RULES_VERSION),
        ...(legacySnapshot ? [semanticCacheIdentity(book, legacySnapshot, AI_PROMPT_VERSION, 3)] : [])]
      for (const alias of identities.flatMap(identity => legacySemanticAliases.get(identity) || [])) {
        const legacy = validateSemanticCache(await cache.getAiResult(alias.fingerprint), book)
        if (!legacy) continue
        const migratedSource = { ...legacy.source, runId: legacy.source?.runId || alias.runId, migratedFrom: alias.fingerprint }
        const envelope = cacheEnvelope(legacy.value, { source: migratedSource, snapshotKey, migratedFrom: alias.fingerprint })
        await saveCache(canonicalKey, envelope)
        return { value: legacy.value, source: migratedSource, migrated: true }
      }
      return null
    }
    const saveSemanticCache = async (book, semantic, model) => {
      const key = semanticCacheKey(book)
      const source = { ...semanticSource, model: model || semanticSource.model }
      await saveCache(key, cacheEnvelope(semantic, { source, snapshotKey: bookSnapshotKey(book) }))
    }
    const cacheKey = payload => stableId('ai-relations-v3', profile, payload)
    const manifest = { runId: this.state.runId, task: request.task, profile, promptVersion: AI_PROMPT_VERSION,
      rulesVersion: DEDUPE_RULES_VERSION, createdAt: new Date().toISOString(), status: 'running',
      books: Object.fromEntries(allBooks.map(book => [book.id, bookSnapshotKey(book)])), normalization: { cached: 0, requested: 0, succeeded: 0 },
      candidateCount: 0, classification: { completed: 0, failed: 0 }, resultIds: [] }
    await this.persistRunManifest(manifest)
    const submittedBooks = new Set()
    let fatalError = null
    const validate = (value, payload) => {
      const counts = { task: payload.task, bookCount: payload.books.length, pairCount: payload.pairs.length, requestCount: this.state.requests }
      try {
        const result = validateRelationResult(value, payload, { mode: payload.task === 'normalize' ? 'normalize' : 'classification' })
        const warningCount = (result.books || []).reduce((count, book) => count + book.uncertainties.length, 0) +
          (result.relations || []).reduce((count, relation) => count + (relation.warnings?.length || 0), 0)
        this.trace('result:validated', { ...counts, status: 'completed', warningCount })
        return result
      } catch (error) {
        const detail = publicErrorDetail(error, payload.books)
        this.trace('result:invalid', { ...counts, status: 'failed', errorCode: publicError(error), failureStage: publicError(error) === 'AI_RESULT_INVALID' ? 'business' : undefined,
          validationReason: detail?.reason, fieldPath: detail?.path })
        throw error
      }
    }
    const call = async (payload, context, { repairEvidence = false } = {}) => {
      check()
      const key = cacheKey(payload)
      const cached = !request.force && await cache.getAiResult(key)
      check()
      if (fatalError) throw fatalError
      if (cached) {
        try {
          const value = validate(cached.value, payload)
          if (payload.task === 'normalize' && value.books.some(book => book.uncertainties.includes('AI omitted this book; its semantics remain unknown.'))) throw new Error('AI_INCOMPLETE_CACHE')
          if (payload.task !== 'normalize' && value.relations.some(relation => relation.reason === 'AI omitted the requested pair; no conclusion is available.')) throw new Error('AI_INCOMPLETE_CACHE')
          this.publish({ cached: this.state.cached + 1 })
          if (payload.task !== 'normalize') this.publish({ classificationCached: this.state.classificationCached + 1 })
          else this.publish({ normalizationCached: this.state.normalizationCached + payload.books.length })
          this.trace('cache:hit', { task: payload.task, bookCount: payload.books.length, pairCount: payload.pairs.length, cachedCount: this.state.cached, status: 'cached' })
          this.traceStore?.batch(context, { status: 'cached', returnedCount: payload.task === 'normalize' ? value.books.length : value.relations.length,
            validatedCount: payload.task === 'normalize' ? value.books.length : value.relations.length, savedCount: payload.task === 'normalize' ? value.books.length : value.relations.length })
          return { ...cached, value, fromCache: true, diagnostics: { missingIds: [] } }
        } catch (error) {
          // A cached response from an older output contract is a miss. Re-run
          // it under the current schema instead of surfacing a stale failure.
          this.trace('cache:miss', { task: payload.task, bookCount: payload.books.length, pairCount: payload.pairs.length })
        }
      }
      this.trace('cache:miss', { task: payload.task, bookCount: payload.books.length, pairCount: payload.pairs.length })
      this.publish({ requests: this.state.requests + 1 })
      if (payload.task === 'normalize') {
        for (const book of payload.books) submittedBooks.add(book.id)
        this.publish({ normalizationSubmitted: submittedBooks.size })
      }
      const schema = payload.task === 'normalize' ? AI_RELATION_SCHEMA : AI_CLASSIFICATION_SCHEMA
      const response = await this.aiService.analyze({ payload, traceContext: context,
        systemPrompt: payload.task === 'normalize'
          ? `${AI_NORMALIZE_SYSTEM_PROMPT}${repairEvidence ? `\n\n${AI_EVIDENCE_REPAIR_PROMPT}` : ''}`
          : AI_CLASSIFY_SYSTEM_PROMPT,
        schema, signal, config })
      check()
      const responseContext = response.traceContext || context
      const returnedIds = new Set((payload.task === 'normalize' ? response.value?.books : response.value?.relations)?.map(item => payload.task === 'normalize' ? item.id : [item.leftId, item.rightId].join(':')) || [])
      const missingIds = payload.task === 'normalize' ? payload.books.filter(book => !returnedIds.has(book.id)).map(book => book.id)
        : payload.pairs.filter(pair => !returnedIds.has([pair.leftId,pair.rightId].join(':'))).map(pair => [pair.leftId,pair.rightId].join(':'))
      this.traceStore?.batch(context, { status: 'validating', returnedCount: payload.task === 'normalize' ? response.value?.books?.length || 0 : response.value?.relations?.length || 0,
        missingCount: missingIds.length, missingIds })
      let value, rejectedBooks = []
      try {
        let remaining = response.value
        // Member validation failures belong to that book. Keep validating
        // the other returned members, then retry only the rejected member.
        while (true) {
          try { value = validate(remaining, payload); break }
          catch (error) {
            const bookId = error.validation?.bookId
            if (payload.task !== 'normalize' || error.code !== 'AI_RESULT_INVALID' ||
                !payload.books.some(book => book.id === bookId) || !Array.isArray(remaining?.books) ||
                !remaining.books.some(book => book.id === bookId)) throw error
            rejectedBooks.push({ bookId, errorCode: publicError(error), errorDetail: publicErrorDetail(error, payload.books) })
            remaining = { ...remaining, books: remaining.books.filter(book => book.id !== bookId) }
          }
        }
        await this.traceStore?.validation(responseContext, { status: rejectedBooks.length ? 'partial' : 'validated', missingIds, rejectedBooks, value })
      } catch (error) {
        await this.traceStore?.validation(responseContext, { status: 'failed', errorCode: publicError(error), errorDetail: publicErrorDetail(error, payload.books) })
        throw error
      }
      this.traceStore?.batch(context, { status: 'saving', validatedCount: returnedIds.size - rejectedBooks.length })
      const output = { value, usage: response.usage, model: response.model }
      if (!missingIds.length && !rejectedBooks.length) await saveCache(key, output)
      return { ...output, fromCache: false, diagnostics: { missingIds, rejectedBooks } }
    }
    let runFailure = null
    try {
      let unitCount = 0, unitIterator
      if (request.task === 'dedupe') {
        const report = await this.getDedupeReport()
        if (!report || report.reportId !== request.reportId || report.stale || report.outdatedRules || report.legacy) throw new Error('AI_REPORT_STALE')
        const requestedIds = new Set(request.groupIds || [])
        if ([...requestedIds].some(id => !report.groups.some(group => group.id === id))) throw new Error('AI_GROUP_MISSING')
        const groups = report.groups.filter(group => !requestedIds.size || requestedIds.has(group.id))
        for (const group of groups) {
          check()
          if (group.items.some(book => !current.has(book.id) || book.metadataFingerprint !== current.get(book.id).metadataFingerprint) || !await this.filesMatch(group.items)) throw new Error('AI_REPORT_STALE')
          unitCount += group.items.length * (group.items.length - 1) / 2
        }
        unitIterator = (function * () {
          for (const group of groups) for (let a = 0; a < group.items.length; a++) for (let b = a + 1; b < group.items.length; b++) {
            yield { books: [group.items[a], group.items[b]], pairs: [{ leftId: group.items[a].id, rightId: group.items[b].id }],
              reportId: report.reportId, groupId: group.id, evidenceRevision: group.evidenceRevision }
          }
        })()
      } else {
        this.publish({ phase: 'normalizing', total: allBooks.length, completed: 0 })
        const pending = []
        for (const book of allBooks) {
          const saved = !request.force && await getSemanticCache(book)
          if (saved) {
            book.aiSemantic = saved.value
            book.aiSemanticSource = saved.source
            if (saved.migrated) this.publish({ normalizationMigrated: this.state.normalizationMigrated + 1 })
          } else pending.push({ book, key: semanticCacheKey(book) })
        }
        manifest.normalization.cached = allBooks.length - pending.length
        manifest.normalization.requested = pending.length
        this.publish({ completed: allBooks.length - pending.length, cached: allBooks.length - pending.length,
          normalizationCached: allBooks.length - pending.length, normalizationRequested: pending.length,
          normalizationSucceeded: allBooks.length - pending.length })
        if (this.state.cached) this.trace('cache:hit', { task: 'normalize', cachedCount: this.state.cached, bookCount: this.state.cached, status: 'cached' })
        const batchSize = config.normalizationBatchSize
        const batchTotal = Math.ceil(pending.length / batchSize)
        const contexts = Array.from({ length: batchTotal }, (_, index) => ({ runId: this.state.runId, phase: 'normalizing', batchId: `normalize-${index + 1}`,
          batchIndex: index + 1, batchTotal, managed: true, bookCount: pending.slice(index * batchSize, (index + 1) * batchSize).length, pairCount: 0,
          members: pending.slice(index * batchSize, (index + 1) * batchSize).map(({ book }) => ({ id: book.id, title: book.title })) }))
        for (const context of contexts) this.traceStore?.batch(context, { status: 'queued' })
        let offset = 0
        const recoveryContext = (parent, batch, depth, part) => ({
          ...parent,
          batchId: `${parent.batchId}-r${depth}-${part}`,
          bookCount: batch.length,
          members: batch.map(({ book }) => ({ id: book.id, title: book.title })),
          recoveryOf: parent.batchId,
          recoveryDepth: depth
        })
        const recoverableNormalizationError = error => error.code === 'AI_INVALID_JSON' ||
          (error.code === 'AI_RESULT_INVALID' && error.validation?.reason === 'EVIDENCE_MISMATCH')
        const finishRecovery = (context, savedCount, recoverySavedCount, total) => {
          const effectiveSavedCount = savedCount + recoverySavedCount
          this.traceStore?.batch(context, { status: effectiveSavedCount === total ? 'recovered' : 'partial',
            effectiveSavedCount, recoverySavedCount, unresolvedCount: total - effectiveSavedCount,
            completedAt: new Date().toISOString() })
          return effectiveSavedCount
        }
        const processBatch = async (batch, context, recoveryDepth = 0, repairEvidence = false) => {
          check()
          let savedCount = 0
          let retryItems = []
          this.publish({ currentTitle: batch[0].book.title })
          try {
            const response = await call(buildRelationRequest({ task: 'normalize', books: batch.map(item => item.book), pairs: [] }), context, { repairEvidence })
            const rejected = response.diagnostics.rejectedBooks || []
            const unresolvedIds = new Set([...response.diagnostics.missingIds, ...rejected.map(item => item.bookId)])
            for (const item of batch) {
              const semantic = response.value.books.find(book => book.id === item.book.id)
              if (semantic && !unresolvedIds.has(item.book.id)) {
                item.book.aiSemantic = semantic
                item.book.aiSemanticSource = { ...semanticSource, model: response.model || semanticSource.model }
                await saveSemanticCache(item.book, semantic, response.model)
                savedCount++
                this.state.normalizationSucceeded++
                this.state.normalizationSaved++
                if (recoveryDepth) {
                  this.state.normalizationRetrySaved++
                  this.state.normalizationRetryPending--
                } else this.state.normalizationFirstPassSaved++
                manifest.normalization.succeeded++
              }
            }
            if (!repairEvidence) {
              retryItems = batch.filter(item => unresolvedIds.has(item.book.id))
              if (!recoveryDepth) this.state.normalizationRetryPending += retryItems.length
            }
            else {
              this.state.normalizationRetryPending -= unresolvedIds.size
              this.publish({ normalizationMissing: this.state.normalizationMissing + response.diagnostics.missingIds.length,
                failed: this.state.failed + rejected.length, normalizationFailed: this.state.normalizationFailed + rejected.length,
                normalizationFailedBooks: this.state.normalizationFailedBooks + rejected.length,
                ...(rejected.length ? { error: rejected[0].errorCode, errorDetail: rejected[0].errorDetail } : {}) })
            }
            this.traceStore?.batch(context, { status: unresolvedIds.size ? 'partial' : 'completed', savedCount,
              failedCount: rejected.length, missingCount: response.diagnostics.missingIds.length,
              ...(rejected.length ? { errorCode: rejected[0].errorCode, errorDetail: rejected[0].errorDetail } : {}),
              ...(retryItems.length ? { recovery: 'members', recoveryReason: rejected.length ? rejected[0].errorDetail?.reason || 'AI_RESULT_INVALID' : 'AI_OMITTED_BOOK', recoveryParts: retryItems.length } : {}),
              completedAt: new Date().toISOString() })
          } catch (error) {
            const lengthLimit = error.code === 'AI_RESPONSE_TRUNCATED' && error.truncationReason === 'length'
            if (lengthLimit ? batch.length > 1 : recoverableNormalizationError(error) && ((batch.length > 1 && recoveryDepth < 2) || !repairEvidence)) {
              const middle = Math.ceil(batch.length / 2)
              const parts = [batch.slice(0, middle), batch.slice(middle)].filter(part => part.length)
              if (!recoveryDepth) this.publish({ normalizationRetryPending: this.state.normalizationRetryPending + batch.length })
              this.traceStore?.batch(context, { status: 'partial', recoveryOf: context.recoveryOf, recoveryDepth,
                recovery: 'split', recoveryReason: error.validation?.reason || publicError(error), recoveryParts: parts.length,
                recoverySizes: parts.map(part => part.length), truncationReason: error.truncationReason, finishReason: error.finishReason,
                errorCode: publicError(error), errorDetail: publicErrorDetail(error, batch.map(item => item.book)), completedAt: new Date().toISOString() })
              // Each worker finishes its recovery requests in sequence so
              // splitting never exceeds the configured request concurrency.
              let recoverySavedCount = 0
              for (const [index, part] of parts.entries()) recoverySavedCount += await processBatch(part,
                recoveryContext(context, part, recoveryDepth + 1, index + 1), recoveryDepth + 1, !lengthLimit)
              return finishRecovery(context, 0, recoverySavedCount, batch.length)
            }
            const errorCode = lengthLimit && batch.length === 1 ? 'AI_SINGLE_BOOK_TRUNCATED' : publicError(error)
            this.traceStore?.batch(context, { status: signal.aborted ? 'cancelled' : 'failed', savedCount,
              failedCount: signal.aborted ? 0 : batch.length - savedCount, cancelledCount: signal.aborted ? batch.length - savedCount : 0,
              errorCode, truncationReason: error.truncationReason, finishReason: error.finishReason,
              errorDetail: publicErrorDetail(error, batch.map(item => item.book)), completedAt: new Date().toISOString() })
            if (signal.aborted) throw aborted()
            if (recoveryDepth) this.state.normalizationRetryPending -= batch.length - savedCount
            this.publish({ failed: this.state.failed + 1, normalizationFailed: this.state.normalizationFailed + 1,
              normalizationFailedBooks: this.state.normalizationFailedBooks + batch.length - savedCount,
              error: errorCode, errorDetail: publicErrorDetail(error, batch.map(item => item.book)) })
            if (stopsBatch(error)) { fatalError = error; throw error }
          }
          this.publish({ completed: Math.min(allBooks.length, this.state.completed + batch.length - retryItems.length) })
          await this.persist()
          await this.persistRunManifest({ ...manifest, normalization: { ...manifest.normalization } })
          let recoverySavedCount = 0
          for (const [index, item] of retryItems.entries()) recoverySavedCount += await processBatch([item],
            recoveryContext(context, [item], recoveryDepth + 1, index + 1), recoveryDepth + 1, true)
          return retryItems.length ? finishRecovery(context, savedCount, recoverySavedCount, batch.length) : savedCount
        }
        const normalizationOutcomes = await Promise.allSettled(Array.from({ length: Math.min(config.concurrency, Math.ceil(pending.length / batchSize)) }, async () => {
          while (offset < pending.length) {
            check()
            if (fatalError) throw fatalError
            const batch = pending.slice(offset, offset + batchSize)
            const context = contexts[Math.floor(offset / batchSize)]
            offset += batchSize
            await processBatch(batch, context)
          }
        }))
        const normalizationFailure = normalizationOutcomes.find(outcome => outcome.status === 'rejected' && outcome.reason.code !== 'AI_CANCELLED') || normalizationOutcomes.find(outcome => outcome.status === 'rejected')
        if (normalizationFailure) throw normalizationFailure.reason
        check()
        // Full-library discovery requires a semantic result for every book.
        // Successful members are already cached for the next run.
        if (this.state.normalizationSucceeded < allBooks.length) {
          this.publish({ partial: true, error: this.state.error || 'AI_ANALYSIS_INCOMPLETE' })
          return
        }
        this.publish({ phase: 'candidates' })
        this.trace('candidates:start', { task: request.task, bookCount: allBooks.length, status: 'running' })
        const candidateOptions = { task: request.task === 'series' ? 'series' : 'dedupe' }
        for (const chunk of iterateSemanticCandidateChunks(allBooks, candidateOptions)) {
          check()
          unitCount += chunk.length
          await new Promise(resolve => setImmediate(resolve))
        }
        check()
        manifest.candidateCount = unitCount
        this.trace('candidates:finish', { task: request.task, bookCount: allBooks.length, candidateCount: unitCount, status: 'completed' })
        this.publish({ candidateCount: unitCount })
        unitIterator = (async function * () {
          for (const chunk of iterateSemanticCandidateChunks(allBooks, candidateOptions)) {
            check()
            for (const pair of chunk) yield { books: [current.get(pair.leftId), current.get(pair.rightId)], pairs: [pair],
              reportId: null, groupId: null, evidenceRevision: null }
            await new Promise(resolve => setImmediate(resolve))
          }
        })()
        if (request.task === 'series') {
          const relations = collectPublicationRelations(allBooks)
          const ids = new Set(relations.flatMap(relation => [relation.leftId, relation.rightId]))
          const books = allBooks.filter(book => ids.has(book.id))
          this.results.set('publication-periods', { id: 'publication-periods', runId: this.state.runId, task: 'series', reportId: null,
            createdAt: new Date().toISOString(), books, relations, snapshotKeys: Object.fromEntries(books.map(book => [book.id, bookSnapshotKey(book)])),
            status: 'completed', promptVersion: AI_PROMPT_VERSION, rulesVersion: DEDUPE_RULES_VERSION, source: 'publication-metadata' })
        }
      }
      this.publish({ phase: 'classifying', completed: 0, total: unitCount, candidateCount: unitCount })
      let cursor = 0
      const processUnit = async (unit, context) => {
        check()
        const id = stableId(request.task, unit.reportId, unit.groupId, unit.pairs.map(pair => [pair.leftId, pair.rightId]))
        const snapshots = Object.fromEntries(unit.books.map(book => [book.id, bookSnapshotKey(current.get(book.id))]))
        const result = { id, runId: this.state.runId, task: request.task, reportId: unit.reportId, groupId: unit.groupId, evidenceRevision: unit.evidenceRevision,
          createdAt: new Date().toISOString(), books: unit.books, snapshotKeys: snapshots, relations: [], status: 'completed', stale: false,
          promptVersion: AI_PROMPT_VERSION, rulesVersion: DEDUPE_RULES_VERSION }
        this.publish({ currentTitle: unit.books.map(book => book.title).join(' ↔ ') })
        try {
          const payload = buildRelationRequest({ task: request.task === 'series' ? 'series' : 'dedupe', books: unit.books, pairs: unit.pairs })
          const response = await call(payload, context)
          Object.assign(result, { relations: response.value.relations, missingCount: response.diagnostics.missingIds.length,
            analysisBooks: response.value.books?.length ? response.value.books : unit.books.map(book => book.aiSemantic || book), fromCache: response.fromCache,
            model: response.model, usage: response.usage, promptVersion: AI_PROMPT_VERSION, inputFingerprint: cacheKey(payload) })
          const relationCounts = { ...this.state.relationCounts }
          for (const relation of response.value.relations || []) {
            if (response.diagnostics.missingIds.includes([relation.leftId,relation.rightId].join(':'))) continue
            if (Object.prototype.hasOwnProperty.call(relationCounts, relation.relation)) relationCounts[relation.relation]++
          }
          result.books = unit.books.map(book => ({ ...book, aiSemantic: response.value.books?.find(item => item.id === book.id) || book.aiSemantic }))
          result.conflicts = response.value.relations.filter(relation => {
            const [left, right] = unit.books
            const proven = (left.archiveSha256 && left.archiveSha256 === right.archiveSha256) || (left.contentProof && left.contentProof === right.contentProof)
            return proven && ['unrelated', 'same_series_different_part', 'same_publication_different_issue',
              'same_work_left_contains_right', 'same_work_right_contains_left', 'same_work_partial_overlap'].includes(relation.relation)
          }).map(({ leftId, rightId }) => ({ leftId, rightId, code: 'local-content-conflict' }))
          this.publish({ classificationSucceeded: this.state.classificationSucceeded + (result.missingCount ? 0 : 1),
            classificationMissing: this.state.classificationMissing + result.missingCount, relationCounts })
          if (!result.missingCount) manifest.classification.completed++
          if (request.task === 'series') result.series = buildSeriesReport({ books: result.books, relations: result.relations })
        } catch (error) {
          if (signal.aborted) throw aborted()
          result.status = 'failed'; result.error = publicError(error); result.errorDetail = publicErrorDetail(error, unit.books)
          this.traceStore?.batch(context, { status: 'failed', failedCount: unit.pairs.length, errorCode: publicError(error), errorDetail: result.errorDetail })
          manifest.classification.failed++
          this.publish({ failed: this.state.failed + 1, classificationFailed: this.state.classificationFailed + 1, error: result.error, errorDetail: result.errorDetail })
          if (stopsBatch(error)) {
            this.results.set(id, result)
            fatalError = error
            throw error
          }
        }
        check()
        this.results.set(id, result)
        manifest.resultIds.push(id)
        this.publish({ completed: this.state.completed + 1 })
        await this.persist()
        this.traceStore?.batch(context, { status: result.status === 'failed' ? 'failed' : result.missingCount ? 'partial' : result.fromCache ? 'cached' : 'completed',
          savedCount: result.status === 'failed' || result.missingCount ? 0 : unit.pairs.length, completedAt: new Date().toISOString() })
        await this.persistRunManifest({ ...manifest, resultIds: [...manifest.resultIds], classification: { ...manifest.classification } })
      }
      const outcomes = await Promise.allSettled(Array.from({ length: Math.min(config.concurrency, unitCount) }, async () => {
        while (cursor < unitCount) {
          check()
          if (fatalError) throw fatalError
          const { value: unit, done } = await unitIterator.next()
          if (done) break
          check()
          const index = cursor++
          const context = { runId: this.state.runId, phase: 'classifying', batchId: `classify-${index + 1}`, managed: true,
            batchIndex: index + 1, batchTotal: unitCount, bookCount: unit.books.length, pairCount: unit.pairs.length,
            members: unit.books.map(book => ({ id: book.id, title: book.title })) }
          this.traceStore?.batch(context, { status: 'queued' })
          await processUnit(unit, context)
        }
      }))
      const failure = outcomes.find(outcome => outcome.status === 'rejected' && outcome.reason.code !== 'AI_CANCELLED') || outcomes.find(outcome => outcome.status === 'rejected')
      if (failure) throw failure.reason
      check()
    } catch (error) {
      runFailure = error
      throw error
    } finally {
      manifest.status = signal.aborted ? 'cancelled' : runFailure ? 'failed' :
        this.state.partial || this.state.failed || this.state.normalizationMissing || this.state.classificationMissing ? 'partial' : 'completed'
      manifest.completedAt = new Date().toISOString()
      await this.persistRunManifest(manifest).catch(() => {})
      await cache.close()
    }
  }

  cancel() {
    if (this.controller) {
      this.trace('task:progress', { task: this.state.task, phase: this.state.phase, status: 'cancelled', completedCount: this.state.completed, requestCount: this.state.requests })
      this.publish({ status: 'cancelling' }); this.controller.abort()
    }
    return this.getState()
  }

  async interruptForExit() { this.cancel(); await this.activePromise }

  async getCandidatePairs(resultIds) {
    this.trace('candidates:start', { task: 'verify-candidates', candidateCount: Array.isArray(resultIds) ? resultIds.length : 0, status: 'running' })
    try {
      // A terminal state is published just before the final persistence and
      // promise cleanup. Wait for that short finishing window instead of
      // exposing a spurious AI_ALREADY_RUNNING error to the renderer.
      if (this.finishing) await this.waitForIdle()
      if (this.running) throw new Error('AI_ALREADY_RUNNING')
      const requested = new Set(resultIds || [])
      if (!requested.size) throw new Error('AI_CANDIDATES_MISSING')
      const results = (await this.getResults({ task: 'discovery' })).filter(result => requested.has(result.id))
      if (results.length !== requested.size || results.some(result => result.stale || result.status !== 'completed')) throw new Error('AI_RESULT_STALE')
      const pairs = results.flatMap(result => result.relations.filter(relation => ['same_work_same_part', 'same_work_different_edition'].includes(relation.relation)))
        .map(({ leftId, rightId }) => ({ leftId, rightId }))
      if (!pairs.length) throw new Error('AI_CANDIDATES_MISSING')
      this.trace('candidates:finish', { task: 'verify-candidates', pairCount: pairs.length, status: 'completed' })
      return pairs
    } catch (error) {
      this.trace('candidates:finish', { task: 'verify-candidates', status: 'failed', errorCode: publicError(error) })
      throw error
    }
  }

  async getValidCandidatePairs({ runId } = {}) {
    const seen = new Set()
    return (await this.getResults({ task: 'discovery' })).filter(result => !result.stale && result.status === 'completed' && (!runId || result.runId === runId))
      .flatMap(result => result.relations.filter(relation => ['same_work_same_part', 'same_work_different_edition'].includes(relation.relation)))
      .map(({ leftId, rightId }) => ({ leftId, rightId }))
      .filter(pair => {
        const key = JSON.stringify([pair.leftId, pair.rightId].sort())
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
  }

  async getValidCoveragePairs({ runId } = {}) {
    const seen = new Set()
    return (await this.getResults({ task: 'discovery' })).filter(result => !result.stale && result.status === 'completed' && (!runId || result.runId === runId))
      .flatMap(result => result.relations.filter(relation => ['same_work_left_contains_right', 'same_work_right_contains_left', 'same_work_partial_overlap'].includes(relation.relation)))
      .map(({ leftId, rightId, relation }) => ({ leftId, rightId, relation }))
      .filter(pair => {
        const key = JSON.stringify([pair.leftId, pair.rightId].sort())
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
  }

  async clear() {
    if (this.running) throw new Error('AI_ALREADY_RUNNING')
    await this.writeQueue
    this.results.clear()
    this.state = idleState()
    await this.persist()
    this.publish({})
  }
}

module.exports = { AiReviewService }

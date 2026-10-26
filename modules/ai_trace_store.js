const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { once } = require('node:events')
const { randomUUID } = require('node:crypto')
const { beijingLogTimestamp } = require('./log_time.js')
const { MAX_STREAM_BYTES } = require('./ai_response_limits.js')
const { atomicWriteJson } = require('./audit/utils.js')
const { attemptThroughput } = require('./ai_tps.js')

const copy = value => JSON.parse(JSON.stringify(value))
const token = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,150}$/.test(value)
const terminal = new Set(['completed', 'recovered', 'partial', 'failed', 'cancelled', 'cached', 'limited', 'interrupted', 'not_requested'])
const kinds = new Set(['messages', 'sse', 'content', 'reasoning', 'parsed', 'validation'])
const endpoint = value => { try { const url = new URL(value); return url.origin + url.pathname } catch { return '' } }
const phaseLabels = { preparing:'准备资料',normalizing:'单本语义解析',candidates:'生成候选',classifying:'AI 关系判断',verifying:'本地内容核验',completed:'AI 分析结束',queue_ready:'审核队列已生成',connection:'测试连接',models:'获取模型' }
const statusLabels = { queued:'等待',requesting:'请求中',receiving:'接收中',retrying:'等待重试',parsing:'JSON 解析',validating:'业务校验',saving:'写入缓存',completed:'完成',recovered:'已恢复',partial:'部分完成',failed:'失败',cancelled:'已取消',cached:'缓存命中',limited:'历史任务因旧请求上限停止',not_requested:'尚未请求',interrupted:'已中断',running:'运行中',cancelling:'正在取消' }

class AiTraceStore extends EventEmitter {
  constructor({ storePath, write = line => console.log(line), now = Date.now } = {}) {
    super()
    this.root = path.join(storePath, 'audit', 'ai', 'trace')
    this.write = write
    this.now = now
    this.seq = 0
    this.runs = new Map()
    this.batches = new Map()
    this.events = []
    this.streams = new Map()
    this.eventStreams = new Map()
    this.consoleTimes = new Map()
    this.queue = Promise.resolve()
    this.ready = fs.promises.mkdir(this.root, { recursive: true }).then(async () => {
      try {
        const saved = JSON.parse(await fs.promises.readFile(path.join(this.root, 'runs.json'), 'utf8'))
        for (const run of saved) this.runs.set(run.runId, terminal.has(run.status) ? run : { ...run, status: 'interrupted' })
      } catch (error) { if (error.code !== 'ENOENT') this.storageError = error.code || 'AI_TRACE_READ_FAILED' }
    })
  }

  enqueue(operation) {
    const next = this.queue.then(() => this.ready).then(operation)
    this.queue = next.catch(error => this.failStorage(error))
    return this.queue
  }

  failStorage(error) {
    const code = error.code || 'AI_TRACE_WRITE_FAILED'
    if (this.storageError === code) return
    this.storageError = code
    this.emit('storage-error', code)
  }

  async diagnosticIo(operation) {
    try { return await operation() } catch (error) { this.failStorage(error) }
  }

  async loadRun(runId) {
    await this.ready
    if (!token(runId)) throw new Error('AI_TRACE_INVALID_ID')
    if ([...this.batches.values()].some(batch => batch.runId === runId) || this.loadedRun === runId) return
    await this.queue
    try {
      const lines = (await fs.promises.readFile(path.join(this.root, runId, 'events.jsonl'), 'utf8')).split('\n')
      for (const line of lines) {
        if (!line) continue
        let event
        try { event = JSON.parse(line) } catch { continue } // A process exit may leave one incomplete final line.
        this.seq = Math.max(this.seq, event.seq || 0)
        if (event.batch) {
          for (const attempt of event.batch.attempts || []) Object.assign(attempt, attemptThroughput(attempt))
          this.batches.set(`${runId}/${event.batch.batchId}`, terminal.has(event.batch.status) ? event.batch : { ...event.batch, status: 'interrupted' })
        }
        this.events.push(event)
      }
      this.events = this.events.slice(-500)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    this.loadedRun = runId
  }

  run(runId, patch = {}) {
    if (!token(runId)) throw new Error('AI_TRACE_INVALID_ID')
    const previous = this.runs.get(runId)
    const run = { ...(previous || { runId, startedAt: beijingLogTimestamp(this.now()) }), ...patch }
    this.runs.set(runId, run)
    if (previous && previous.phase === run.phase && previous.status === run.status && !terminal.has(run.status) && this.now() - (previous.recordedAt || 0) < 1000) return run
    run.recordedAt = this.now()
    if (terminal.has(run.status)) for (const batch of [...this.batches.values()]) {
      if (batch.runId !== runId || terminal.has(batch.status)) continue
      this.batch(batch, { status: batch.status === 'queued' ? 'not_requested' : 'interrupted', completedAt: beijingLogTimestamp(this.now()) })
    }
    this.record('run', { runId, run })
    this.enqueue(() => atomicWriteJson(path.join(this.root, 'runs.json'), [...this.runs.values()]))
    return run
  }

  async validation(context, value) {
    const batch = this.batches.get(`${context.runId}/${context.batchId}`)
    const attempt = batch?.attempts?.at(-1)
    if (!attempt || !context.requestId) return
    const folder = path.join(this.root, context.runId, context.batchId, `${context.requestId}-${attempt.attempt}`)
    await this.diagnosticIo(() => fs.promises.writeFile(path.join(folder, 'validation.txt'), JSON.stringify(value, null, 2)))
  }

  batch(context, patch = {}, event = 'batch') {
    if (!token(context.runId) || !token(context.batchId)) throw new Error('AI_TRACE_INVALID_ID')
    const key = `${context.runId}/${context.batchId}`
    const batch = { ...this.batches.get(key), ...context, ...patch, updatedAt: beijingLogTimestamp(this.now()) }
    this.batches.set(key, batch)
    this.record(event, { runId: batch.runId, batch: copy(batch) })
    return batch
  }

  record(event, detail) {
    const entry = { seq: ++this.seq, at: beijingLogTimestamp(this.now()), event, ...detail }
    this.events.push(entry)
    this.events = this.events.slice(-500)
    this.enqueue(async () => {
      const folder = path.join(this.root, entry.runId)
      let stream = this.eventStreams.get(entry.runId)
      if (!stream) {
        await fs.promises.mkdir(folder, { recursive: true })
        stream = fs.createWriteStream(path.join(folder, 'events.jsonl'), { flags:'a' })
        stream.on('error', error => this.failStorage(error))
        this.eventStreams.set(entry.runId, stream)
      }
      if (stream.destroyed) return
      if (!stream.write(JSON.stringify(entry) + '\n')) await once(stream, 'drain')
    })
    this.emit('event', entry)
    const batch = entry.batch
    if (batch && batch.status !== 'queued') {
      const attempt = batch.attempts?.at(-1)
      const label = `[${entry.at.replace('T', ' ').slice(0, 19)}][AI][${phaseLabels[batch.phase] || batch.phase}][批次 ${batch.batchIndex || '-'} / ${batch.batchTotal || '-'}]`
      const consoleKey = `${batch.runId}/${batch.batchId}`
      if (event !== 'receiving' || this.now() - (this.consoleTimes.get(consoleKey) || 0) >= 5000) {
        this.consoleTimes.set(consoleKey, this.now())
        const unit = batch.phase === 'normalizing' ? '本' : '对'
        const tps = Number.isFinite(attempt?.outputTps) ? `${attempt.outputTps.toFixed(2)} tokens/s` : attempt && !attempt.completedAt ? '待统计' : '未知'
        const detailText = attempt ? `尝试${attempt.attempt} 流${attempt.streamBytes || 0}B 正文${attempt.contentBytes || 0}B 输出tokens${attempt.usage?.completion_tokens ?? '未知'} 思考tokens${attempt.usage?.completion_tokens_details?.reasoning_tokens ?? '未知'} 平均TPS${tps}(含思考及首包等待)${attempt.finishReason ? ` finish_reason=${attempt.finishReason}` : ''}` : ''
        const limit = attempt?.limitKind ? ` 客户端${attempt.limitKind === 'content' ? '正文' : '传输'}超限 ${attempt.receivedBytes}B / ${attempt.limitBytes}B` : ''
        const recovery = (batch.recoverySavedCount !== undefined ? ` 补试保存${batch.recoverySavedCount} 仍未解决${batch.unresolvedCount}` : '') +
          (batch.recoverySizes?.length ? ` 拆为${batch.recoverySizes.join(' + ')} 原因${batch.truncationReason || batch.recoveryReason}` : '')
        const failures = batch.unresolvedCount !== undefined ? '' : ` 失败${batch.failedCount || 0} 遗漏${batch.missingCount || 0}`
        const controls = (batch.thinkingMode ? ` 请求思考${batch.reasoningProtocol}/${batch.thinkingMode}${batch.reasoningEffort ? '/' + batch.reasoningEffort : ''} 输出上限${batch.maxOutputTokens ?? '跟随上游'}` : '') +
          (attempt?.thinkingControlMismatch ? ' 请求关闭思考但上游仍返回思考' : '')
        try { this.write(`${label} ${statusLabels[batch.status] || batch.status} 提交${batch.phase === 'normalizing' ? batch.bookCount : batch.pairCount}${unit} 返回${batch.returnedCount ?? '待解析'} 校验${batch.validatedCount ?? '待校验'} 保存${batch.savedCount || 0}${recovery}${failures} ${detailText}${controls}${batch.errorCode ? ` ${batch.status === 'recovered' ? '首次错误 ' : ''}${batch.errorCode}` : ''}${limit}`) } catch (error) { this.failStorage(error) }
      }
    } else if (event === 'run') {
      const run = detail.run
      try { this.write(`[${entry.at.replace('T', ' ').slice(0, 19)}][AI][任务] ${statusLabels[run.partial && run.status === 'completed' ? 'partial' : run.status] || run.status} ${phaseLabels[run.phase] || run.phase || ''} 总本数${run.totalBooks ?? '-'} 缓存${run.cachedBooks || 0} 保存${run.savedBooks || 0} 首次保存${run.normalizationFirstPassSaved || 0} 补试保存${run.normalizationRetrySaved || 0} 待补试${run.normalizationRetryPending || 0} 失败本数${run.failedBooks || 0} 遗漏${run.missingBooks || 0} 尚未请求${Math.max(0,(run.totalBooks || 0)-(run.cachedBooks || 0)-(run.normalizationSubmitted || 0))} | 已判定${run.classificationSucceeded || 0}/${run.candidateCount || 0}对 失败配对${run.classificationFailed || 0}${run.queueGroups !== undefined ? ` 审核组${run.queueGroups}` : ''}`) } catch (error) { this.failStorage(error) }
    }
    return entry
  }

  createRequest(context = {}, requestId) {
    const runId = context.runId || `request-${randomUUID()}`
    if (!this.runs.has(runId)) this.run(runId, { status: 'running', task: context.task, phase: context.phase, model: context.model })
    const ctx = { batchIndex: 1, batchTotal: 1, ...context, runId, batchId: context.batchId || `request-${requestId}`, requestId }
    let batch = this.batch(ctx, { status: 'requesting', startedAt: beijingLogTimestamp(this.now()), attempts: [], savedCount: 0 })
    let attempt, folder, lastProgress = 0
    const update = (patch, event = 'batch') => { batch = this.batch(ctx, patch, event) }
    const artifact = async (kind, data, replace = false) => this.diagnosticIo(async () => {
      if (!folder) return
      await this.ready
      const filename = path.join(folder, `${kind}.txt`)
      if (replace) {
        await closeStream(filename)
        await fs.promises.writeFile(filename, data)
        return
      }
      let stream = this.streams.get(filename)
      if (!stream) {
        stream = fs.createWriteStream(filename, { flags: 'a' })
        stream.on('error', error => this.failStorage(error))
        this.streams.set(filename, stream)
      }
      if (!stream.destroyed && !stream.write(data)) await once(stream, 'drain')
    })
    const closeStream = async filename => {
      const stream = this.streams.get(filename)
      if (!stream) return
      this.streams.delete(filename)
      if (stream.destroyed) return
      await new Promise(resolve => stream.end(resolve))
    }
    const flushAttempt = async () => {
      if (folder) await Promise.all([...this.streams.keys()].filter(filename => filename.startsWith(folder + path.sep)).map(closeStream))
    }
    return {
      context: ctx,
      stats: () => attempt ? { streamBytes: attempt.streamBytes, contentBytes: attempt.contentBytes, reasoningBytes: attempt.reasoningBytes, attempt: attempt.attempt,
        inputTokens: attempt.usage?.prompt_tokens, outputTokens: attempt.usage?.completion_tokens, totalTokens: attempt.usage?.total_tokens,
        reasoningTokens: attempt.usage?.completion_tokens_details?.reasoning_tokens, thinkingControlMismatch: attempt.thinkingControlMismatch,
        outputTps: attempt.outputTps, tpsDurationMs: attempt.tpsDurationMs } : {},
      received: () => { if (attempt) { attempt.bodyComplete = true; attempt.responseCompletedAt ||= beijingLogTimestamp(this.now()) } },
      usage: (usage, model) => {
        if (!attempt) return
        const value = Object.fromEntries(['prompt_tokens','completion_tokens','total_tokens'].filter(key => Number.isSafeInteger(usage?.[key]) && usage[key] >= 0).map(key => [key, usage[key]]))
        const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens
        if (Number.isSafeInteger(reasoningTokens) && reasoningTokens >= 0) value.completion_tokens_details = { reasoning_tokens: reasoningTokens }
        if (Object.keys(value).length) attempt.usage = value
        if (model) attempt.model = model
      },
      startAttempt: async (number, { url, method, body }) => {
        await flushAttempt()
        attempt = { attempt: number, startedAt: beijingLogTimestamp(this.now()), status: 'requesting', streamBytes: 0, contentBytes: 0, reasoningBytes: 0, endpoint: endpoint(url), method }
        folder = path.join(this.root, runId, ctx.batchId, `${requestId}-${number}`)
        await this.diagnosticIo(() => fs.promises.mkdir(folder, { recursive: true }))
        await artifact('messages', JSON.stringify(body ? JSON.parse(body) : { method }, null, 2), true)
        update({ status: 'requesting', attempts: [...batch.attempts, attempt] })
      },
      headers: response => {
        if (!attempt) return
        Object.assign(attempt, { httpStatus: response.status, responseType: response.headers.get('content-type'), responseId: response.headers.get('x-request-id'), status: 'receiving' })
        update({ status: 'receiving', attempts: batch.attempts })
      },
      raw: async buffer => {
        if (!attempt) return
        const previous = attempt.streamBytes
        attempt.streamBytes += buffer.length
        attempt.firstByteAt ||= beijingLogTimestamp(this.now())
        attempt.lastByteAt = beijingLogTimestamp(this.now())
        await artifact('sse', buffer.subarray(0, Math.max(0, MAX_STREAM_BYTES - previous)))
        if (this.now() - lastProgress >= 500) { lastProgress = this.now(); update({ status: 'receiving', attempts: batch.attempts }, 'receiving') }
      },
      text: async (kind, text, replace = false) => {
        if (!attempt || !text) return
        const field = kind === 'reasoning' ? 'reasoningBytes' : 'contentBytes'
        attempt[field] = (replace ? 0 : attempt[field]) + Buffer.byteLength(text)
        if (kind === 'content') attempt.firstContentAt ||= beijingLogTimestamp(this.now())
        await artifact(kind, text, replace)
      },
      parsed: async value => {
        update({ status: 'parsing', attempts: batch.attempts })
        await artifact('parsed', JSON.stringify(value, null, 2), true)
      },
      finish: async (result, error) => {
        await flushAttempt()
        if (attempt && ctx.thinkingMode === 'disabled') attempt.thinkingControlMismatch = attempt.reasoningBytes > 0 || (attempt.usage?.completion_tokens_details?.reasoning_tokens || 0) > 0
        if (attempt) Object.assign(attempt, { status: error ? (error.code === 'AI_CANCELLED' ? 'cancelled' : 'failed') : 'completed',
          completedAt: beijingLogTimestamp(this.now()), complete: !error || attempt.bodyComplete === true, usage: result?.usage || attempt.usage || null,
          model: result?.model || attempt.model, errorCode: error?.code, limitKind: error?.limitKind, limitBytes: error?.limitBytes, receivedBytes: error?.receivedBytes,
          finishReason: result?.finishReason || error?.finishReason, truncationReason: error?.truncationReason, requestParameter: error?.requestParameter })
        if (attempt) Object.assign(attempt, attemptThroughput(attempt))
        update({ status: error ? (error.code === 'AI_CANCELLED' ? 'cancelled' : 'failed') : ctx.managed ? 'validating' : 'completed',
          attempts: batch.attempts, errorCode: error?.code, completedAt: error || !ctx.managed ? beijingLogTimestamp(this.now()) : null })
        if (!ctx.managed) this.run(runId, { status: error ? 'failed' : 'completed' })
        await this.queue
      },
      retry: async errorCode => {
        await flushAttempt()
        Object.assign(attempt, { status: 'failed', complete: false, errorCode, completedAt: beijingLogTimestamp(this.now()) })
        Object.assign(attempt, attemptThroughput(attempt))
        update({ status: 'retrying', attempts: batch.attempts })
      }
    }
  }

  async snapshot({ runId } = {}) {
    await this.ready
    runId ||= [...this.runs.keys()].at(-1)
    if (runId) await this.loadRun(runId)
    return copy({ seq: this.seq, runId, runs: [...this.runs.values()].reverse(), run: this.runs.get(runId) || null,
      batches: [...this.batches.values()].filter(batch => batch.runId === runId), events: this.events.filter(event => event.runId === runId), storageError: this.storageError })
  }

  async readText({ runId, batchId, requestId, attempt = 1, kind = 'content', offset = 0, limit = 65536 }) {
    if (!token(runId) || !token(batchId) || !Number.isSafeInteger(requestId) || !Number.isSafeInteger(attempt) || !kinds.has(kind)) throw new Error('AI_TRACE_INVALID_ID')
    offset = Math.max(0, Number(offset) || 0)
    limit = Math.min(256 * 1024, Math.max(1, Number(limit) || 65536))
    const filename = path.join(this.root, runId, batchId, `${requestId}-${attempt}`, `${kind}.txt`)
    try {
      const file = await fs.promises.open(filename, 'r')
      try {
        const stat = await file.stat()
        const buffer = Buffer.alloc(limit + 4)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
        let end = Math.min(limit, bytesRead)
        while (end < bytesRead && (buffer[end] & 0xc0) === 0x80) end++
        return { text: buffer.subarray(0, end).toString('utf8'), offset, nextOffset: offset + end, totalBytes: stat.size, hasMore: offset + end < stat.size }
      } finally { await file.close() }
    } catch (error) { if (error.code === 'ENOENT') return { text: '', offset, nextOffset: offset, totalBytes: 0, hasMore: false }; throw error }
  }

  async close() {
    await this.ready
    await this.queue
    await Promise.all([...this.streams.values(), ...this.eventStreams.values()].filter(stream => !stream.destroyed).map(stream => new Promise(resolve => stream.end(resolve))))
    this.streams.clear()
    this.eventStreams.clear()
  }
}

module.exports = { AiTraceStore }

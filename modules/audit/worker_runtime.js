const { parentPort } = require('worker_threads')

const createWorkerRuntime = () => {
  let cancelled = false
  parentPort.on('message', message => {
    if (message?.type === 'cancel') cancelled = true
  })
  const post = message => parentPort.postMessage(message)
  const isCancelled = () => cancelled
  const assertNotCancelled = () => {
    if (cancelled) throw new Error('AUDIT_CANCELLED')
  }
  const progress = (phase, completed, total) => post({
    type: 'progress',
    phase,
    completed,
    total,
    phaseCompleted: completed,
    phaseTotal: total
  })
  const log = (message, level = 'info') => post({ type: 'log', message, level })
  const run = async task => {
    try {
      const result = await task({ isCancelled, assertNotCancelled, progress, log })
      post({ type: 'completed', ...result })
    } catch (error) {
      if (error.message === 'AUDIT_CANCELLED') post({ type: 'cancelled' })
      else post({ type: 'failed', error: error.stack || error.message || String(error) })
    } finally {
      parentPort.close()
    }
  }
  return { isCancelled, assertNotCancelled, progress, log, run }
}

const mapWithConcurrency = async (items, limit, task, isCancelled = () => false) => {
  const results = new Array(items.length)
  let cursor = 0
  const workerCount = Math.min(Math.max(1, Number.parseInt(limit, 10) || 1), Math.max(items.length, 1))
  const workers = Array.from({ length: workerCount }, async () => {
    while (!isCancelled()) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await task(items[index], index)
    }
  })
  await Promise.all(workers)
  if (isCancelled()) throw new Error('AUDIT_CANCELLED')
  return results
}

module.exports = { createWorkerRuntime, mapWithConcurrency }

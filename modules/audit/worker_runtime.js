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
  const progress = (phase, completed, total, currentItem = null, currentItems = currentItem ? [currentItem] : []) => post({
    type: 'progress',
    phase,
    completed,
    total,
    phaseCompleted: completed,
    phaseTotal: total,
    currentItem,
    currentItems
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
  let failed = false
  const workerCount = Math.min(Math.max(1, Number.parseInt(limit, 10) || 1), Math.max(items.length, 1))
  const workers = Array.from({ length: workerCount }, async () => {
    while (!failed && !isCancelled()) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      try {
        results[index] = await task(items[index], index)
      } catch (error) {
        failed = true
        throw error
      }
    }
  })
  const settled = await Promise.allSettled(workers)
  const rejected = settled.find(result => result.status === 'rejected')
  if (rejected) throw rejected.reason
  if (isCancelled()) throw new Error('AUDIT_CANCELLED')
  return results
}

module.exports = { createWorkerRuntime, mapWithConcurrency }

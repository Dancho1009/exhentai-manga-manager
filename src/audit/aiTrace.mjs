import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { formatBeijingLogTime } from './logTime.mjs'
import { useI18n } from 'vue-i18n'

export const bytesText = bytes => !Number.isFinite(bytes) ? '—' : bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(2)} MiB`
export const activeStatuses = new Set(['requesting', 'receiving', 'retrying', 'parsing', 'validating', 'saving'])
export const tpsText = (attempt, t) => Number.isFinite(attempt?.outputTps) && attempt.outputTps >= 0
  ? `${attempt.outputTps.toFixed(2)} tokens/s`
  : t(attempt && !attempt.completedAt && activeStatuses.has(attempt.status) ? 'aiTrace.tpsPending' : 'aiTrace.unknown')
export const useAiTrace = (api, { followLatest = true } = {}) => {
  const { t } = useI18n()
  const runId = ref(''), runs = ref([]), run = ref(null), batches = shallowRef([]), events = ref([]), error = ref('')
  const records = new Map(), versions = new Map()
  let remove, alive = true, revision = 0
  const apply = updates => {
    let changed = false
    for (const event of updates) {
      if (event.error) { error.value = event.error; continue }
      if (event.run) runs.value = runs.value.some(item => item.runId === event.runId)
        ? runs.value.map(item => item.runId === event.runId ? event.run : item) : [event.run, ...runs.value]
      if (event.run && event.runId === runId.value) run.value = event.run
      if (!runId.value || (followLatest && event.run && event.run.status === 'running' && !run.value?.status?.includes('running'))) {
        runId.value = event.runId
        void refresh(event.runId)
      }
      if (event.runId !== runId.value) continue
      const key = event.batch?.batchId || 'run'
      if ((versions.get(key) || 0) >= event.seq) continue
      versions.set(key, event.seq)
      if (event.batch) { records.set(key, event.batch); changed = true }
      events.value = [...events.value, event].slice(-500)
    }
    if (changed) batches.value = [...records.values()]
  }
  const refresh = async selected => {
    if (!api) return
    const current = ++revision
    try {
      const snapshot = await api.snapshot({ runId: selected || undefined })
      if (!alive || current !== revision) return
      const newer = events.value.filter(event => event.runId === snapshot.runId && event.seq > snapshot.seq)
      runId.value = snapshot.runId || ''
      runs.value = snapshot.runs || []
      run.value = snapshot.run
      records.clear(); versions.clear()
      for (const batch of snapshot.batches || []) records.set(batch.batchId, batch)
      for (const batch of snapshot.batches || []) versions.set(batch.batchId, snapshot.seq)
      batches.value = [...records.values()]
      events.value = snapshot.events || []
      error.value = snapshot.storageError || ''
      apply(newer)
    } catch (value) { error.value = String(value.message || value) }
  }
  const logs = computed(() => events.value.filter(event => event.event !== 'receiving' && event.batch?.status !== 'queued').map(event => {
    const batch = event.batch
    return { at: event.at, seq: event.seq, runId: event.runId, jobId: event.runId, taskType: 'ai', task: run.value?.task,
      level: batch?.status === 'failed' || event.run?.status === 'failed' ? 'error' : 'info',
      message: batch ? `${t(`aiTrace.phase_${batch.phase}`)} #${batch.batchIndex}/${batch.batchTotal} · ${t(`aiTrace.status_${batch.status}`)} · ${t('aiTrace.counts')} ${batch.phase === 'normalizing' ? batch.bookCount : batch.pairCount} / ${batch.returnedCount ?? '—'} / ${batch.savedCount || 0}${batch.recoverySavedCount !== undefined ? ` · ${t('aiTrace.retrySaved')} ${batch.recoverySavedCount} · ${t('aiTrace.unresolved')} ${batch.unresolvedCount}` : ''}${batch.recoverySizes?.length ? ` · ${t('aiTrace.splitInto')} ${batch.recoverySizes.join(' + ')} · ${t('aiTrace.recoveryReason')} ${batch.truncationReason || batch.recoveryReason}` : ''}${batch.attempts?.length ? ` · ${t('aiTrace.tps')} ${tpsText(batch.attempts.at(-1), t)}` : ''}${batch.errorCode ? ` · ${batch.status === 'recovered' ? t('aiTrace.initialError') + ' · ' : ''}${batch.errorCode}` : ''}`
        : `${t(`aiTrace.phase_${event.run?.phase || 'preparing'}`)} · ${t(`aiTrace.status_${event.run?.status || 'idle'}`)}` }
  }))
  onMounted(() => { if (api) { remove = api.onEvents(apply); void refresh() } })
  onBeforeUnmount(() => { alive = false; remove?.() })
  return { runId, runs, run, batches, events, logs, error, refresh, apply }
}

export { formatBeijingLogTime }

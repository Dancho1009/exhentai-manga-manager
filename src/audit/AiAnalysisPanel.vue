<template>
  <section v-if="api" :class="['ai-analysis-panel', { 'ai-inline': compact }]" :data-ai-task="task">
    <div class="ai-toolbar">
      <strong>{{ t(compact ? 'ai.advice' : 'ai.task_' + task) }}</strong>
      <el-button size="small" type="primary" :disabled="running || pending || busy || disabled" :loading="pending" @click="start(false)">{{ t(groupId ? 'ai.analyzeGroup' : state.task === task && state.partial ? 'ai.continueAnalysis' : 'ai.start_' + task) }}</el-button>
      <el-button v-if="compact && reportId" size="small" :disabled="running || pending || busy || disabled" @click="start(false, true)">{{ t('ai.analyzeReport') }}</el-button>
      <el-button v-if="results.length" size="small" :disabled="running || pending || busy || disabled" @click="start(true)">{{ t('ai.reanalyze') }}</el-button>
      <el-button v-if="running && state.task === task" size="small" :disabled="state.status === 'cancelling'" @click="cancel">{{ t('ai.cancel') }}</el-button>
      <el-button size="small" @click="settingsVisible = true">{{ t('ai.settings') }}</el-button>
    </div>
    <p v-if="!compact" class="ai-help">{{ t('ai.description_' + task) }} {{ t('ai.dataScope') }}</p>
    <div class="ai-progress" aria-live="polite">
      <template v-if="state.task === task">
        <span>{{ t('ai.status_' + (state.status === 'completed' && state.partial ? 'partial' : state.status || 'idle')) }}<template v-if="running"> · {{ t('ai.phase_' + (state.phase || 'classifying')) }}</template></span>
        <span>{{ t('ai.progress', { done: state.completed || 0, total: state.total || 0, cached: state.cached || 0, failed: state.failed || 0 }) }}</span>
        <span v-if="running && state.currentTitle" class="ai-current" :title="state.currentTitle">{{ state.currentTitle }}</span>
      </template>
      <span v-else>{{ t('ai.advisoryOnly') }}</span>
    </div>
    <el-alert v-if="error || state.task === task && state.error" type="error" :closable="false" :title="formatError(error || state.error, error ? null : state.errorDetail)" show-icon />
    <el-alert v-if="state.task === task && state.candidateLimit" type="warning" :closable="false" :title="t('ai.candidateLimit')" />
    <el-alert v-else-if="state.task === task && state.limited" type="info" :closable="false" :title="t('ai.limited')" />
    <el-alert v-if="configurationNeeded" type="info" :closable="false" :title="t('ai.configurationNeeded')" />
    <details :open="!compact" class="ai-results" @toggle="resultsExpanded = $event.target.open">
      <summary>{{ t('ai.results', { count: results.length }) }}<span v-if="latestDate"> · {{ latestDate }}</span></summary>
      <div v-loading="loading" class="ai-result-body">
        <template v-if="resultsExpanded">
          <div v-if="task === 'discovery' && results.length" class="ai-candidate-actions">
            <el-button type="primary" :loading="verifying" :disabled="busy || running || verifying || !selectedResults.length" @click="verifyCandidates">{{ t('ai.verifyCandidates', { count: selectedResults.length }) }}</el-button>
            <span>{{ t('ai.verifyDescription') }}</span>
          </div>
          <el-empty v-if="!results.length && !loading" :image-size="50" :description="t('ai.noResults')" />
          <article v-for="result in results" :key="result.id" class="ai-result" :data-result-id="result.id">
            <header class="ai-result-heading">
              <el-checkbox v-if="task === 'discovery' && canVerify(result)" v-model="selectedResults" :value="result.id" :label="result.id">{{ t('ai.selectCandidate') }}</el-checkbox>
              <el-tag v-if="result.status === 'failed'" type="danger" size="small">{{ t('ai.status_failed') }}</el-tag>
              <el-tag v-else-if="isStale(result)" type="warning" size="small">{{ t('ai.stale') }}</el-tag>
              <el-tag v-else size="small" effect="plain">{{ t('ai.advice') }}</el-tag>
              <span>{{ result.series ? t('ai.seriesSummary', { groups: result.series.groups.length, publications: result.series.publicationRelations.length, uncertain: result.series.uncertainRelations.length }) : (result.books || []).map(book => book.title || book.title_jpn || book.id).join(' ↔ ') }}</span>
            </header>
            <p v-if="result.error" class="ai-error">{{ formatError(result.error, result.errorDetail) }}</p>
            <p v-if="isStale(result)" class="ai-help">{{ t('ai.staleDescription') }}</p>
            <el-alert v-for="(conflict, index) in result.conflicts || []" :key="'conflict-' + index" type="warning" :closable="false" :title="t('ai.localContentConflict')" :description="relationTitles(result, conflict)" />
            <template v-if="task === 'series' && result.series">
              <section v-for="group in result.series.groups || []" :key="group.id" class="ai-series-group">
                <h3>{{ group.title || t('ai.unnamedSeries') }}</h3>
                <el-table :data="group.members || []" size="small">
                  <el-table-column :label="t('ai.book')" min-width="260"><template #default="{ row }"><span>{{ row.title || row.title_jpn || row.id }}</span></template></el-table-column>
                  <el-table-column :label="t('ai.workOrdinal')" min-width="130"><template #default="{ row }">{{ bookOrdinal(row) }}</template></el-table-column>
                  <el-table-column :label="t('ai.publication')" min-width="180"><template #default="{ row }">{{ publication(row) }}</template></el-table-column>
                </el-table>
                <p v-for="(uncertainty, index) in group.uncertainties || []" :key="index" class="ai-help">{{ typeof uncertainty === 'string' ? uncertainty : uncertainty.reason }}</p>
                <details v-if="group.relations?.length" class="ai-series-reasons"><summary>{{ t('ai.relationshipReasons') }}</summary><div v-for="(relation, index) in group.relations" :key="index" class="ai-relation"><span>{{ relationTitles(result, relation) }}</span><p>{{ relation.reason }}</p></div></details>
              </section>
              <h4 v-if="result.series.publicationRelations?.length">{{ t('ai.publicationRelations') }}</h4>
              <div v-for="(relation, index) in result.series.publicationRelations || []" :key="'publication-' + index" class="ai-relation">
                <span>{{ relationTitles(result, relation) }}</span><el-tag size="small" type="info">{{ relationLabel(relation.relation) }}</el-tag><p>{{ relation.reason }}</p>
              </div>
              <h4 v-if="result.series.uncertainRelations?.length">{{ t('ai.uncertainRelations') }}</h4>
              <div v-for="(relation, index) in result.series.uncertainRelations || []" :key="'unknown-' + index" class="ai-relation">
                <span>{{ relationTitles(result, relation) }}</span><p>{{ relation.reason }}</p>
              </div>
            </template>
            <div v-for="(relation, index) in result.relations || []" :key="index" class="ai-relation">
              <span>{{ relationTitles(result, relation) }}</span>
              <el-tag :type="relation.relation === 'unknown' ? 'info' : 'warning'" size="small">{{ relationLabel(relation.relation) }}</el-tag>
              <p>{{ relation.reason }}</p>
              <p v-for="(warning, warningIndex) in relation.warnings || []" :key="'warning-' + warningIndex" class="ai-help">{{ warning }}</p>
            </div>
          </article>
        </template>
      </div>
    </details>
    <el-dialog v-model="settingsVisible" :title="t('ai.settings')" width="min(680px, 94vw)" append-to-body destroy-on-close><ai-settings :api="api" @saved="configurationNeeded = false" /></el-dialog>
  </section>
</template>

<script setup>
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
const AiSettings = defineAsyncComponent(() => import('../components/AiSettings.vue'))

const props = defineProps({ task: { type: String, required: true }, reportId: { type: String, default: '' }, groupId: { type: String, default: '' }, evidenceRevision: { type: String, default: '' }, compact: Boolean, busy: Boolean, disabled: Boolean })
const emit = defineEmits(['verified'])
const { t, te } = useI18n()
const api = window.auditApi?.ai
const state = ref({ status: 'idle' }), results = ref([]), error = ref(''), loading = ref(false), pending = ref(false), verifying = ref(false), settingsVisible = ref(false), configurationNeeded = ref(false), selectedResults = ref([]), resultsExpanded = ref(!props.compact)
let unsubscribe, loadToken = 0, unmounted = false
const running = computed(() => ['running', 'cancelling'].includes(state.value.status))
const latestDate = computed(() => results.value[0]?.createdAt ? new Date(results.value[0].createdAt).toLocaleString() : '')
const isStale = result => result.stale || Boolean(props.evidenceRevision && result.evidenceRevision && props.evidenceRevision !== result.evidenceRevision)
const canVerify = result => result.status === 'completed' && !isStale(result) && result.relations?.some(relation => ['same_work_same_part', 'same_work_different_edition'].includes(relation.relation))
const relationLabel = value => te('ai.relation_' + value) ? t('ai.relation_' + value) : t('ai.relation_unknown')
const formatError = (error, detail) => {
  const raw = String(error?.message || error), code = error?.code || raw.match(/AI_[A-Z_]+/)?.[0]
  if (code === 'AI_RESULT_INVALID' && detail?.reason && te('ai.validation_' + detail.reason)) {
    const message = t('ai.validation_' + detail.reason)
    return detail.path ? t('ai.validationField', { message, field: detail.path }) : message
  }
  return code && te('ai.error_' + code) ? t('ai.error_' + code) : raw
}
const relationTitles = (result, relation) => [relation.leftId, relation.rightId].map(id => result.books?.find(book => book.id === id)?.title || result.books?.find(book => book.id === id)?.title_jpn || id).join(' ↔ ')
const ordinalText = value => value == null ? '' : typeof value === 'object' ? String(value.text ?? value.value ?? (value.start != null ? [value.start, value.end].filter(item => item != null).join('–') : '')) : String(value)
const bookOrdinal = book => {
  const semantic = book.aiSemantic || book.semantic || {}
  return [semantic.volume != null ? t('ai.volumeValue', { value: ordinalText(semantic.volume) }) : '', semantic.chapter != null ? t('ai.chapterValue', { value: ordinalText(semantic.chapter) }) : ''].filter(Boolean).join(' · ') || t('ai.unknownOrdinal')
}
const publication = book => {
  const sources = book.aiSemantic?.publication ? [book.aiSemantic.publication] : book.semantic?.publications || (book.semantic?.publication ? [book.semantic.publication] : [])
  return sources.map(source => [source.name || source.title, source.issue || source.issueText, source.date].filter(Boolean).join(' · ')).filter(Boolean).join(' / ') || t('ai.unknownOrdinal')
}
const loadResults = async () => {
  if (!api) return
  const token = ++loadToken; loading.value = true
  try {
    const values = await api.getResults({ task: props.task, ...(props.reportId ? { reportId: props.reportId } : {}) })
    if (token !== loadToken || unmounted) return
    results.value = values.filter(value => !props.groupId || value.groupId === props.groupId)
    selectedResults.value = selectedResults.value.filter(id => results.value.some(result => result.id === id && canVerify(result)))
  } catch (failure) { if (token === loadToken && !unmounted) error.value = String(failure?.message || failure) }
  finally { if (token === loadToken && !unmounted) loading.value = false }
}
const start = async (force, all = false) => {
  if (running.value || pending.value) return
  pending.value = true; error.value = ''; configurationNeeded.value = false
  try {
    const settings = await api.getConfig(), { config } = settings
    const ready = typeof settings.ready === 'boolean' ? settings.ready : Boolean(config.baseUrl && config.model)
    if (!config.enabled || !ready || (props.task === 'series' ? !config.seriesEnabled : !config.dedupeEnabled)) { configurationNeeded.value = true; settingsVisible.value = true; return }
    state.value = await api.start({ task: props.task, ...(props.reportId ? { reportId: props.reportId } : {}), ...(!all && props.groupId ? { groupIds: [props.groupId] } : {}), force })
    if (!['running', 'cancelling'].includes(state.value.status)) await loadResults()
  } catch (failure) { error.value = String(failure?.message || failure) } finally { pending.value = false }
}
const cancel = async () => { try { state.value = await api.cancel() } catch (failure) { error.value = String(failure?.message || failure) } }
const verifyCandidates = async () => {
  verifying.value = true; error.value = ''
  try { await api.verifyCandidates({ resultIds: [...selectedResults.value] }); selectedResults.value = []; emit('verified') } catch (failure) { error.value = String(failure?.message || failure) } finally { verifying.value = false }
}
watch(() => [props.task, props.reportId, props.groupId], () => { selectedResults.value = []; error.value = ''; void loadResults() })
onMounted(async () => {
  if (!api) return
  unsubscribe = api.onState(value => { state.value = value; if (value.task === props.task && !['running', 'cancelling'].includes(value.status)) void loadResults() })
  try { state.value = await api.getState(); await loadResults() } catch (failure) { error.value = String(failure?.message || failure) }
})
onBeforeUnmount(() => { unmounted = true; ++loadToken; unsubscribe?.() })
</script>

<style scoped>
.ai-analysis-panel { height: 100%; overflow: auto; padding: 10px 0 20px; box-sizing: border-box; }
.ai-analysis-panel.ai-inline { height: auto; overflow: visible; border: 1px solid var(--el-border-color); border-radius: 6px; margin: 8px 0; padding: 10px 12px; }
.ai-toolbar, .ai-progress, .ai-result-heading, .ai-candidate-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.ai-toolbar :deep(.el-button) { margin-left: 0; }
.ai-progress { min-height: 24px; font-size: 12px; color: var(--el-text-color-secondary); margin: 6px 0; }
.ai-current { max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-help { line-height: 1.6; color: var(--el-text-color-secondary); margin: 8px 0; }
.ai-results summary { cursor: pointer; font-size: 13px; color: var(--el-text-color-secondary); padding: 4px 0; }
.ai-result-body { min-height: 20px; }
.ai-result { padding: 12px; border: 1px solid var(--el-border-color-light); border-radius: 6px; margin-top: 10px; overflow-wrap: anywhere; }
.ai-result-heading > span:last-child { flex: 1; min-width: 160px; font-weight: 500; }
.ai-relation { padding: 8px 0; border-bottom: 1px solid var(--el-border-color-lighter); line-height: 1.5; }
.ai-relation :deep(.el-tag) { margin-left: 10px; }
.ai-relation p { margin: 4px 0; color: var(--el-text-color-secondary); }
.ai-error { color: var(--el-color-danger); }
.ai-candidate-actions { margin: 10px 0; font-size: 13px; }
.ai-series-group h3 { font-size: 16px; margin-bottom: 8px; }
.ai-analysis-panel :deep(.el-alert) { margin: 8px 0; }
</style>

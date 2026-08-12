<template>
  <el-collapse v-model="activePanels" class="log-pane" @click.stop>
    <el-collapse-item name="logs">
      <template #title>
        <div class="log-header">
          <span class="log-title"><el-icon><Tickets /></el-icon><span>{{ $t('audit.taskLog') }}</span><el-tag size="small" type="info" effect="plain">{{ logs.length }}</el-tag></span>
          <span v-if="activeTask" class="log-live-summary">
            <el-tag size="small" :type="statusTagType" effect="plain">{{ activeTaskLabel }}</el-tag>
            <span class="log-live-phase">{{ phaseLabel }}</span>
            <strong>{{ compactProgressText }}</strong>
          </span>
        </div>
      </template>
      <section v-if="activeTask" class="active-task-summary" @click.stop>
        <div class="active-task-heading">
          <div>
            <span class="active-task-kicker">{{ $t('audit.currentTask') }}</span>
            <strong>{{ activeTaskLabel }}</strong>
          </div>
          <el-tag :type="statusTagType" effect="plain">{{ statusLabel }}</el-tag>
        </div>
        <div class="active-task-progress-line">
          <span>{{ phaseLabel }}</span>
          <strong>{{ progressText }}</strong>
        </div>
        <el-progress
          :percentage="hasProgressTotal ? progressPercentage : 100"
          :indeterminate="!hasProgressTotal"
          :duration="2"
          :stroke-width="10"
          :show-text="false"
        />
        <div class="active-task-meta">
          <span><small>{{ $t('audit.startedAt') }}</small><strong>{{ startedAtText }}</strong></span>
          <span><small>{{ $t('audit.elapsedTime') }}</small><strong>{{ timing.elapsedText }}</strong></span>
          <span><small>{{ $t('audit.estimatedRemainingTime') }}</small><strong>{{ timing.remainingText }}</strong></span>
          <span><small>{{ $t('audit.estimatedFinishTime') }}</small><strong>{{ timing.finishText }}</strong></span>
          <span><small>{{ $t('audit.completedStages') }}</small><strong>{{ stageSummary.completedCount }}/{{ stageSummary.totalCount }}</strong></span>
          <span><small>{{ $t('audit.nextStage') }}</small><strong>{{ nextStageLabel }}</strong></span>
          <span><small>{{ $t('audit.remainingStages') }}</small><strong>{{ $t('audit.remainingStageCount', { count: stageSummary.remainingCount }) }}</strong></span>
          <span v-if="optionLabels.length"><small>{{ $t('audit.taskOptions') }}</small><strong>{{ optionLabels.join(' · ') }}</strong></span>
        </div>
      </section>
      <div class="log-toolbar" @click.stop>
        <el-segmented v-model="filter" size="small" :options="filterOptions" />
      </div>
      <div class="log-content" @click.stop>
        <div v-for="(entry, index) in filteredLogs" :key="`${entry.at}-${index}`" class="log-line" :class="`level-${entry.level || 'info'}`">
          <span>{{ new Date(entry.at).toLocaleString() }}</span><strong>{{ taskLabel(entry.taskType) }}</strong><code>{{ entry.message }}</code>
        </div>
        <el-empty v-if="filteredLogs.length === 0" :description="$t('audit.noLogs')" :image-size="48" />
      </div>
    </el-collapse-item>
  </el-collapse>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Tickets } from '@element-plus/icons-vue'

const props = defineProps({
  logs: { type: Array, default: () => [] },
  activeTask: { type: Object, default: null },
  activeState: { type: Object, default: () => ({}) },
  timing: { type: Object, default: () => ({ elapsedText: '-', remainingText: '-', finishText: '-' }) },
  stageSummary: { type: Object, default: () => ({ completedCount: 0, totalCount: 0, nextStage: null, remainingCount: 0 }) }
})
const { t, te } = useI18n()
const activePanels = ref([])
const filter = ref('all')

const filterOptions = computed(() => [
  { label: t('audit.allTasks'), value: 'all' },
  { label: t('audit.anomalyTab'), value: 'anomaly' },
  { label: t('audit.dedupTab'), value: 'dedupe' },
  { label: t('audit.executionTask'), value: 'execution' }
])
const filteredLogs = computed(() => filter.value === 'all' ? props.logs : props.logs.filter(entry => entry.taskType === filter.value))
const taskLabel = taskType => ({ anomaly: t('audit.anomalyTab'), dedupe: t('audit.dedupTab'), execution: t('audit.executionTask') })[taskType] || taskType
const activeTaskLabel = computed(() => props.activeTask?.type === 'execution'
  ? props.activeState?.options?.sourceTaskType === 'dedupe' ? t('audit.dedupeExecutionTask') : t('audit.anomalyExecutionTask')
  : taskLabel(props.activeTask?.type))
const phaseLabel = computed(() => {
  const key = `audit.phase_${props.activeState?.phase || 'starting'}`
  return te(key) ? t(key) : props.activeState?.phase || t('audit.phase_starting')
})
const statusLabel = computed(() => {
  const key = `audit.status_${props.activeState?.status || 'running'}`
  return te(key) ? t(key) : props.activeState?.status || t('audit.status_running')
})
const statusTagType = computed(() => ({
  running: 'primary',
  cancelling: 'warning',
  completed: 'success',
  failed: 'danger',
  interrupted: 'warning'
})[props.activeState?.status] || 'info')
const completed = computed(() => Math.max(0, Number(props.activeState?.phaseCompleted ?? props.activeState?.completed ?? 0) || 0))
const total = computed(() => Math.max(0, Number(props.activeState?.phaseTotal ?? props.activeState?.total ?? 0) || 0))
const hasProgressTotal = computed(() => total.value > 0)
const progressPercentage = computed(() => hasProgressTotal.value ? Math.min(100, Math.round(completed.value / total.value * 100)) : 0)
const compactProgressText = computed(() => hasProgressTotal.value
  ? `${completed.value}/${total.value} · ${progressPercentage.value}%`
  : t('audit.calculatingTotal'))
const progressText = computed(() => hasProgressTotal.value
  ? t('audit.stageProgressValue', { completed: completed.value, total: total.value, percentage: progressPercentage.value })
  : t('audit.calculatingTotal'))
const startedAtText = computed(() => props.activeState?.startedAt
  ? new Date(props.activeState.startedAt).toLocaleString()
  : '-')
const nextStageLabel = computed(() => props.stageSummary?.nextStage?.labelKey
  ? t(props.stageSummary.nextStage.labelKey)
  : t('audit.noNextStage'))
const optionLabels = computed(() => {
  const options = props.activeState?.options || {}
  if (props.activeTask?.type === 'anomaly') {
    const policyKey = {
      none: 'audit.onlinePolicyNone',
      conflicts: 'audit.onlineScopeConflicts',
      urls: 'audit.onlineScopeUrls',
      ehviewer: 'audit.onlineScopeEhviewer'
    }[options.onlinePolicy] || 'audit.onlinePolicyNone'
    return [
      t(policyKey),
      options.forceLocal ? t('audit.forceLocal') : '',
      options.forceOnline ? t('audit.forceRefresh') : ''
    ].filter(Boolean)
  }
  if (props.activeTask?.type === 'dedupe') {
    return [options.forceContent ? t('audit.forceContent') : t('audit.cacheAllowed')]
  }
  if (props.activeTask?.type === 'execution') {
    return [options.sourceTaskType === 'dedupe' ? t('audit.dedupeTab') : t('audit.anomalyTab')]
  }
  return []
})

</script>

<style scoped>
.log-pane { position: relative; z-index: 4; flex: 0 0 auto; margin: 0 18px 12px; overflow: hidden; border: 1px solid var(--el-border-color); border-radius: 4px; background: var(--el-bg-color-overlay); }
.log-pane :deep(.el-collapse-item__header) { min-height: 48px; padding: 0 16px; color: var(--el-text-color-primary); background: var(--el-fill-color-light); cursor: pointer; }
.log-pane :deep(.el-collapse-item__title) { min-width: 0; }
.log-header { display: flex; align-items: center; justify-content: space-between; gap: 20px; width: 100%; min-width: 0; padding-right: 12px; }
.log-title { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 9px; font-weight: 600; }
.log-live-summary { display: flex; min-width: 0; align-items: center; justify-content: flex-end; gap: 10px; color: var(--el-text-color-regular); font-size: 12px; }
.log-live-phase { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log-live-summary strong { flex: 0 0 auto; color: var(--el-color-primary); font-variant-numeric: tabular-nums; }
.active-task-summary { padding: 12px 16px 14px; border-bottom: 1px solid var(--el-border-color); background: var(--el-fill-color-lighter); }
.active-task-heading, .active-task-progress-line { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.active-task-heading > div { display: flex; align-items: baseline; gap: 10px; }
.active-task-kicker { color: var(--el-text-color-secondary); font-size: 12px; }
.active-task-progress-line { margin: 12px 0 7px; }
.active-task-progress-line span { font-weight: 600; }
.active-task-progress-line strong { color: var(--el-color-primary); font-size: 13px; font-variant-numeric: tabular-nums; }
.active-task-meta { display: flex; flex-wrap: wrap; gap: 18px 32px; margin-top: 11px; }
.active-task-meta > span { display: grid; grid-template-columns: auto auto; align-items: baseline; gap: 8px; min-width: 0; }
.active-task-meta small { color: var(--el-text-color-secondary); }
.active-task-meta strong { overflow-wrap: anywhere; font-size: 12px; font-weight: 500; }
.log-toolbar { padding: 8px 14px; border-bottom: 1px solid var(--el-border-color); }
.log-content { max-height: 220px; padding: 8px 14px; overflow: auto; background: var(--el-bg-color); }
.log-line { display: grid; grid-template-columns: 170px 76px minmax(0, 1fr); gap: 10px; min-height: 28px; align-items: baseline; padding: 4px 8px; border-left: 3px solid var(--el-border-color); }
.log-line span { color: var(--el-text-color-secondary); font-size: 12px; }
.log-line strong { font-size: 12px; }
.log-line code { overflow-wrap: anywhere; white-space: pre-wrap; }
.level-info { border-color: var(--el-color-primary); }
.level-warning { border-color: var(--el-color-warning); background: var(--el-color-warning-light-9); }
.level-error { border-color: var(--el-color-danger); background: var(--el-color-danger-light-9); }
@media (max-width: 900px) {
  .log-live-summary .el-tag { display: none; }
  .active-task-meta { gap: 10px 18px; }
}
</style>

<template>
  <el-config-provider :locale="elementLocale">
    <main class="audit-shell">
      <header class="audit-toolbar">
        <div class="audit-heading">
          <h1>{{ $t('audit.title') }}</h1>
          <span :title="initialSetting.library">{{ initialSetting.library }}</span>
        </div>
        <div class="audit-actions">
          <el-tag v-if="activeTask" type="warning" effect="plain">{{ activeTaskLabel }}</el-tag>
          <el-tooltip :content="$t('audit.stop')">
            <el-button :icon="VideoPause" :disabled="!activeTask || actionPending" @click="cancelActive" />
          </el-tooltip>
          <el-tooltip :content="$t('audit.reload')">
            <el-button :icon="Refresh" :disabled="actionPending" @click="reloadAll" />
          </el-tooltip>
        </div>
      </header>

      <section v-if="activeTask" class="task-band">
        <div class="task-line">
          <span>{{ activeTaskLabel }} · {{ activeStatusLabel }}</span>
          <span>{{ activePhaseLabel }} · {{ activeCompleted }}/{{ activeTotal }}</span>
        </div>
        <el-progress :percentage="progressPercentage" :stroke-width="12" />
        <div class="task-estimate-line">
          <span>{{ $t('audit.estimatedRemainingTime') }} <strong>{{ activeTiming.remainingText }}</strong></span>
          <span>{{ $t('audit.estimatedFinishTime') }} <strong>{{ activeTiming.finishText }}</strong></span>
        </div>
        <el-alert v-if="activeState.error" type="error" :closable="false" :title="activeState.error" show-icon />
      </section>

      <el-tabs v-model="activeTab" class="audit-tabs">
        <el-tab-pane :label="$t('audit.anomalyTab')" name="anomaly">
          <anomaly-panel
            :report="anomalyReport"
            :state="anomalyState"
            :busy="busy"
            :review-locked="reviewLocked"
            :action-ids="anomalyReview.actionIds"
            :review-saving="reviewSaving.anomaly"
            :review-dirty="reviewDirty.anomaly"
            @start="startAnomaly"
            @verify-conflicts="verifyConflicts"
            @update:action-ids="updateAnomalyActions"
            @save-review="saveAnomalyReview"
            @execute="prepareExecution('anomaly')"
          />
        </el-tab-pane>
        <el-tab-pane :label="$t('audit.dedupTab')" name="dedupe">
          <dedupe-panel
            :report="dedupeReport"
            :state="dedupeState"
            :busy="busy"
            :review-locked="reviewLocked"
            :selections="dedupeReview.selections"
            :quarantine-root="dedupeReview.quarantineRoot"
            :review-saving="reviewSaving.dedupe"
            :review-dirty="reviewDirty.dedupe"
            @start="startDedupe"
            @update:selections="updateDedupeSelections"
            @update:quarantine-root="updateQuarantineRoot"
            @select-quarantine="selectQuarantine"
            @save-review="saveDedupeReview"
            @execute="prepareExecution('dedupe')"
          />
        </el-tab-pane>
      </el-tabs>

      <audit-execution-confirm-dialog
        v-model="executionDialogVisible"
        :preview="executionPreview"
        :submitting="executionSubmitting"
        @confirm="confirmExecution"
      />

      <audit-log-panel
        :logs="logs"
        :active-task="activeTask"
        :active-state="activeState"
        :timing="activeTiming"
      />
    </main>
  </el-config-provider>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { Refresh, VideoPause } from '@element-plus/icons-vue'
import zhCnElement from 'element-plus/dist/locale/zh-cn.mjs'
import zhTwElement from 'element-plus/dist/locale/zh-tw.mjs'
import enElement from 'element-plus/dist/locale/en.mjs'
import AnomalyPanel from './audit/AnomalyPanel.vue'
import DedupePanel from './audit/DedupePanel.vue'
import AuditExecutionConfirmDialog from './audit/AuditExecutionConfirmDialog.vue'
import AuditLogPanel from './audit/AuditLogPanel.vue'
import { calculateTaskTiming, formatTaskDuration } from './audit/taskTiming.mjs'

const props = defineProps({ initialSetting: { type: Object, required: true } })
const { t, te, locale } = useI18n()
const initialSetting = props.initialSetting

const idleState = taskType => ({
  taskType,
  status: 'idle',
  phase: 'idle',
  completed: 0,
  total: 0,
  phaseCompleted: 0,
  phaseTotal: 0,
  phaseStartedAt: null,
  phaseStartCompleted: 0,
  latestReportId: null,
  error: null
})

const emptyWorkspace = () => ({
  schemaVersion: 4,
  activeTask: null,
  channels: {
    anomaly: idleState('anomaly'),
    dedupe: idleState('dedupe'),
    execution: idleState('execution')
  },
  lock: { locked: false }
})

const workspace = ref(emptyWorkspace())
const anomalyReport = ref(null)
const dedupeReport = ref(null)
const anomalyReview = ref({ reportId: null, actionIds: [] })
const dedupeReview = ref({ reportId: null, selections: {} })
const logs = ref([])
const activeTab = ref('anomaly')
const actionPending = ref(false)
const dataLoadCount = ref(0)
const defaultQuarantineRoot = `${String(initialSetting.library || '').replace(/[\\/][^\\/]+[\\/]?$/, '')}\\DedupeReview`
const reviewSaving = reactive({ anomaly: false, dedupe: false })
const reviewDirty = reactive({ anomaly: false, dedupe: false })
const reviewRevision = { anomaly: 0, dedupe: 0 }
const reviewSavePending = { anomaly: 0, dedupe: 0 }
const executionDialogVisible = ref(false)
const executionPreview = ref(null)
const executionSubmitting = ref(false)
const reportLoadTokens = { anomaly: 0, dedupe: 0 }
const reviewSaveQueues = { anomaly: Promise.resolve(), dedupe: Promise.resolve() }
const reviewSaveTimers = { anomaly: null, dedupe: null }
let removeStateListener
let removeLogListener
let clockTimer
const now = ref(Date.now())

const elementLocale = computed(() => locale.value === 'zh-TW' ? zhTwElement : locale.value === 'en-US' ? enElement : zhCnElement)
const anomalyState = computed(() => workspace.value.channels?.anomaly || idleState('anomaly'))
const dedupeState = computed(() => workspace.value.channels?.dedupe || idleState('dedupe'))
const activeTask = computed(() => workspace.value.activeTask)
const activeState = computed(() => activeTask.value ? workspace.value.channels?.[activeTask.value.type] || idleState(activeTask.value.type) : idleState('idle'))
const busy = computed(() => Boolean(activeTask.value) || actionPending.value || dataLoadCount.value > 0)
const reviewLocked = computed(() => busy.value)
const activeCompleted = computed(() => Number(activeState.value.phaseCompleted ?? activeState.value.completed ?? 0))
const activeTotal = computed(() => Number(activeState.value.phaseTotal ?? activeState.value.total ?? 0))
const progressPercentage = computed(() => activeTotal.value > 0 ? Math.min(100, Math.round(activeCompleted.value / activeTotal.value * 100)) : 0)
const taskLabel = taskType => ({ anomaly: t('audit.anomalyTab'), dedupe: t('audit.dedupTab'), execution: t('audit.executionTask') })[taskType] || taskType
const activeTaskLabel = computed(() => activeTask.value?.type === 'execution'
  ? activeState.value.options?.sourceTaskType === 'dedupe' ? t('audit.dedupeExecutionTask') : t('audit.anomalyExecutionTask')
  : taskLabel(activeTask.value?.type))
const activeStatusLabel = computed(() => {
  const key = `audit.status_${activeState.value.status}`
  return te(key) ? t(key) : activeState.value.status
})
const activePhaseLabel = computed(() => {
  const key = `audit.phase_${activeState.value.phase}`
  return te(key) ? t(key) : activeState.value.phase
})
const activeTiming = computed(() => {
  const timing = calculateTaskTiming(activeState.value, now.value)
  return {
    elapsedText: formatTaskDuration(timing.elapsedSeconds),
    remainingText: timing.remainingSeconds === null ? t('audit.estimatingTime') : formatTaskDuration(timing.remainingSeconds),
    finishText: timing.finishAt === null ? t('audit.estimatingTime') : new Date(timing.finishAt).toLocaleString()
  }
})

const normalizeWorkspace = value => ({
  ...emptyWorkspace(),
  ...(value || {}),
  channels: {
    anomaly: { ...idleState('anomaly'), ...(value?.channels?.anomaly || {}) },
    dedupe: { ...idleState('dedupe'), ...(value?.channels?.dedupe || {}) },
    execution: { ...idleState('execution'), ...(value?.channels?.execution || {}) }
  }
})

const defaultReview = (taskType, report) => taskType === 'anomaly'
  ? { reportId: report?.reportId || null, actionIds: [] }
  : { reportId: report?.reportId || null, selections: {}, quarantineRoot: defaultQuarantineRoot }

const loadTaskData = async taskType => {
  const token = ++reportLoadTokens[taskType]
  dataLoadCount.value += 1
  try {
    const [report, review] = await Promise.all([
      window.auditApi.getReport(taskType),
      window.auditApi.getReview(taskType)
    ])
    if (token !== reportLoadTokens[taskType]) return
    const normalizedReview = report && review?.reportId === report.reportId ? review : defaultReview(taskType, report)
    reviewRevision[taskType] += 1
    if (taskType === 'anomaly') {
      anomalyReport.value = report
      anomalyReview.value = normalizedReview
    } else {
      dedupeReport.value = report
      dedupeReview.value = { ...normalizedReview, quarantineRoot: normalizedReview?.quarantineRoot || defaultQuarantineRoot }
    }
    reviewDirty[taskType] = false
  } finally {
    dataLoadCount.value = Math.max(0, dataLoadCount.value - 1)
  }
}

const applyWorkspaceState = value => {
  const previousAnomalyId = workspace.value.channels?.anomaly?.latestReportId
  const previousDedupeId = workspace.value.channels?.dedupe?.latestReportId
  workspace.value = normalizeWorkspace(value)
  const nextAnomalyId = workspace.value.channels.anomaly.latestReportId
  const nextDedupeId = workspace.value.channels.dedupe.latestReportId
  if (nextAnomalyId !== previousAnomalyId) void loadTaskData('anomaly').catch(showError)
  if (nextDedupeId !== previousDedupeId) void loadTaskData('dedupe').catch(showError)
}

const showError = error => {
  console.error(error)
  const message = String(error?.message || error || '')
    .replace(/^Error invoking remote method '[^']+': Error:\s*/, '')
  ElMessage.error(message || t('m.error'))
}

const appendLog = entry => {
  logs.value = [...logs.value, entry].sort((left, right) => String(left.at).localeCompare(String(right.at))).slice(-400)
}

const runAction = async action => {
  if (actionPending.value) return
  actionPending.value = true
  try {
    const state = await action()
    if (state?.channels) applyWorkspaceState(state)
    return state
  } catch (error) {
    showError(error)
    return null
  } finally {
    actionPending.value = false
  }
}

const startAnomaly = options => runAction(() => window.auditApi.startAnomaly(options))
const verifyConflicts = bookIds => runAction(() => window.auditApi.startAnomaly({
  onlinePolicy: 'conflicts',
  onlineBookIds: bookIds,
  forceLocal: false,
  forceOnline: false
}))
const startDedupe = options => runAction(() => window.auditApi.startDedupe(options))
const cancelActive = () => runAction(() => window.auditApi.cancelActive())
const scheduleReviewSave = taskType => {
  reviewDirty[taskType] = true
  window.clearTimeout(reviewSaveTimers[taskType])
  reviewSaveTimers[taskType] = window.setTimeout(() => {
    void persistReview(taskType).catch(showError)
  }, 500)
}

const updateAnomalyActions = actionIds => {
  reviewRevision.anomaly += 1
  anomalyReview.value = { ...anomalyReview.value, actionIds }
  scheduleReviewSave('anomaly')
}
const updateDedupeSelections = selections => {
  reviewRevision.dedupe += 1
  dedupeReview.value = { ...dedupeReview.value, selections }
  scheduleReviewSave('dedupe')
}
const updateQuarantineRoot = value => {
  reviewRevision.dedupe += 1
  dedupeReview.value = { ...dedupeReview.value, quarantineRoot: value }
  scheduleReviewSave('dedupe')
}

const persistReview = (taskType, { notify = false } = {}) => {
  window.clearTimeout(reviewSaveTimers[taskType])
  reviewSaveTimers[taskType] = null
  const report = taskType === 'anomaly' ? anomalyReport.value : dedupeReport.value
  if (!report) return Promise.reject(new Error(t('audit.noReport')))
  const snapshot = JSON.parse(JSON.stringify(taskType === 'anomaly' ? anomalyReview.value : dedupeReview.value))
  const revision = reviewRevision[taskType]
  reviewSavePending[taskType] += 1
  reviewSaving[taskType] = true
  const operation = reviewSaveQueues[taskType]
    .catch(() => {})
    .then(() => window.auditApi.saveReview(taskType, snapshot))
    .then(value => {
      if (reviewRevision[taskType] === revision) {
        if (taskType === 'anomaly') anomalyReview.value = value
        else dedupeReview.value = { ...value, quarantineRoot: value.quarantineRoot || defaultQuarantineRoot }
        reviewDirty[taskType] = false
      }
      if (notify) ElMessage.success(t('audit.reviewSaved'))
      return value
    })
    .finally(() => {
      reviewSavePending[taskType] = Math.max(0, reviewSavePending[taskType] - 1)
      reviewSaving[taskType] = reviewSavePending[taskType] > 0
    })
  reviewSaveQueues[taskType] = operation
  return operation
}

const saveAnomalyReview = () => persistReview('anomaly', { notify: true }).catch(showError)
const saveDedupeReview = () => persistReview('dedupe', { notify: true }).catch(showError)

const prepareExecution = async taskType => {
  if (busy.value) return
  try {
    await persistReview(taskType)
    const report = taskType === 'anomaly' ? anomalyReport.value : dedupeReport.value
    executionPreview.value = await window.auditApi.getExecutionPreview({ taskType, reportId: report?.reportId })
    executionDialogVisible.value = true
  } catch (error) {
    showError(error)
  }
}

const confirmExecution = async () => {
  const preview = executionPreview.value
  if (!preview || executionSubmitting.value) return
  executionSubmitting.value = true
  executionDialogVisible.value = false
  try {
    await runAction(async () => {
      const result = await window.auditApi.executeApproved({ taskType: preview.taskType, reportId: preview.reportId })
      ElMessage.success(t('audit.executionComplete', { count: Number(result?.movedCount || 0) + Number(result?.repairedCount || 0) }))
      await reloadAllData()
      return result?.state || workspace.value
    })
  } finally {
    executionSubmitting.value = false
    executionPreview.value = null
  }
}

const selectQuarantine = async () => {
  try {
    const value = await window.auditApi.selectQuarantine(dedupeReview.value.quarantineRoot)
    if (value) updateQuarantineRoot(value)
  } catch (error) {
    showError(error)
  }
}

const reloadAllData = async () => {
  const state = await window.auditApi.getWorkspaceState()
  workspace.value = normalizeWorkspace(state)
  await Promise.all([loadTaskData('anomaly'), loadTaskData('dedupe')])
  if (window.auditApi.getLogs) logs.value = await window.auditApi.getLogs(400)
  return workspace.value
}

const reloadAll = () => runAction(reloadAllData)

onMounted(async () => {
  clockTimer = window.setInterval(() => { now.value = Date.now() }, 1000)
  removeStateListener = window.auditApi.onState(applyWorkspaceState)
  removeLogListener = window.auditApi.onLog(appendLog)
  try {
    await reloadAllData()
  } catch (error) {
    showError(error)
  }
})

onBeforeUnmount(() => {
  Object.values(reviewSaveTimers).forEach(timer => window.clearTimeout(timer))
  window.clearInterval(clockTimer)
  removeStateListener?.()
  removeLogListener?.()
})
</script>

<style scoped>
.audit-shell {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100vh;
  min-width: 760px;
  overflow: hidden;
  color: var(--el-text-color-primary);
  background: var(--el-bg-color);
}
.audit-toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  min-height: 82px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--el-border-color);
}
.audit-heading { min-width: 0; }
.audit-heading h1 { margin: 0 0 5px; font-size: 24px; line-height: 1.25; letter-spacing: 0; }
.audit-heading span { display: block; overflow: hidden; color: var(--el-text-color-secondary); text-overflow: ellipsis; white-space: nowrap; }
.audit-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; }
.task-band { flex: 0 0 auto; padding: 10px 18px 12px; border-bottom: 1px solid var(--el-border-color); background: var(--el-fill-color-light); }
.task-line { display: flex; justify-content: space-between; gap: 18px; margin-bottom: 7px; }
.task-estimate-line { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px 26px; margin-top: 7px; color: var(--el-text-color-secondary); font-size: 12px; }
.task-estimate-line strong { color: var(--el-text-color-regular); font-variant-numeric: tabular-nums; }
.task-band :deep(.el-alert) { margin-top: 8px; }
.audit-tabs { flex: 1 1 auto; min-height: 0; padding: 0 18px; }
.audit-tabs :deep(.el-tabs__content) { height: calc(100% - 56px); min-height: 0; overflow: hidden; }
.audit-tabs :deep(.el-tab-pane) { height: 100%; min-height: 0; }
@media (max-width: 900px) {
  .audit-toolbar { align-items: flex-start; }
  .audit-heading h1 { font-size: 21px; }
}
</style>

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
          <el-tooltip :content="$t('audit.clearInspectionRecords')">
            <el-button
              type="danger"
              plain
              :icon="Delete"
              :title="$t('audit.clearInspectionRecords')"
              :aria-label="$t('audit.clearInspectionRecords')"
              :disabled="busy || aiRunning"
              @click="confirmClearInspectionRecords"
            />
          </el-tooltip>
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
        <div v-if="activeCurrentItems.length" class="task-current-item" :title="activeCurrentItemTooltip">
          <span>{{ $t('audit.currentItems', { count: activeCurrentItems.length }) }}</span>
          <strong>{{ activeCurrentItemText }}</strong>
        </div>
        <el-progress :percentage="progressPercentage" :stroke-width="12" />
        <audit-task-stages :summary="activeStageSummary" />
        <div class="task-estimate-line">
          <span>{{ $t('audit.estimatedRemainingTime') }} <strong>{{ activeTiming.remainingText }}</strong></span>
          <span>{{ $t('audit.estimatedFinishTime') }} <strong>{{ activeTiming.finishText }}</strong></span>
        </div>
        <el-alert v-if="activeState.error" type="error" :closable="false" :title="activeState.error" show-icon />
      </section>

      <section v-if="aiRunning || aiIncomplete" class="ai-task-band" aria-live="polite">
        <span>{{ aiTaskLabel }} · {{ $t('ai.status_' + (aiState.status === 'completed' && aiState.partial ? 'partial' : aiState.status)) }} · {{ $t('ai.phase_' + (aiState.phase || 'classifying')) }} · {{ aiState.completed || 0 }}/{{ aiState.total || 0 }}</span>
        <small v-if="aiState.phase === 'normalizing'">{{ $t('audit.aiLiveNormalization', { cached: aiState.normalizationCached || 0, failed: aiState.normalizationFailed || 0 }) }}</small>
        <small v-else-if="aiState.phase === 'classifying'">{{ $t('audit.aiLiveClassification', { candidates: aiState.candidateCount || aiState.total || 0, cached: aiState.classificationCached || 0 }) }}</small>
        <el-button v-if="aiRunning" size="small" :disabled="aiState.status === 'cancelling'" @click="cancelAi">{{ $t('ai.cancel') }}</el-button>
        <el-button v-else size="small" :disabled="busy" @click="startDedupe({ scanMode: 'ai', forceRecompute: false })">{{ $t('ai.continueAnalysis') }}</el-button>
      </section>
      <el-tabs v-model="activeTab" class="audit-tabs">
        <el-tab-pane :label="$t('audit.anomalyTab')" name="anomaly">
          <anomaly-panel
            :report="anomalyReport"
            :state="anomalyState"
            :busy="busy || aiRunning"
            :review-locked="reviewLocked"
            :action-ids="anomalyReview.actionIds"
            :manual-actions="anomalyReview.manualActions"
            :review-saving="reviewSaving.anomaly"
            :review-dirty="reviewDirty.anomaly"
            @start="startAnomaly"
            @prepare-safe="prepareSafeActions"
            @verify-conflicts="verifyConflicts"
            @update:action-ids="updateAnomalyActions"
            @update:manual-actions="updateAnomalyManualActions"
            @save-review="saveAnomalyReview"
            @execute="prepareExecution('anomaly')"
            @recovery-completed="reloadAll"
          />
        </el-tab-pane>
        <el-tab-pane :label="$t('audit.dedupTab')" name="dedupe">
          <dedupe-panel
            :active="activeTab === 'dedupe'"
            :report="dedupeReport"
            :review-report-id="dedupeReview.reportId"
            :state="dedupeState"
            :busy="busy || aiRunning"
            :review-locked="reviewLocked"
            :selections="dedupeReview.selections"
            :decisions="dedupeReview.decisions"
            :commit-decisions="commitDedupeDecisions"
            :review-saving="reviewSaving.dedupe"
            :review-dirty="reviewDirty.dedupe"
            :ai-available="aiAvailable"
            @start="startDedupe"
            @update:selections="updateDedupeSelections"
            @update:quarantine-root="updateQuarantineRoot"
            @select-quarantine="selectQuarantine"
            @save-review="saveDedupeReview"
            @execute="prepareExecution('dedupe')"
          />
        </el-tab-pane>
        <el-tab-pane v-if="aiAvailable" :label="$t('ai.task_series')" name="ai-series" lazy>
          <ai-analysis-panel task="series" :busy="busy" />
        </el-tab-pane>
      </el-tabs>

      <audit-execution-confirm-dialog
        v-model="executionDialogVisible"
        :preview="executionPreview"
        :submitting="executionSubmitting"
        @select-quarantine="selectQuarantine"
        @confirm="confirmExecution"
      />

      <audit-log-panel
        :logs="logs"
        :ai-logs="aiLogs"
        :ai-state="aiState"
        :active-task="activeTask"
        :active-state="activeState"
        :timing="activeTiming"
        :stage-summary="activeStageSummary"
      />
    </main>
  </el-config-provider>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Refresh, VideoPause } from '@element-plus/icons-vue'
import zhCnElement from 'element-plus/dist/locale/zh-cn.mjs'
import zhTwElement from 'element-plus/dist/locale/zh-tw.mjs'
import enElement from 'element-plus/dist/locale/en.mjs'
import AnomalyPanel from './audit/AnomalyPanel.vue'
import DedupePanel from './audit/DedupePanel.vue'
import AiAnalysisPanel from './audit/AiAnalysisPanel.vue'
import AuditExecutionConfirmDialog from './audit/AuditExecutionConfirmDialog.vue'
import AuditLogPanel from './audit/AuditLogPanel.vue'
import AuditTaskStages from './audit/AuditTaskStages.vue'
import { calculateTaskTiming, formatTaskDuration } from './audit/taskTiming.mjs'
import { calculateTaskStages } from './audit/taskStages.mjs'
import { compareLogTimes, formatBeijingLogTime } from './audit/logTime.mjs'

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
  currentItem: null,
  currentItems: [],
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
const dedupeReview = ref({ reportId: null, selections: {}, decisions: {} })
const logs = ref([])
const aiLogs = ref([])
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
let removeAiStateListener
const aiAvailable = Boolean(window.auditApi?.ai)
const aiState = ref({ status: 'idle' })
const aiRunning = computed(() => ['running', 'cancelling'].includes(aiState.value.status))
const aiIncomplete = computed(() => aiState.value.task === 'discovery' && !aiRunning.value &&
  (aiState.value.partial || ['failed', 'cancelled', 'interrupted'].includes(aiState.value.status)))
const aiTaskLabel = computed(() => aiState.value.task === 'discovery'
  ? t('audit.aiFullLibrary')
  : te(`ai.task_${aiState.value.task}`) ? t(`ai.task_${aiState.value.task}`) : t('audit.aiFullLibrary'))
const cancelAi = async () => { try { aiState.value = await window.auditApi.ai.cancel() } catch (error) { showError(error) } }
let clockTimer
const now = ref(Date.now())

const elementLocale = computed(() => locale.value === 'zh-TW' ? zhTwElement : locale.value === 'en-US' ? enElement : zhCnElement)
const anomalyState = computed(() => workspace.value.channels?.anomaly || idleState('anomaly'))
const dedupeState = computed(() => workspace.value.channels?.dedupe || idleState('dedupe'))
const activeTask = computed(() => workspace.value.activeTask)
const activeState = computed(() => activeTask.value ? workspace.value.channels?.[activeTask.value.type] || idleState(activeTask.value.type) : idleState('idle'))
const activeCurrentItems = computed(() => {
  const items = Array.isArray(activeState.value.currentItems) && activeState.value.currentItems.length
    ? activeState.value.currentItems
    : activeState.value.currentItem ? [activeState.value.currentItem] : []
  return items.filter(item => item?.title || item?.filepath)
})
const activeCurrentItemText = computed(() => activeCurrentItems.value.map(item => item.title || item.filepath).join('；'))
const activeCurrentItemTooltip = computed(() => activeCurrentItems.value.map(item => item.filepath || item.title).join('\n'))
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
const activeStageSummary = computed(() => calculateTaskStages({
  taskType: activeTask.value?.type,
  phase: activeState.value.phase,
  lastWorkPhase: activeState.value.lastWorkPhase,
  status: activeState.value.status,
  options: activeState.value.options || {}
}))
const activeTiming = computed(() => {
  const timing = calculateTaskTiming(activeState.value, now.value)
  return {
    elapsedText: formatTaskDuration(timing.elapsedSeconds),
    remainingText: timing.remainingSeconds === null ? t('audit.estimatingTime') : formatTaskDuration(timing.remainingSeconds),
    finishText: timing.finishAt === null ? t('audit.estimatingTime') : formatBeijingLogTime(timing.finishAt)
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
  ? { reportId: report?.reportId || null, actionIds: [], manualActions: {} }
  : { reportId: report?.reportId || null, selections: {}, decisions: {}, quarantineRoot: defaultQuarantineRoot }

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
  const code = error?.code || message.match(/AI_[A-Z_]+/)?.[0]
  ElMessage.error(code && te(`ai.error_${code}`) ? t(`ai.error_${code}`) : message || t('m.error'))
}

const appendLog = entry => {
  logs.value = [...logs.value, entry].sort(compareLogTimes).slice(-400)
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
const prepareSafeActions = async () => {
  if (busy.value || !anomalyReport.value) return
  actionPending.value = true
  try {
    const result = await window.auditApi.prepareSafeActions()
    anomalyReview.value = result.review
    reviewDirty.anomaly = false
    executionPreview.value = result.preview
    executionDialogVisible.value = true
  } catch (error) {
    showError(error)
  } finally {
    actionPending.value = false
  }
}
const verifyConflicts = bookIds => runAction(() => window.auditApi.startAnomaly({
  onlinePolicy: 'conflicts',
  onlineBookIds: bookIds,
  forceLocal: false,
  forceOnline: false
}))
const startDedupe = async options => {
  if (reviewDirty.dedupe) { try { await persistReview('dedupe') } catch (error) { showError(error); return } }
  if (options?.scanMode === 'ai') {
    return runAction(async () => {
      if (!aiAvailable) throw new Error(t('ai.unavailable'))
      const settings = await window.auditApi.ai.getConfig()
      const config = settings?.config || {}
      const ready = typeof settings?.ready === 'boolean' ? settings.ready : Boolean(config.baseUrl && config.model)
      if (!config.enabled || !ready || !config.dedupeEnabled) {
        throw new Error(t('ai.configurationNeeded'))
      }
      const result = await window.auditApi.ai.discoverAndQueue({ force: options.forceRecompute === true })
      if (result?.dedupeState?.channels) await applyWorkspaceState(result.dedupeState)
      else await reloadAllData()
      return result
    })
  }
  return runAction(() => window.auditApi.startDedupe(options))
}
const cancelActive = () => runAction(() => window.auditApi.cancelActive())
const confirmClearInspectionRecords = async () => {
  if (busy.value) return
  try {
    await ElMessageBox.confirm(
      t('audit.clearInspectionRecordsConfirm'),
      t('audit.clearInspectionRecordsConfirmTitle'),
      {
        type: 'warning',
        confirmButtonText: t('audit.clearInspectionRecords'),
        cancelButtonText: t('c.cancel'),
        confirmButtonClass: 'el-button--danger'
      }
    )
  } catch {
    return
  }

  Object.values(reviewSaveTimers).forEach(timer => window.clearTimeout(timer))
  reviewSaveTimers.anomaly = null
  reviewSaveTimers.dedupe = null
  await Promise.all(Object.values(reviewSaveQueues).map(queue => queue.catch(() => {})))
  await runAction(async () => {
    const state = await window.auditApi.clearInspectionRecords()
    workspace.value = normalizeWorkspace(state)
    anomalyReport.value = null
    dedupeReport.value = null
    anomalyReview.value = defaultReview('anomaly', null)
    dedupeReview.value = defaultReview('dedupe', null)
    logs.value = []
    aiLogs.value = []
    reviewDirty.anomaly = false
    reviewDirty.dedupe = false
    executionDialogVisible.value = false
    executionPreview.value = null
    ElMessage.success(t('audit.clearInspectionRecordsSuccess'))
    return state
  })
}
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
const updateAnomalyManualActions = manualActions => {
  reviewRevision.anomaly += 1
  anomalyReview.value = { ...anomalyReview.value, manualActions }
  scheduleReviewSave('anomaly')
}
const updateDedupeSelections = selections => {
  reviewRevision.dedupe += 1
  dedupeReview.value = { ...dedupeReview.value, selections }
  scheduleReviewSave('dedupe')
}
const commitDedupeDecisions = async changes => {
  const previous = dedupeReview.value
  const previousDirty = reviewDirty.dedupe
  const decisions = { ...(dedupeReview.value.decisions || {}) }
  const selections = { ...(dedupeReview.value.selections || {}) }
  for (const [id, decision] of Object.entries(changes)) {
    delete selections[id]
    if (decision) decisions[id] = decision
    else delete decisions[id]
  }
  reviewRevision.dedupe += 1
  dedupeReview.value = { ...dedupeReview.value, selections, decisions }
  reviewDirty.dedupe = true
  try { return await persistReview('dedupe') }
  catch (error) {
    if (dedupeReview.value.decisions === decisions) {
      reviewRevision.dedupe += 1
      dedupeReview.value = previous
      reviewDirty.dedupe = previousDirty
    }
    throw error
  }
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
  if (aiRunning.value) return
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
  if (aiRunning.value) return
  const preview = executionPreview.value
  if (!preview || executionSubmitting.value) return
  executionSubmitting.value = true
  executionDialogVisible.value = false
  try {
    await runAction(async () => {
      const result = await window.auditApi.executeApproved({ taskType: preview.taskType, reportId: preview.reportId })
      const repairedCount = Number(result?.repairedCount || 0)
      const skippedCount = Number(result?.skippedCount || 0)
      if (preview.taskType === 'anomaly' && skippedCount > 0) {
        const message = repairedCount > 0
          ? t('audit.executionPartial', { repaired: repairedCount, skipped: skippedCount })
          : t('audit.executionSkipped', { skipped: skippedCount })
        ElMessage.warning(message)
      } else {
        ElMessage.success(t('audit.executionComplete', { count: Number(result?.movedCount || 0) + repairedCount }))
      }
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
    if (value) {
      updateQuarantineRoot(value)
      if (executionDialogVisible.value && executionPreview.value?.taskType === 'dedupe') {
        await persistReview('dedupe')
        executionPreview.value = await window.auditApi.getExecutionPreview({ taskType: 'dedupe', reportId: dedupeReport.value.reportId })
      }
    }
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
  if (aiAvailable) {
    removeAiStateListener = window.auditApi.ai.onState(value => { aiState.value = value })
    try { aiState.value = await window.auditApi.ai.getState() } catch (error) { showError(error) }
  }
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
  removeAiStateListener?.()
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
  min-height: 50px;
  padding: 10px 18px;
  border-bottom: 1px solid var(--el-border-color);
}
.audit-heading { min-width: 0; }
.audit-heading h1 { margin: 0 0 5px; font-size: 24px; line-height: 1.25; letter-spacing: 0; }
.audit-heading span { display: block; overflow: hidden; color: var(--el-text-color-secondary); text-overflow: ellipsis; white-space: nowrap; }
.audit-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; }
.task-band { flex: 0 0 auto; padding: 10px 18px 12px; border-bottom: 1px solid var(--el-border-color); background: var(--el-fill-color-light); }
.task-line { display: flex; justify-content: space-between; gap: 18px; margin-bottom: 7px; }
.task-current-item { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: baseline; gap: 9px; margin: 0 0 7px; color: var(--el-text-color-secondary); font-size: 12px; }
.task-current-item strong { overflow: hidden; color: var(--el-text-color-primary); font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.task-estimate-line { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px 26px; margin-top: 7px; color: var(--el-text-color-secondary); font-size: 12px; }
.task-estimate-line strong { color: var(--el-text-color-regular); font-variant-numeric: tabular-nums; }
.task-band :deep(.el-alert) { margin-top: 8px; }
.audit-tabs { flex: 1 1 auto; min-height: 0; padding: 0 18px; }
.ai-task-band { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 8px 18px; background: var(--el-fill-color-light); font-size: 13px; }
.audit-tabs :deep(.el-tabs__content) { height: calc(100% - 56px); min-height: 0; overflow: hidden; }
.audit-tabs :deep(.el-tab-pane) { height: 100%; min-height: 0; }
@media (max-width: 900px) {
  .audit-toolbar { align-items: flex-start; }
  .audit-heading h1 { font-size: 21px; }
}
@media (max-width: 850px) { .audit-toolbar { min-height: 50px; padding-top: 8px; padding-bottom: 8px; }.audit-tabs :deep(.el-tabs__content) { height: calc(100% - 61px); } }
</style>

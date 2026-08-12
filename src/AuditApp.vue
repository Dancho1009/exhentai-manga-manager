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
            @start="startAnomaly"
            @verify-conflicts="verifyConflicts"
            @update:action-ids="updateAnomalyActions"
          />
        </el-tab-pane>
        <el-tab-pane :label="$t('audit.dedupTab')" name="dedupe">
          <dedupe-panel
            :report="dedupeReport"
            :state="dedupeState"
            :busy="busy"
            :review-locked="reviewLocked"
            :selections="dedupeReview.selections"
            @start="startDedupe"
            @update:selections="updateDedupeSelections"
          />
        </el-tab-pane>
        <el-tab-pane :label="$t('audit.approvalTab')" name="approval">
          <approval-panel
            v-model:quarantine-root="quarantineRoot"
            :anomaly-report="anomalyReport"
            :anomaly-review="anomalyReview"
            :dedupe-report="dedupeReport"
            :dedupe-review="dedupeReview"
            :busy="busy"
            @save="saveReviews"
            @execute="executeApproved"
            @select-quarantine="selectQuarantine"
          />
        </el-tab-pane>
      </el-tabs>

      <audit-log-panel :logs="logs" />
    </main>
  </el-config-provider>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh, VideoPause } from '@element-plus/icons-vue'
import zhCnElement from 'element-plus/dist/locale/zh-cn.mjs'
import zhTwElement from 'element-plus/dist/locale/zh-tw.mjs'
import enElement from 'element-plus/dist/locale/en.mjs'
import AnomalyPanel from './audit/AnomalyPanel.vue'
import DedupePanel from './audit/DedupePanel.vue'
import ApprovalPanel from './audit/ApprovalPanel.vue'
import AuditLogPanel from './audit/AuditLogPanel.vue'

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
  latestReportId: null,
  error: null
})

const emptyWorkspace = () => ({
  schemaVersion: 3,
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
const quarantineRoot = ref(`${String(initialSetting.library || '').replace(/[\\/][^\\/]+[\\/]?$/, '')}\\DedupeReview`)
const reportLoadTokens = { anomaly: 0, dedupe: 0 }
let removeStateListener
let removeLogListener

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
const activeTaskLabel = computed(() => taskLabel(activeTask.value?.type))
const activeStatusLabel = computed(() => {
  const key = `audit.status_${activeState.value.status}`
  return te(key) ? t(key) : activeState.value.status
})
const activePhaseLabel = computed(() => {
  const key = `audit.phase_${activeState.value.phase}`
  return te(key) ? t(key) : activeState.value.phase
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
  : { reportId: report?.reportId || null, selections: {} }

const loadTaskData = async taskType => {
  const token = ++reportLoadTokens[taskType]
  dataLoadCount.value += 1
  try {
    const [report, review] = await Promise.all([
      window.auditApi.getReport(taskType),
      window.auditApi.getReview(taskType)
    ])
    if (token !== reportLoadTokens[taskType]) return
    const normalizedReview = review?.reportId === report?.reportId ? review : defaultReview(taskType, report)
    if (taskType === 'anomaly') {
      anomalyReport.value = report
      anomalyReview.value = normalizedReview
    } else {
      dedupeReport.value = report
      dedupeReview.value = normalizedReview
    }
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
const updateAnomalyActions = actionIds => { anomalyReview.value = { ...anomalyReview.value, actionIds } }
const updateDedupeSelections = selections => { dedupeReview.value = { ...dedupeReview.value, selections } }

const persistReviews = async ({ notify = true } = {}) => {
  const tasks = []
  if (anomalyReport.value) tasks.push(window.auditApi.saveReview('anomaly', anomalyReview.value).then(value => { anomalyReview.value = value }))
  if (dedupeReport.value) tasks.push(window.auditApi.saveReview('dedupe', dedupeReview.value).then(value => { dedupeReview.value = value }))
  if (!tasks.length) throw new Error(t('audit.noVerifiedActions'))
  await Promise.all(tasks)
  if (notify) ElMessage.success(t('audit.reviewSaved'))
}

const saveReviews = () => runAction(async () => {
  await persistReviews()
  return workspace.value
})

const executeApproved = async () => {
  if (busy.value) return
  try {
    await persistReviews({ notify: false })
    await ElMessageBox.confirm(t('audit.confirmExecute'), t('audit.executeApproved'), {
      type: 'warning',
      confirmButtonText: t('audit.executeApproved')
    })
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    showError(error)
    return
  }
  await runAction(async () => {
    const result = await window.auditApi.executeApproved({ quarantineRoot: quarantineRoot.value })
    ElMessage.success(t('audit.executionComplete', { count: Number(result?.movedCount || 0) + Number(result?.repairedCount || 0) }))
    await reloadAllData()
    return result?.state || workspace.value
  })
}

const selectQuarantine = async () => {
  try {
    const value = await window.auditApi.selectQuarantine(quarantineRoot.value)
    if (value) quarantineRoot.value = value
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
  removeStateListener = window.auditApi.onState(applyWorkspaceState)
  removeLogListener = window.auditApi.onLog(appendLog)
  try {
    await reloadAllData()
  } catch (error) {
    showError(error)
  }
})

onBeforeUnmount(() => {
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
.task-band :deep(.el-alert) { margin-top: 8px; }
.audit-tabs { flex: 1 1 auto; min-height: 0; padding: 0 18px; }
.audit-tabs :deep(.el-tabs__content) { height: calc(100% - 56px); min-height: 0; overflow: hidden; }
.audit-tabs :deep(.el-tab-pane) { height: 100%; min-height: 0; }
@media (max-width: 900px) {
  .audit-toolbar { align-items: flex-start; }
  .audit-heading h1 { font-size: 21px; }
}
</style>

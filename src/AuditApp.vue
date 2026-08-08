<template>
  <el-config-provider :locale="elementLocale">
    <main class="audit-shell">
      <header class="audit-toolbar">
        <div class="audit-heading">
          <h1>{{ $t('audit.title') }}</h1>
          <span :title="initialSetting.library">{{ initialSetting.library }}</span>
        </div>
        <div class="audit-actions">
          <el-segmented v-model="scanMode" :options="modeOptions" :disabled="running" />
          <el-select v-if="scanMode === 'deep'" v-model="deepScope" class="scope-select" :disabled="running">
            <el-option :label="$t('audit.scopeAnomalies')" value="anomalies" />
            <el-option :label="$t('audit.scopeChanged')" value="changed" />
            <el-option :label="$t('audit.scopeAll')" value="all" />
          </el-select>
          <el-tooltip :content="$t('audit.start')">
            <el-button type="primary" :icon="VideoPlay" :disabled="running" @click="startAudit" />
          </el-tooltip>
          <el-tooltip :content="$t('audit.stop')">
            <el-button :icon="VideoPause" :disabled="!running" @click="cancelAudit" />
          </el-tooltip>
          <el-tooltip :content="$t('audit.reload')">
            <el-button :icon="Refresh" :disabled="running" @click="reloadReport" />
          </el-tooltip>
        </div>
      </header>

      <section v-if="state.status !== 'idle'" class="task-band">
        <div class="task-line">
          <span>{{ statusLabel }}</span>
          <span>{{ phaseLabel }} · {{ state.completed || 0 }}/{{ state.total || 0 }}</span>
        </div>
        <el-progress :percentage="progressPercentage" :stroke-width="12" :status="state.status === 'failed' ? 'exception' : state.status === 'completed' ? 'success' : undefined" />
        <el-alert v-if="state.error" type="error" :closable="false" :title="state.error" show-icon />
      </section>

      <section v-if="report" class="summary-band">
        <div><strong>{{ report.summary.libraryItems }}</strong><span>{{ $t('audit.libraryItems') }}</span></div>
        <div><strong>{{ report.summary.mangaRows }}</strong><span>{{ $t('audit.databaseRows') }}</span></div>
        <div><strong>{{ report.summary.anomalies }}</strong><span>{{ $t('audit.anomalies') }}</span></div>
        <div><strong>{{ report.summary.duplicateGroups }}</strong><span>{{ $t('audit.duplicateGroups') }}</span></div>
        <div><strong>{{ formatBytes(report.summary.potentialBytes) }}</strong><span>{{ $t('audit.potentialSpace') }}</span></div>
      </section>

      <el-tabs v-model="activeTab" class="audit-tabs">
        <el-tab-pane :label="$t('audit.anomalyTab')" name="anomalies">
          <div class="filter-row">
            <el-input v-model="anomalySearch" :prefix-icon="Search" clearable :placeholder="$t('audit.filterPlaceholder')" />
            <el-select v-model="severityFilter" clearable :placeholder="$t('audit.severity')">
              <el-option v-for="severity in severities" :key="severity" :label="$t(`audit.${severity}`)" :value="severity" />
            </el-select>
            <el-select v-model="anomalyTypeFilter" clearable filterable :placeholder="$t('audit.type')">
              <el-option v-for="type in anomalyTypes" :key="type" :label="type" :value="type" />
            </el-select>
          </div>
          <el-table :data="filteredAnomalies" height="calc(100vh - 335px)" row-key="id" @row-click="openAnomaly">
            <el-table-column width="48" align="center">
              <template #default="scope">
                <el-checkbox
                  v-if="scope.row.action"
                  :model-value="review.anomalyActionIds.includes(scope.row.id)"
                  @click.stop
                  @change="value => toggleAnomaly(scope.row.id, value)"
                />
              </template>
            </el-table-column>
            <el-table-column :label="$t('audit.severity')" width="94">
              <template #default="scope"><el-tag :type="severityTag(scope.row.severity)" effect="plain">{{ $t(`audit.${scope.row.severity}`) }}</el-tag></template>
            </el-table-column>
            <el-table-column prop="type" :label="$t('audit.type')" min-width="190" show-overflow-tooltip />
            <el-table-column prop="reason" :label="$t('audit.reason')" min-width="280" show-overflow-tooltip />
            <el-table-column prop="filepath" :label="$t('audit.filepath')" min-width="420" show-overflow-tooltip />
            <el-table-column width="54" align="center">
              <template #default="scope">
                <el-tooltip :content="$t('audit.locate')"><el-button link :icon="FolderOpened" @click.stop="locate(scope.row.filepath)" /></el-tooltip>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane :label="$t('audit.dedupTab')" name="duplicates">
          <div class="filter-row">
            <el-input v-model="duplicateSearch" :prefix-icon="Search" clearable :placeholder="$t('audit.filterPlaceholder')" />
            <el-select v-model="duplicateKindFilter" clearable :placeholder="$t('audit.type')">
              <el-option v-for="kind in duplicateKinds" :key="kind" :label="kind" :value="kind" />
            </el-select>
          </div>
          <el-table :data="filteredDuplicates" height="calc(100vh - 335px)" row-key="id" @row-click="openDuplicate">
            <el-table-column width="48" align="center">
              <template #default="scope"><el-icon v-if="review.duplicateSelections[scope.row.id]"><Select /></el-icon></template>
            </el-table-column>
            <el-table-column prop="kind" :label="$t('audit.type')" width="150" />
            <el-table-column :label="$t('audit.eligibility')" width="130">
              <template #default="scope">
                <el-tag :type="scope.row.eligible ? 'success' : 'warning'" effect="plain">{{ scope.row.eligible ? $t('audit.approvable') : $t('audit.manualReview') }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column :label="$t('audit.itemCount')" width="100"><template #default="scope">{{ scope.row.items.length }}</template></el-table-column>
            <el-table-column :label="$t('audit.potentialSpace')" width="130"><template #default="scope">{{ formatBytes(scope.row.potentialBytes) }}</template></el-table-column>
            <el-table-column :label="$t('audit.filepath')" min-width="480" show-overflow-tooltip>
              <template #default="scope">{{ scope.row.items.map(item => item.filepath).join(' | ') }}</template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <el-tab-pane :label="$t('audit.approvalTab')" name="approval">
          <section class="approval-pane">
            <div class="approval-line">
              <span>{{ $t('audit.approvedRepairs') }}</span>
              <strong>{{ review.anomalyActionIds.length }}</strong>
            </div>
            <div class="approval-line">
              <span>{{ $t('audit.approvedDuplicateGroups') }}</span>
              <strong>{{ Object.keys(review.duplicateSelections).length }}</strong>
            </div>
            <div class="path-line">
              <el-input v-model="quarantineRoot" :disabled="running">
                <template #prepend>{{ $t('audit.quarantinePath') }}</template>
              </el-input>
              <el-tooltip :content="$t('audit.chooseFolder')"><el-button :icon="FolderOpened" @click="selectQuarantine" /></el-tooltip>
            </div>
            <el-alert type="warning" :closable="false" show-icon :title="$t('audit.executionWarning')" />
            <div class="approval-actions">
              <el-button :icon="DocumentChecked" @click="saveReview">{{ $t('audit.saveReview') }}</el-button>
              <el-button type="danger" :icon="Select" :disabled="running || approvedCount === 0" @click="executeApproved">{{ $t('audit.executeApproved') }}</el-button>
            </div>
          </section>
        </el-tab-pane>
      </el-tabs>

      <el-collapse class="log-pane">
        <el-collapse-item :title="$t('audit.taskLog')" name="logs">
          <pre>{{ logs.map(item => `[${item.at}] ${item.message}`).join('\n') }}</pre>
        </el-collapse-item>
      </el-collapse>

      <el-drawer v-model="anomalyDrawer" :title="selectedAnomaly?.type" size="46%">
        <template v-if="selectedAnomaly">
          <el-descriptions :column="1" border>
            <el-descriptions-item :label="$t('audit.severity')">{{ $t(`audit.${selectedAnomaly.severity}`) }}</el-descriptions-item>
            <el-descriptions-item :label="$t('audit.reason')">{{ selectedAnomaly.reason }}</el-descriptions-item>
            <el-descriptions-item :label="$t('audit.filepath')">{{ selectedAnomaly.filepath || '-' }}</el-descriptions-item>
            <el-descriptions-item :label="$t('audit.recommendation')">{{ selectedAnomaly.recommendedAction }}</el-descriptions-item>
            <el-descriptions-item v-if="currentEvidenceUrl" :label="$t('audit.currentUrl')">
              <el-link type="primary" :underline="false" @click="openExternalUrl(currentEvidenceUrl)">
                <span>{{ currentEvidenceUrl }}</span><el-icon><TopRight /></el-icon>
              </el-link>
            </el-descriptions-item>
            <el-descriptions-item v-if="ehviewerEvidenceUrl" :label="$t('audit.ehviewerUrl')">
              <el-link type="primary" :underline="false" @click="openExternalUrl(ehviewerEvidenceUrl)">
                <span>{{ ehviewerEvidenceUrl }}</span><el-icon><TopRight /></el-icon>
              </el-link>
            </el-descriptions-item>
          </el-descriptions>
          <pre class="evidence-block">{{ stringify(selectedAnomaly.evidence) }}</pre>
        </template>
      </el-drawer>

      <el-drawer v-model="duplicateDrawer" :title="selectedDuplicate?.kind" size="52%">
        <template v-if="selectedDuplicate">
          <el-alert v-if="!selectedDuplicate.eligible" type="warning" :closable="false" show-icon :title="selectedDuplicate.reviewReason" />
          <div class="duplicate-editor-actions">
            <el-button v-if="selectedDuplicate.eligible" @click="useSuggestion(selectedDuplicate)">{{ $t('audit.useSuggestion') }}</el-button>
            <el-button @click="clearDuplicateSelection(selectedDuplicate.id)">{{ $t('audit.clearApproval') }}</el-button>
          </div>
          <el-table :data="selectedDuplicate.items" row-key="id" height="390">
            <el-table-column :label="$t('audit.keep')" width="64" align="center">
              <template #default="scope"><el-radio v-model="duplicateDraft.keepId" :value="scope.row.id" /></template>
            </el-table-column>
            <el-table-column :label="$t('audit.quarantine')" width="88" align="center">
              <template #default="scope"><el-checkbox v-model="duplicateDraft.quarantineIds" :value="scope.row.id" :disabled="duplicateDraft.keepId === scope.row.id" /></template>
            </el-table-column>
            <el-table-column prop="title" :label="$t('audit.titleColumn')" min-width="180" show-overflow-tooltip />
            <el-table-column prop="filepath" :label="$t('audit.filepath')" min-width="340" show-overflow-tooltip />
            <el-table-column prop="url" label="URL" min-width="210" show-overflow-tooltip />
          </el-table>
          <pre class="evidence-block">{{ stringify(selectedDuplicate.evidence) }}</pre>
          <div class="drawer-footer"><el-button type="primary" @click="applyDuplicateDraft">{{ $t('audit.approveSelection') }}</el-button></div>
        </template>
      </el-drawer>
    </main>
  </el-config-provider>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { DocumentChecked, FolderOpened, Refresh, Search, Select, TopRight, VideoPause, VideoPlay } from '@element-plus/icons-vue'
import zhCnElement from 'element-plus/dist/locale/zh-cn.mjs'
import zhTwElement from 'element-plus/dist/locale/zh-tw.mjs'
import enElement from 'element-plus/dist/locale/en.mjs'

const props = defineProps({ initialSetting: { type: Object, required: true } })
const { t, te, locale } = useI18n()
const initialSetting = props.initialSetting
const state = reactive({ jobId: null, status: 'idle', phase: 'idle', completed: 0, total: 0, error: null })
const report = ref(null)
const review = reactive({ anomalyActionIds: [], duplicateSelections: {} })
const logs = ref([])
const activeTab = ref('anomalies')
const scanMode = ref('quick')
const deepScope = ref('anomalies')
const anomalySearch = ref('')
const severityFilter = ref('')
const anomalyTypeFilter = ref('')
const duplicateSearch = ref('')
const duplicateKindFilter = ref('')
const anomalyDrawer = ref(false)
const duplicateDrawer = ref(false)
const selectedAnomaly = ref(null)
const selectedDuplicate = ref(null)
const duplicateDraft = reactive({ keepId: null, quarantineIds: [] })
const quarantineRoot = ref(`${String(initialSetting.library).replace(/[\\/][^\\/]+[\\/]?$/, '')}\\DedupeReview`)
const severities = ['critical', 'high', 'medium', 'low']
const modeOptions = computed(() => [
  { label: t('audit.quickScan'), value: 'quick' },
  { label: t('audit.deepScan'), value: 'deep' }
])
const elementLocale = computed(() => locale.value === 'zh-TW' ? zhTwElement : locale.value === 'en-US' ? enElement : zhCnElement)
const running = computed(() => ['running', 'cancelling'].includes(state.status))
const progressPercentage = computed(() => state.total ? Math.min(100, Math.round(state.completed / state.total * 100)) : running.value ? 1 : state.status === 'completed' ? 100 : 0)
const statusLabel = computed(() => t(`audit.status_${state.status}`))
const phaseLabel = computed(() => {
  const key = `audit.phase_${state.phase}`
  return te(key) ? t(key) : state.phase || '-'
})
const currentEvidenceUrl = computed(() => selectedAnomaly.value?.evidence?.currentUrl || '')
const ehviewerEvidenceUrl = computed(() => {
  const ehviewer = selectedAnomaly.value?.evidence?.ehviewer
  return ehviewer?.gid && ehviewer?.token
    ? `https://exhentai.org/g/${ehviewer.gid}/${ehviewer.token}/`
    : ''
})
const anomalyTypes = computed(() => [...new Set((report.value?.anomalies || []).map(item => item.type))].sort())
const duplicateKinds = computed(() => [...new Set((report.value?.duplicates || []).map(item => item.kind))].sort())
const filteredAnomalies = computed(() => (report.value?.anomalies || []).filter(item => {
  const search = anomalySearch.value.toLowerCase()
  return (!severityFilter.value || item.severity === severityFilter.value) &&
    (!anomalyTypeFilter.value || item.type === anomalyTypeFilter.value) &&
    (!search || `${item.type} ${item.reason} ${item.filepath || ''}`.toLowerCase().includes(search))
}))
const filteredDuplicates = computed(() => (report.value?.duplicates || []).filter(item => {
  const search = duplicateSearch.value.toLowerCase()
  return (!duplicateKindFilter.value || item.kind === duplicateKindFilter.value) &&
    (!search || `${item.kind} ${item.items.map(book => `${book.title} ${book.filepath}`).join(' ')}`.toLowerCase().includes(search))
}))
const approvedCount = computed(() => review.anomalyActionIds.length + Object.keys(review.duplicateSelections).length)

let removeStateListener
let removeLogListener
let lastReportPath = null

const assignState = value => Object.assign(state, value || {})
const reloadReport = async () => {
  const [nextState, nextReport, nextReview] = await Promise.all([
    window.auditApi.getState(),
    window.auditApi.getReport(),
    window.auditApi.getReview()
  ])
  assignState(nextState)
  report.value = nextReport
  if (nextReview) {
    review.anomalyActionIds = nextReview.anomalyActionIds || []
    review.duplicateSelections = nextReview.duplicateSelections || {}
  }
  lastReportPath = nextState?.reportPath || null
}
const startAudit = async () => {
  try {
    assignState(await window.auditApi.start({ mode: scanMode.value, deepScope: deepScope.value }))
    report.value = null
    review.anomalyActionIds = []
    review.duplicateSelections = {}
  } catch (error) {
    ElMessage.error(error.message || String(error))
  }
}
const cancelAudit = () => window.auditApi.cancel()
const toggleAnomaly = (id, value) => {
  review.anomalyActionIds = value ? [...new Set([...review.anomalyActionIds, id])] : review.anomalyActionIds.filter(item => item !== id)
}
const openAnomaly = row => { selectedAnomaly.value = row; anomalyDrawer.value = true }
const openDuplicate = row => {
  selectedDuplicate.value = row
  const saved = review.duplicateSelections[row.id]
  duplicateDraft.keepId = saved?.keepId || row.suggestedKeepId
  duplicateDraft.quarantineIds = [...(saved?.quarantineIds || [])]
  duplicateDrawer.value = true
}
const useSuggestion = group => {
  duplicateDraft.keepId = group.suggestedKeepId
  duplicateDraft.quarantineIds = group.items.filter(item => item.id !== group.suggestedKeepId).map(item => item.id)
}
const clearDuplicateSelection = id => { delete review.duplicateSelections[id]; duplicateDraft.quarantineIds = [] }
const applyDuplicateDraft = () => {
  if (!duplicateDraft.keepId || duplicateDraft.quarantineIds.length === 0) return ElMessage.warning(t('audit.invalidSelection'))
  review.duplicateSelections[selectedDuplicate.value.id] = {
    keepId: duplicateDraft.keepId,
    quarantineIds: duplicateDraft.quarantineIds.filter(id => id !== duplicateDraft.keepId)
  }
  duplicateDrawer.value = false
}
const saveReview = async () => {
  await window.auditApi.saveReview(JSON.parse(JSON.stringify(review)))
  ElMessage.success(t('audit.reviewSaved'))
}
const executeApproved = async () => {
  await saveReview()
  await ElMessageBox.confirm(t('audit.confirmExecute'), t('audit.executeApproved'), { type: 'warning', confirmButtonText: t('audit.executeApproved') })
  try {
    const result = await window.auditApi.executeApproved({ quarantineRoot: quarantineRoot.value })
    ElMessage.success(t('audit.executionComplete', { count: result.movedCount + result.repairedCount }))
    await reloadReport()
  } catch (error) {
    ElMessage.error(error.message || String(error))
  }
}
const selectQuarantine = async () => {
  const value = await window.auditApi.selectQuarantine(quarantineRoot.value)
  if (value) quarantineRoot.value = value
}
const locate = filepath => filepath && window.auditApi.showFile(filepath)
const openExternalUrl = url => url && window.auditApi.openUrl(url)
const stringify = value => JSON.stringify(value || {}, null, 2)
const severityTag = severity => ({ critical: 'danger', high: 'danger', medium: 'warning', low: 'info' })[severity] || 'info'
const formatBytes = value => {
  let size = Number(value || 0)
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let index = 0
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1 }
  return `${size.toFixed(index === 0 ? 0 : 2)} ${units[index]}`
}

onMounted(async () => {
  await reloadReport()
  removeStateListener = window.auditApi.onState(async value => {
    assignState(value)
    if (value.reportPath && value.reportPath !== lastReportPath && value.status === 'completed') await reloadReport()
  })
  removeLogListener = window.auditApi.onLog(entry => { logs.value = [...logs.value.slice(-199), entry] })
})
onBeforeUnmount(() => { removeStateListener?.(); removeLogListener?.() })
</script>

<style scoped>
.audit-shell { min-height: 100vh; color: var(--el-text-color-primary); background: var(--el-bg-color); }
.audit-toolbar { min-height: 72px; padding: 10px 18px; border-bottom: 1px solid var(--el-border-color); display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.audit-heading { min-width: 0; }
.audit-heading h1 { margin: 0 0 4px; font-size: 20px; letter-spacing: 0; }
.audit-heading span { display: block; max-width: 680px; color: var(--el-text-color-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.audit-actions { display: flex; align-items: center; gap: 8px; }
.scope-select { width: 160px; }
.task-band { padding: 10px 18px; border-bottom: 1px solid var(--el-border-color); }
.task-line { display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 13px; }
.task-band .el-alert { margin-top: 8px; }
.summary-band { display: grid; grid-template-columns: repeat(5, minmax(120px, 1fr)); border-bottom: 1px solid var(--el-border-color); }
.summary-band div { padding: 10px 18px; border-right: 1px solid var(--el-border-color); }
.summary-band strong, .summary-band span { display: block; }
.summary-band strong { font-size: 18px; }
.summary-band span { margin-top: 3px; color: var(--el-text-color-secondary); font-size: 12px; }
.audit-tabs { padding: 0 18px; }
.filter-row { display: grid; grid-template-columns: minmax(280px, 1fr) 180px 240px; gap: 10px; margin-bottom: 10px; }
.approval-pane { max-width: 860px; padding: 14px 0; }
.approval-line { display: flex; justify-content: space-between; padding: 14px 4px; border-bottom: 1px solid var(--el-border-color-lighter); }
.path-line { display: grid; grid-template-columns: 1fr 40px; gap: 8px; margin: 20px 0; }
.approval-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
.log-pane { position: fixed; left: 18px; right: 18px; bottom: 0; background: var(--el-bg-color); }
.log-pane pre, .evidence-block { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.5; }
.log-pane pre { max-height: 160px; overflow: auto; margin: 0; }
.evidence-block { margin-top: 16px; padding: 12px; background: var(--el-fill-color-light); border: 1px solid var(--el-border-color-lighter); }
.duplicate-editor-actions { display: flex; gap: 8px; margin: 12px 0; }
.drawer-footer { display: flex; justify-content: flex-end; margin-top: 14px; }
@media (max-width: 900px) {
  .audit-toolbar { align-items: flex-start; flex-direction: column; }
  .audit-actions { width: 100%; flex-wrap: wrap; }
  .summary-band { grid-template-columns: repeat(2, 1fr); }
  .filter-row { grid-template-columns: 1fr; }
}
</style>

<style>
html, body, #audit-app { margin: 0; min-width: 720px; min-height: 100%; background: var(--el-bg-color); }
html.light { color-scheme: light; }
html.exhentai { background: #34353b; --el-bg-color: #34353b; --el-bg-color-overlay: #34353b; --el-color-primary: #909399; --el-fill-color-light: #3d414b; --el-border-color: #6e6e6e; }
html.e-hentai { background: #e2e0d2; --el-bg-color: #e2e0d2; --el-bg-color-overlay: #e2e0d2; --el-color-primary: #521613; --el-fill-color-light: #edebe0; --el-border-color: #919191; }
html.nhentai { background: #0d0d0d; --el-bg-color: #0d0d0d; --el-bg-color-overlay: #0d0d0d; --el-color-primary: #d54255; --el-fill-color-light: #1f1f1f; --el-border-color: #6e6e6e; }
</style>

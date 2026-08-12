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
          <el-select v-if="scanMode === 'online'" v-model="onlineScope" class="scope-select" :disabled="running">
            <el-option :label="$t('audit.onlineScopeConflicts')" value="conflicts" />
            <el-option :label="$t('audit.onlineScopeUrls')" value="urls" />
            <el-option :label="$t('audit.onlineScopeEhviewer')" value="ehviewer" />
          </el-select>
          <el-checkbox v-if="scanMode === 'online'" v-model="forceOnline" :disabled="running">{{ $t('audit.forceRefresh') }}</el-checkbox>
          <el-tooltip v-if="pendingOnlineBookIds.length" :content="$t('audit.verifyPendingConflictsInfo')">
            <el-button
              type="warning"
              plain
              :icon="Connection"
              :disabled="running"
              @click="verifyPendingConflicts"
            >
              {{ $t('audit.verifyPendingConflicts', { count: pendingOnlineBookIds.length }) }}
            </el-button>
          </el-tooltip>
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
        <el-alert v-if="running && report" type="info" :closable="false" :title="$t('audit.previousReportWhileRunning')" show-icon />
        <el-alert v-if="state.error" type="error" :closable="false" :title="state.error" show-icon />
      </section>

      <section v-if="report" class="summary-band">
        <div><strong>{{ report.summary.libraryItems }}</strong><span>{{ $t('audit.libraryItems') }}</span></div>
        <div><strong>{{ report.summary.mangaRows }}</strong><span>{{ $t('audit.databaseRows') }}</span></div>
        <div><strong>{{ report.summary.anomalies }}</strong><span>{{ $t('audit.anomalies') }}</span></div>
        <div><strong>{{ anomalyBookCount }}</strong><span>{{ $t('audit.anomalyBooks') }}</span></div>
        <template v-if="report.mode === 'online'">
          <div><strong>{{ report.summary.onlineIdentities || 0 }}</strong><span>{{ $t('audit.onlineIdentities') }}</span></div>
          <div><strong>{{ report.summary.onlineAvailable || 0 }}</strong><span>{{ $t('audit.onlineAvailable') }}</span></div>
          <div><strong>{{ report.summary.onlineCopyright || 0 }}</strong><span>{{ $t('audit.onlineCopyright') }}</span></div>
        </template>
        <template v-else>
          <div><strong>{{ report.summary.duplicateGroups }}</strong><span>{{ $t('audit.duplicateGroups') }}</span></div>
          <div><strong>{{ formatBytes(report.summary.potentialBytes) }}</strong><span>{{ $t('audit.potentialSpace') }}</span></div>
        </template>
      </section>

      <el-tabs v-model="activeTab" class="audit-tabs">
        <el-tab-pane :label="$t('audit.anomalyTab')" name="anomalies" class="audit-list-pane">
          <div class="filter-row">
            <el-input v-model="anomalySearchInput" :prefix-icon="Search" clearable :placeholder="$t('audit.filterPlaceholder')" />
            <el-select v-model="severityFilter" clearable :placeholder="$t('audit.severity')">
              <el-option v-for="severity in severities" :key="severity" :label="$t(`audit.${severity}`)" :value="severity" />
            </el-select>
            <el-select v-model="anomalyTypeFilter" clearable filterable :placeholder="$t('audit.type')">
              <el-option v-for="type in anomalyTypes" :key="type" :label="auditTypeLabel(type)" :value="type" />
            </el-select>
          </div>
          <div class="filter-meta-row">
            <el-checkbox v-model="actionableOnly">{{ $t('audit.actionableOnly') }}</el-checkbox>
            <div class="filter-counts" aria-live="polite">
              <span>{{ $t('audit.filteredScopeCount', { scope: anomalyFilterScopeLabel, count: filteredAnomalies.length }) }}</span>
              <strong v-if="selectedFilteredAnomalyCount > 0">{{ $t('audit.selectedFilteredCount', { count: selectedFilteredAnomalyCount }) }}</strong>
            </div>
          </div>
          <div class="audit-table-region">
            <el-table :data="pagedAnomalies" height="100%" row-key="id" @row-click="openAnomaly">
              <el-table-column width="48" align="center">
                <template #header>
                  <el-tooltip :content="$t('audit.selectAllFiltered')">
                    <el-checkbox
                      :model-value="allFilteredAnomaliesSelected"
                      :indeterminate="someFilteredAnomaliesSelected"
                      :disabled="running || filteredActionableAnomalyIds.length === 0"
                      @change="toggleAllFilteredAnomalies"
                    />
                  </el-tooltip>
                </template>
                <template #default="scope">
                  <el-tooltip :content="running ? $t('audit.previousReportReadOnly') : $t('audit.noApprovableAction')" :disabled="!running && Boolean(scope.row.action)">
                    <span class="anomaly-checkbox">
                      <el-checkbox
                        :model-value="isAnomalySelected(scope.row.id)"
                        :disabled="running || !scope.row.action"
                        @click.stop
                        @change="value => toggleAnomaly(scope.row.id, value)"
                      />
                    </span>
                  </el-tooltip>
                </template>
              </el-table-column>
              <el-table-column :label="$t('audit.severity')" width="94">
                <template #default="scope"><el-tag :type="severityTag(scope.row.severity)" effect="plain">{{ $t(`audit.${scope.row.severity}`) }}</el-tag></template>
              </el-table-column>
              <el-table-column :label="$t('audit.type')" min-width="190" show-overflow-tooltip>
                <template #default="scope">{{ auditTypeLabel(scope.row.type) }}</template>
              </el-table-column>
              <el-table-column prop="reason" :label="$t('audit.reason')" min-width="280" show-overflow-tooltip />
              <el-table-column prop="filepath" :label="$t('audit.filepath')" min-width="420" show-overflow-tooltip />
              <el-table-column width="54" align="center">
                <template #default="scope">
                  <el-tooltip :content="$t('audit.locate')"><el-button link :icon="FolderOpened" @click.stop="locate(scope.row.filepath)" /></el-tooltip>
                </template>
              </el-table-column>
            </el-table>
          </div>
          <el-pagination
            v-model:current-page="anomalyPage"
            v-model:page-size="anomalyPageSize"
            class="table-pagination"
            :page-sizes="pageSizes"
            :total="filteredAnomalies.length"
            layout="total, sizes, prev, pager, next, jumper"
          />
        </el-tab-pane>

        <el-tab-pane :label="$t('audit.dedupTab')" name="duplicates" class="audit-list-pane">
          <div class="filter-row">
            <el-input v-model="duplicateSearchInput" :prefix-icon="Search" clearable :placeholder="$t('audit.filterPlaceholder')" />
            <el-select v-model="duplicateKindFilter" clearable :placeholder="$t('audit.type')">
              <el-option v-for="kind in duplicateKinds" :key="kind" :label="auditTypeLabel(kind)" :value="kind" />
            </el-select>
          </div>
          <div class="audit-table-region">
            <el-table :data="pagedDuplicates" height="100%" row-key="id" @row-click="openDuplicate">
              <el-table-column width="48" align="center">
                <template #default="scope"><el-icon v-if="review.duplicateSelections[scope.row.id]"><Select /></el-icon></template>
              </el-table-column>
              <el-table-column :label="$t('audit.type')" width="150">
                <template #default="scope">{{ auditTypeLabel(scope.row.kind) }}</template>
              </el-table-column>
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
          </div>
          <el-pagination
            v-model:current-page="duplicatePage"
            v-model:page-size="duplicatePageSize"
            class="table-pagination"
            :page-sizes="pageSizes"
            :total="filteredDuplicates.length"
            layout="total, sizes, prev, pager, next, jumper"
          />
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
              <el-tooltip :content="$t('audit.chooseFolder')"><el-button :icon="FolderOpened" :disabled="running" @click="selectQuarantine" /></el-tooltip>
            </div>
            <el-alert type="warning" :closable="false" show-icon :title="$t('audit.executionWarning')" />
            <div class="approval-actions">
              <el-button :icon="DocumentChecked" :disabled="running" @click="saveReview">{{ $t('audit.saveReview') }}</el-button>
              <el-button type="danger" :icon="Select" :disabled="running || approvedCount === 0" @click="executeApproved">{{ $t('audit.executeApproved') }}</el-button>
            </div>
          </section>
        </el-tab-pane>
      </el-tabs>

      <el-collapse v-model="activeLogPanels" class="log-pane" @click.stop>
        <el-collapse-item name="logs">
          <template #title>
            <span class="log-title">
              <el-icon><Tickets /></el-icon>
              <span>{{ $t('audit.taskLog') }}</span>
              <el-tag size="small" type="info" effect="plain">{{ logs.length }}</el-tag>
            </span>
          </template>
          <pre v-if="activeLogPanels.includes('logs')">{{ logText }}</pre>
        </el-collapse-item>
      </el-collapse>

      <el-drawer v-model="anomalyDrawer" :title="auditTypeLabel(selectedAnomaly?.type)" size="46%">
        <template v-if="selectedAnomaly">
          <div class="anomaly-detail-grid" :class="{ 'has-book-preview': selectedAnomaly.bookId }">
            <aside v-if="selectedAnomaly.bookId" class="anomaly-book-preview">
              <el-tooltip :content="$t('audit.openBookDetailWindow')" placement="bottom">
                <button
                  type="button"
                  class="anomaly-cover-button"
                  :aria-label="$t('audit.openBookDetailWindow')"
                  :disabled="anomalyDetailOpening"
                  @click="openSelectedAnomalyBookDetail"
                >
                  <el-skeleton v-if="anomalyPreviewLoading" animated>
                    <template #template><el-skeleton-item variant="image" class="anomaly-cover" /></template>
                  </el-skeleton>
                  <el-image v-else-if="anomalyBookPreview?.coverPath" class="anomaly-cover" :src="anomalyBookPreview.coverPath" fit="cover">
                    <template #error>
                      <div class="anomaly-cover-placeholder"><el-icon><Picture /></el-icon><span>{{ $t('audit.coverUnavailable') }}</span></div>
                    </template>
                  </el-image>
                  <div v-else class="anomaly-cover anomaly-cover-placeholder"><el-icon><Picture /></el-icon><span>{{ $t('audit.coverUnavailable') }}</span></div>
                </button>
              </el-tooltip>
              <p v-if="anomalyBookTitle" :title="anomalyBookTitle">{{ anomalyBookTitle }}</p>
            </aside>
            <div class="anomaly-description">
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
            <el-descriptions-item v-if="currentAvailability" :label="$t('audit.currentAvailability')">
              <span v-for="site in availabilitySites" :key="`current-${site}`" class="availability-item">
                <strong>{{ siteLabel(site) }}</strong>
                <el-tag :type="availabilityTagType(currentAvailability.sites?.[site]?.status)" effect="plain">
                  {{ availabilityLabel(currentAvailability.sites?.[site]) }}
                </el-tag>
              </span>
            </el-descriptions-item>
            <el-descriptions-item v-if="ehviewerAvailability" :label="$t('audit.ehviewerAvailability')">
              <span v-for="site in availabilitySites" :key="`ehviewer-${site}`" class="availability-item">
                <strong>{{ siteLabel(site) }}</strong>
                <el-tag :type="availabilityTagType(ehviewerAvailability.sites?.[site]?.status)" effect="plain">
                  {{ availabilityLabel(ehviewerAvailability.sites?.[site]) }}
                </el-tag>
              </span>
            </el-descriptions-item>
          </el-descriptions>
            </div>
          </div>
          <pre class="evidence-block">{{ selectedAnomalyEvidenceText }}</pre>
        </template>
      </el-drawer>

      <el-drawer v-model="duplicateDrawer" :title="auditTypeLabel(selectedDuplicate?.kind)" size="52%">
        <template v-if="selectedDuplicate">
          <el-alert v-if="!selectedDuplicate.eligible" type="warning" :closable="false" show-icon :title="selectedDuplicate.reviewReason" />
          <div class="duplicate-editor-actions">
            <el-button v-if="selectedDuplicate.eligible" :disabled="running" @click="useSuggestion(selectedDuplicate)">{{ $t('audit.useSuggestion') }}</el-button>
            <el-button :disabled="running" @click="clearDuplicateSelection(selectedDuplicate.id)">{{ $t('audit.clearApproval') }}</el-button>
          </div>
          <el-table :data="selectedDuplicate.items" row-key="id" height="390">
            <el-table-column :label="$t('audit.keep')" width="64" align="center">
              <template #default="scope"><el-radio v-model="duplicateDraft.keepId" :value="scope.row.id" :disabled="running" /></template>
            </el-table-column>
            <el-table-column :label="$t('audit.quarantine')" width="88" align="center">
              <template #default="scope"><el-checkbox v-model="duplicateDraft.quarantineIds" :value="scope.row.id" :disabled="running || duplicateDraft.keepId === scope.row.id" /></template>
            </el-table-column>
            <el-table-column prop="title" :label="$t('audit.titleColumn')" min-width="180" show-overflow-tooltip />
            <el-table-column prop="filepath" :label="$t('audit.filepath')" min-width="340" show-overflow-tooltip />
            <el-table-column prop="url" label="URL" min-width="210" show-overflow-tooltip />
          </el-table>
          <pre class="evidence-block">{{ selectedDuplicateEvidenceText }}</pre>
          <div class="drawer-footer"><el-button type="primary" :disabled="running" @click="applyDuplicateDraft">{{ $t('audit.approveSelection') }}</el-button></div>
        </template>
      </el-drawer>
    </main>
  </el-config-provider>
</template>

<script setup>
import { computed, markRaw, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Connection, DocumentChecked, FolderOpened, Picture, Refresh, Search, Select, Tickets, TopRight, VideoPause, VideoPlay } from '@element-plus/icons-vue'
import zhCnElement from 'element-plus/dist/locale/zh-cn.mjs'
import zhTwElement from 'element-plus/dist/locale/zh-tw.mjs'
import enElement from 'element-plus/dist/locale/en.mjs'

const props = defineProps({ initialSetting: { type: Object, required: true } })
const { t, te, locale } = useI18n()
const initialSetting = props.initialSetting
const state = reactive({ jobId: null, status: 'idle', phase: 'idle', completed: 0, total: 0, error: null })
const report = shallowRef(null)
const review = reactive({ anomalyActionIds: [], duplicateSelections: {} })
const logs = shallowRef([])
const activeLogPanels = ref([])
const activeTab = ref('anomalies')
const scanMode = ref('quick')
const deepScope = ref('anomalies')
const onlineScope = ref('conflicts')
const forceOnline = ref(false)
const anomalySearchInput = ref('')
const anomalySearch = ref('')
const severityFilter = ref('')
const anomalyTypeFilter = ref('')
const actionableOnly = ref(false)
const duplicateSearchInput = ref('')
const duplicateSearch = ref('')
const duplicateKindFilter = ref('')
const anomalyPage = ref(1)
const anomalyPageSize = ref(50)
const duplicatePage = ref(1)
const duplicatePageSize = ref(50)
const anomalyDrawer = ref(false)
const duplicateDrawer = ref(false)
const selectedAnomaly = shallowRef(null)
const anomalyBookPreview = shallowRef(null)
const anomalyPreviewLoading = ref(false)
const anomalyDetailOpening = ref(false)
const selectedDuplicate = shallowRef(null)
const duplicateDraft = reactive({ keepId: null, quarantineIds: [] })
const quarantineRoot = ref(`${String(initialSetting.library).replace(/[\\/][^\\/]+[\\/]?$/, '')}\\DedupeReview`)
const severities = ['critical', 'high', 'medium', 'low']
const availabilitySites = ['ehentai', 'exhentai']
const pageSizes = [50, 100, 200, 500]
const anomalySearchIndex = shallowRef(new Map())
const duplicateSearchIndex = shallowRef(new Map())
const modeOptions = computed(() => [
  { label: t('audit.quickScan'), value: 'quick' },
  { label: t('audit.deepScan'), value: 'deep' },
  { label: t('audit.onlineScan'), value: 'online' }
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
const currentAvailability = computed(() => selectedAnomaly.value?.evidence?.currentAvailability || null)
const ehviewerAvailability = computed(() => selectedAnomaly.value?.evidence?.ehviewerAvailability || null)
const anomalyBookTitle = computed(() => anomalyBookPreview.value?.title_jpn || anomalyBookPreview.value?.title || '')
const anomalyBookCount = computed(() => report.value?.summary?.anomalyBooks ??
  new Set((report.value?.anomalies || []).filter(item => item.bookId).map(item => String(item.bookId))).size)
const anomalyTypes = computed(() => [...new Set((report.value?.anomalies || []).map(item => item.type))].sort())
const duplicateKinds = computed(() => [...new Set((report.value?.duplicates || []).map(item => item.kind))].sort())
const filteredAnomalies = computed(() => (report.value?.anomalies || []).filter(item => {
  return (!severityFilter.value || item.severity === severityFilter.value) &&
    (!anomalyTypeFilter.value || item.type === anomalyTypeFilter.value) &&
    (!actionableOnly.value || Boolean(item.action)) &&
    (!anomalySearch.value || (anomalySearchIndex.value.get(item.id) || '').includes(anomalySearch.value))
}))
const filteredDuplicates = computed(() => (report.value?.duplicates || []).filter(item => {
  return (!duplicateKindFilter.value || item.kind === duplicateKindFilter.value) &&
    (!duplicateSearch.value || (duplicateSearchIndex.value.get(item.id) || '').includes(duplicateSearch.value))
}))
const pagedAnomalies = computed(() => {
  const start = (anomalyPage.value - 1) * anomalyPageSize.value
  return filteredAnomalies.value.slice(start, start + anomalyPageSize.value)
})
const pagedDuplicates = computed(() => {
  const start = (duplicatePage.value - 1) * duplicatePageSize.value
  return filteredDuplicates.value.slice(start, start + duplicatePageSize.value)
})
const selectedAnomalyIdSet = computed(() => new Set(review.anomalyActionIds))
const isAnomalySelected = id => selectedAnomalyIdSet.value.has(id)
const filteredActionableAnomalyIds = computed(() => filteredAnomalies.value.filter(item => item.action).map(item => item.id))
const filteredAnomalyBookIds = computed(() => [...new Set(filteredAnomalies.value.map(item => item.bookId).filter(Boolean).map(String))])
const selectedFilteredAnomalyCount = computed(() => {
  return filteredAnomalies.value.reduce((count, item) => count + Number(selectedAnomalyIdSet.value.has(item.id)), 0)
})
const anomalyFilterScopeLabel = computed(() => {
  if (anomalyTypeFilter.value) return auditTypeLabel(anomalyTypeFilter.value)
  if (anomalySearch.value.trim() || severityFilter.value || actionableOnly.value) return t('audit.currentFilter')
  return t('audit.allAnomalies')
})
const allFilteredAnomaliesSelected = computed(() => filteredActionableAnomalyIds.value.length > 0 &&
  filteredActionableAnomalyIds.value.every(id => selectedAnomalyIdSet.value.has(id)))
const someFilteredAnomaliesSelected = computed(() => !allFilteredAnomaliesSelected.value &&
  filteredActionableAnomalyIds.value.some(id => selectedAnomalyIdSet.value.has(id)))
const pendingOnlineBookIds = computed(() => {
  if (!report.value || report.value.mode === 'online') return []
  return [...new Set((report.value.anomalies || [])
    .filter(item => item.bookId && !item.action && [
      'ehviewer-url-conflict',
      'ehviewer-source-recoverable'
    ].includes(item.type))
    .map(item => String(item.bookId)))]
})
const approvedCount = computed(() => review.anomalyActionIds.length + Object.keys(review.duplicateSelections).length)
const logText = computed(() => logs.value.map(item => `[${item.at}] ${item.message}`).join('\n'))
const selectedAnomalyEvidenceText = computed(() => JSON.stringify(selectedAnomaly.value?.evidence || {}, null, 2))
const selectedDuplicateEvidenceText = computed(() => JSON.stringify(selectedDuplicate.value?.evidence || {}, null, 2))

let removeStateListener
let removeLogListener
let lastReportPath = null
let selectVerifiedActions = false
let anomalyPreviewRequest = 0
let anomalySearchTimer = null
let duplicateSearchTimer = null
let stateFrame = null
let pendingState = null
let reloadPromise = null
let reloadRequested = false

const normalizeSearchText = value => String(value || '').trim().toLocaleLowerCase()
const rebuildSearchIndexes = nextReport => {
  anomalySearchIndex.value = new Map((nextReport?.anomalies || []).map(item => [
    item.id,
    normalizeSearchText(`${item.type || ''} ${auditTypeLabel(item.type)} ${item.reason || ''} ${item.filepath || ''}`)
  ]))
  duplicateSearchIndex.value = new Map((nextReport?.duplicates || []).map(item => [
    item.id,
    normalizeSearchText(`${item.kind || ''} ${auditTypeLabel(item.kind)} ${(item.items || []).map(book => `${book.title || ''} ${book.filepath || ''}`).join(' ')}`)
  ]))
}
const assignState = value => {
  if (!value) return false
  const currentUpdatedAt = Date.parse(state.updatedAt || '')
  const nextUpdatedAt = Date.parse(value.updatedAt || '')
  if (Number.isFinite(currentUpdatedAt) && Number.isFinite(nextUpdatedAt) && nextUpdatedAt < currentUpdatedAt) return false
  Object.assign(state, value)
  return true
}
const loadReportSnapshot = async () => {
  const [nextState, nextReport, nextReview] = await Promise.all([
    window.auditApi.getState(),
    window.auditApi.getReport(),
    window.auditApi.getReview()
  ])
  assignState(nextState)
  report.value = nextReport ? markRaw(nextReport) : null
  rebuildSearchIndexes(nextReport)
  if (nextReview) {
    review.anomalyActionIds = nextReview.anomalyActionIds || []
    review.duplicateSelections = nextReview.duplicateSelections || {}
  }
  if (selectVerifiedActions && nextState?.status === 'completed' && nextReport?.mode === 'online') {
    review.anomalyActionIds = (nextReport.anomalies || []).filter(item => item.action).map(item => item.id)
    selectVerifiedActions = false
    activeTab.value = 'anomalies'
    const count = review.anomalyActionIds.length
    actionableOnly.value = count > 0
    ElMessage[count ? 'success' : 'info'](t(count ? 'audit.verifiedActionsSelected' : 'audit.noVerifiedActions', { count }))
  }
  lastReportPath = nextState?.reportPath || null
}
const reloadReport = () => {
  reloadRequested = true
  if (reloadPromise) return reloadPromise
  reloadPromise = (async () => {
    while (reloadRequested) {
      reloadRequested = false
      await loadReportSnapshot()
    }
  })().finally(() => { reloadPromise = null })
  return reloadPromise
}
const scheduleStateUpdate = value => {
  pendingState = { ...(pendingState || {}), ...(value || {}) }
  if (stateFrame !== null) return
  stateFrame = window.requestAnimationFrame(() => {
    stateFrame = null
    const nextState = pendingState
    pendingState = null
    if (!assignState(nextState)) return
    if (['failed', 'interrupted'].includes(nextState.status)) selectVerifiedActions = false
    if (nextState.reportPath && nextState.reportPath !== lastReportPath && nextState.status === 'completed') {
      lastReportPath = nextState.reportPath
      void reloadReport().catch(error => console.log(error))
    }
  })
}
watch(anomalySearchInput, value => {
  clearTimeout(anomalySearchTimer)
  anomalySearchTimer = setTimeout(() => {
    anomalySearch.value = normalizeSearchText(value)
    anomalyPage.value = 1
  }, 140)
})
watch(duplicateSearchInput, value => {
  clearTimeout(duplicateSearchTimer)
  duplicateSearchTimer = setTimeout(() => {
    duplicateSearch.value = normalizeSearchText(value)
    duplicatePage.value = 1
  }, 140)
})
watch([severityFilter, anomalyTypeFilter, actionableOnly], () => { anomalyPage.value = 1 })
watch(duplicateKindFilter, () => { duplicatePage.value = 1 })
watch([() => filteredAnomalies.value.length, anomalyPageSize], ([total, pageSize]) => {
  anomalyPage.value = Math.min(anomalyPage.value, Math.max(1, Math.ceil(total / pageSize)))
})
watch([() => filteredDuplicates.value.length, duplicatePageSize], ([total, pageSize]) => {
  duplicatePage.value = Math.min(duplicatePage.value, Math.max(1, Math.ceil(total / pageSize)))
})
watch(locale, () => rebuildSearchIndexes(report.value))
const launchAudit = async request => {
  try {
    assignState(await window.auditApi.start(request))
    return true
  } catch (error) {
    ElMessage.error(error.message || String(error))
    return false
  }
}
const startAudit = () => launchAudit({
  mode: scanMode.value,
  deepScope: deepScope.value,
  onlineScope: onlineScope.value,
  forceOnline: forceOnline.value
})
const verifyPendingConflicts = async () => {
  const onlineBookIds = [...pendingOnlineBookIds.value]
  if (!onlineBookIds.length) return
  scanMode.value = 'online'
  onlineScope.value = 'conflicts'
  selectVerifiedActions = true
  const started = await launchAudit({
    mode: 'online',
    onlineScope: 'conflicts',
    forceOnline: false,
    onlineBookIds
  })
  if (!started) selectVerifiedActions = false
}
const cancelAudit = () => window.auditApi.cancel()
const toggleAnomaly = (id, value) => {
  review.anomalyActionIds = value ? [...new Set([...review.anomalyActionIds, id])] : review.anomalyActionIds.filter(item => item !== id)
}
const toggleAllFilteredAnomalies = value => {
  const ids = new Set(filteredActionableAnomalyIds.value)
  review.anomalyActionIds = value
    ? [...new Set([...review.anomalyActionIds, ...ids])]
    : review.anomalyActionIds.filter(id => !ids.has(id))
}
const openAnomaly = async row => {
  const requestId = ++anomalyPreviewRequest
  selectedAnomaly.value = row
  anomalyBookPreview.value = null
  anomalyPreviewLoading.value = false
  anomalyDrawer.value = true
  if (!row.bookId) return
  anomalyPreviewLoading.value = true
  try {
    const preview = await window.auditApi.getBookPreview(row.bookId)
    if (requestId === anomalyPreviewRequest) anomalyBookPreview.value = preview
  } catch (error) {
    console.log(error)
  } finally {
    if (requestId === anomalyPreviewRequest) anomalyPreviewLoading.value = false
  }
}
const openSelectedAnomalyBookDetail = async () => {
  const bookId = selectedAnomaly.value?.bookId
  if (!bookId || anomalyDetailOpening.value) return
  anomalyDetailOpening.value = true
  try {
    await window.auditApi.openBookDetail({
      bookId: String(bookId),
      navigationIds: filteredAnomalyBookIds.value
    })
  } catch (error) {
    console.error(error)
    ElMessage.error(t('audit.openBookDetailFailed'))
  } finally {
    anomalyDetailOpening.value = false
  }
}
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
const auditTypeLabel = value => {
  if (!value) return ''
  const key = `audit.type_${value}`
  return te(key) ? t(key) : value
}
const severityTag = severity => ({ critical: 'danger', high: 'danger', medium: 'warning', low: 'info' })[severity] || 'info'
const siteLabel = site => site === 'exhentai' ? 'ExHentai' : 'E-Hentai'
const availabilityTagType = status => ({ available: 'success', copyright: 'danger', 'generic-unavailable': 'danger', 'gallery-not-found': 'danger', 'geo-blocked': 'warning', 'auth-required': 'warning', 'ip-banned': 'warning', 'service-unavailable': 'warning', 'network-error': 'info', unchecked: 'info', unknown: 'info' })[status] || 'info'
const availabilityLabel = value => {
  if (!value) return t('audit.availability_unchecked')
  const key = `audit.availability_${value.status}`
  const label = te(key) ? t(key) : value.status
  if (value.claimant) return `${label}: ${value.claimant}`
  if (value.region) return `${label}: ${value.region}`
  return label
}
const formatBytes = value => {
  let size = Number(value || 0)
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let index = 0
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1 }
  return `${size.toFixed(index === 0 ? 0 : 2)} ${units[index]}`
}

onMounted(async () => {
  removeStateListener = window.auditApi.onState(scheduleStateUpdate)
  removeLogListener = window.auditApi.onLog(entry => {
    logs.value = [...logs.value.slice(-199), markRaw(entry)]
  })
  await reloadReport()
})
onBeforeUnmount(() => {
  removeStateListener?.()
  removeLogListener?.()
  clearTimeout(anomalySearchTimer)
  clearTimeout(duplicateSearchTimer)
  if (stateFrame !== null) window.cancelAnimationFrame(stateFrame)
})
</script>

<style scoped>
.audit-shell { height: 100vh; overflow: hidden; display: flex; flex-direction: column; color: var(--el-text-color-primary); background: var(--el-bg-color); }
.audit-toolbar { flex: 0 0 auto; min-height: 72px; padding: 10px 18px; border-bottom: 1px solid var(--el-border-color); display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.audit-heading { min-width: 0; }
.audit-heading h1 { margin: 0 0 4px; font-size: 20px; letter-spacing: 0; }
.audit-heading span { display: block; max-width: 680px; color: var(--el-text-color-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.audit-actions { display: flex; align-items: center; gap: 8px; }
.scope-select { width: 160px; }
.task-band { flex: 0 0 auto; padding: 10px 18px; border-bottom: 1px solid var(--el-border-color); }
.task-line { display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 13px; }
.task-band .el-alert { margin-top: 8px; }
.summary-band { flex: 0 0 auto; display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); border-bottom: 1px solid var(--el-border-color); }
.summary-band div { padding: 10px 18px; border-right: 1px solid var(--el-border-color); }
.summary-band strong, .summary-band span { display: block; }
.summary-band strong { font-size: 18px; }
.summary-band span { margin-top: 3px; color: var(--el-text-color-secondary); font-size: 12px; }
.audit-tabs { flex: 1 1 auto; min-height: 0; padding: 0 18px 58px; display: flex; flex-direction: column; box-sizing: border-box; }
.audit-tabs :deep(.el-tabs__header) { flex: 0 0 auto; }
.audit-tabs :deep(.el-tabs__content) { flex: 1 1 auto; min-height: 0; }
.audit-tabs :deep(.el-tab-pane) { height: 100%; min-height: 0; }
.audit-tabs :deep(.audit-list-pane) { display: flex; flex-direction: column; }
.filter-row { display: grid; grid-template-columns: minmax(280px, 1fr) 180px 240px; gap: 10px; margin-bottom: 10px; }
.filter-meta-row { display: flex; min-height: 32px; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 10px; }
.filter-counts { display: inline-flex; align-items: center; gap: 14px; color: var(--el-text-color-secondary); font-size: 13px; font-variant-numeric: tabular-nums; }
.filter-counts strong { padding-left: 14px; color: var(--el-text-color-primary); border-left: 1px solid var(--el-border-color); font-weight: 600; }
.audit-table-region { flex: 1 1 auto; min-height: 120px; overflow: hidden; }
.table-pagination { flex: 0 0 auto; min-height: 42px; padding-top: 8px; justify-content: flex-end; }
.approval-pane { max-width: 860px; padding: 14px 0; }
.approval-line { display: flex; justify-content: space-between; padding: 14px 4px; border-bottom: 1px solid var(--el-border-color-lighter); }
.path-line { display: grid; grid-template-columns: 1fr 40px; gap: 8px; margin: 20px 0; }
.approval-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
.log-pane { position: fixed; z-index: 100; isolation: isolate; left: 18px; right: 18px; bottom: 0; overflow: hidden; pointer-events: auto; background: var(--el-bg-color); border: 1px solid var(--el-border-color); border-bottom: 0; border-radius: 6px 6px 0 0; box-shadow: var(--el-box-shadow-light); }
.log-pane :deep(.el-collapse-item__header) { position: relative; z-index: 1; min-height: 46px; padding: 0 14px; cursor: pointer; user-select: none; color: var(--el-text-color-primary); background: var(--el-fill-color-light); border-bottom: 0; font-weight: 600; transition: color 0.18s ease, background-color 0.18s ease; }
.log-pane :deep(.el-collapse-item__header:hover) { color: var(--el-color-primary); background: var(--el-fill-color); }
.log-pane :deep(.el-collapse-item.is-active .el-collapse-item__header) { color: var(--el-color-primary); background: var(--el-color-primary-light-9); border-bottom: 1px solid var(--el-border-color); }
.log-pane :deep(.el-collapse-item__arrow) { color: var(--el-color-primary); font-size: 16px; }
.log-pane :deep(.el-collapse-item__wrap) { background: var(--el-bg-color-overlay); border-bottom: 0; }
.log-pane :deep(.el-collapse-item__content) { padding: 12px 14px 14px; }
.log-title { display: inline-flex; align-items: center; gap: 8px; }
.log-title .el-icon { color: var(--el-color-primary); font-size: 17px; }
.log-pane pre, .evidence-block { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.5; }
.log-pane pre { max-height: 160px; overflow: auto; margin: 0; }
.evidence-block { margin-top: 16px; padding: 12px; background: var(--el-fill-color-light); border: 1px solid var(--el-border-color-lighter); }
.anomaly-detail-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; align-items: start; }
.anomaly-detail-grid.has-book-preview { grid-template-columns: 150px minmax(0, 1fr); }
.anomaly-description, .anomaly-book-preview { min-width: 0; }
.anomaly-cover-button { display: block; width: 150px; padding: 0; border: 0; border-radius: 4px; color: inherit; background: transparent; cursor: pointer; }
.anomaly-cover-button:disabled { cursor: wait; }
.anomaly-cover-button:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
.anomaly-cover-button:not(:disabled):hover .anomaly-cover { border-color: var(--el-color-primary); box-shadow: 0 0 0 1px var(--el-color-primary-light-5); }
.anomaly-cover { box-sizing: border-box; display: block; width: 150px; aspect-ratio: 500 / 707; overflow: hidden; background: var(--el-fill-color-light); border: 1px solid var(--el-border-color); border-radius: 4px; }
.anomaly-cover-placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--el-text-color-secondary); font-size: 12px; text-align: center; }
.anomaly-cover-placeholder .el-icon { font-size: 28px; }
.anomaly-book-preview p { display: -webkit-box; margin: 8px 0 0; overflow: hidden; color: var(--el-text-color-regular); font-size: 12px; line-height: 1.5; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
.availability-item { display: inline-flex; align-items: center; gap: 6px; margin-right: 14px; }
.anomaly-checkbox { display: inline-flex; align-items: center; justify-content: center; }
.duplicate-editor-actions { display: flex; gap: 8px; margin: 12px 0; }
.drawer-footer { display: flex; justify-content: flex-end; margin-top: 14px; }
@media (max-width: 900px) {
  .audit-toolbar { align-items: flex-start; flex-direction: column; }
  .audit-actions { width: 100%; flex-wrap: wrap; }
  .summary-band { grid-template-columns: repeat(2, 1fr); }
  .filter-row { grid-template-columns: 1fr; }
  .filter-meta-row { align-items: flex-start; flex-direction: column; gap: 8px; }
  .anomaly-detail-grid.has-book-preview { grid-template-columns: minmax(0, 1fr); }
}
</style>

<style>
html, body, #audit-app { margin: 0; min-width: 720px; height: 100%; overflow: hidden; background: var(--el-bg-color); }
html.light { color-scheme: light; }
html.exhentai { background: #34353b; --el-bg-color: #34353b; --el-bg-color-overlay: #34353b; --el-color-primary: #909399; --el-fill-color-light: #3d414b; --el-border-color: #6e6e6e; }
html.e-hentai { background: #e2e0d2; --el-bg-color: #e2e0d2; --el-bg-color-overlay: #e2e0d2; --el-color-primary: #521613; --el-fill-color-light: #edebe0; --el-border-color: #919191; }
html.nhentai { background: #0d0d0d; --el-bg-color: #0d0d0d; --el-bg-color-overlay: #0d0d0d; --el-color-primary: #d54255; --el-fill-color-light: #1f1f1f; --el-border-color: #6e6e6e; }
</style>

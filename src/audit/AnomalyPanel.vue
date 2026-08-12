<template>
  <section class="task-panel">
    <div class="task-toolbar">
      <div class="task-toolbar-main">
        <el-select v-model="onlinePolicy" class="online-policy" :disabled="busy">
          <el-option :label="$t('audit.onlinePolicyNone')" value="none" />
          <el-option :label="$t('audit.onlineScopeConflicts')" value="conflicts" />
          <el-option :label="$t('audit.onlineScopeUrls')" value="urls" />
          <el-option :label="$t('audit.onlineScopeEhviewer')" value="ehviewer" />
        </el-select>
        <el-checkbox v-model="forceLocal" :disabled="busy">{{ $t('audit.forceLocal') }}</el-checkbox>
        <el-checkbox v-if="onlinePolicy !== 'none'" v-model="forceOnline" :disabled="busy">{{ $t('audit.forceRefresh') }}</el-checkbox>
        <el-button type="primary" :icon="VideoPlay" :disabled="busy" @click="start">{{ $t('audit.startAnomaly') }}</el-button>
        <el-tooltip v-if="pendingOnlineBookIds.length" :content="$t('audit.verifyPendingConflictsInfo')">
          <el-button type="warning" plain :icon="Connection" :disabled="busy" @click="$emit('verify-conflicts', pendingOnlineBookIds)">
            {{ $t('audit.verifyPendingConflicts', { count: pendingOnlineBookIds.length }) }}
          </el-button>
        </el-tooltip>
      </div>
      <span class="last-run">{{ lastRunText }}</span>
    </div>

    <el-alert v-if="running && report" type="info" :closable="false" :title="$t('audit.previousAnomalyReportWhileRunning')" show-icon />
    <el-alert v-if="report?.legacy" type="warning" :closable="false" :title="$t('audit.legacyReportReadOnly')" show-icon />
    <el-alert v-if="report?.stale" type="warning" :closable="false" :title="$t('audit.staleReportReadOnly')" show-icon />

    <div v-if="report" class="summary-band">
      <div><strong>{{ report.summary.libraryItems }}</strong><span>{{ $t('audit.libraryItems') }}</span></div>
      <div><strong>{{ report.summary.mangaRows }}</strong><span>{{ $t('audit.databaseRows') }}</span></div>
      <div><strong>{{ report.summary.anomalies }}</strong><span>{{ $t('audit.anomalies') }}</span></div>
      <div><strong>{{ anomalyBookCount }}</strong><span>{{ $t('audit.anomalyBooks') }}</span></div>
      <div><strong>{{ report.summary.actionableAnomalies || 0 }}</strong><span>{{ $t('audit.actionableAnomalies') }}</span></div>
      <div v-if="report.options?.onlinePolicy !== 'none'"><strong>{{ report.summary.onlineIdentities || 0 }}</strong><span>{{ $t('audit.onlineIdentities') }}</span></div>
      <div v-if="report.options?.onlinePolicy !== 'none'"><strong>{{ report.summary.onlineAvailable || 0 }}</strong><span>{{ $t('audit.onlineAvailable') }}</span></div>
      <div v-if="report.options?.onlinePolicy !== 'none'"><strong>{{ report.summary.onlineCopyright || 0 }}</strong><span>{{ $t('audit.onlineCopyright') }}</span></div>
    </div>

    <template v-if="report">
      <div class="filter-row">
        <el-input v-model="searchInput" :prefix-icon="Search" clearable :placeholder="$t('audit.filterPlaceholder')" />
        <el-select v-model="severityFilter" clearable :placeholder="$t('audit.severity')">
          <el-option v-for="severity in severities" :key="severity" :label="$t(`audit.${severity}`)" :value="severity" />
        </el-select>
        <el-select v-model="typeFilter" clearable filterable :placeholder="$t('audit.type')">
          <el-option v-for="type in anomalyTypes" :key="type" :label="auditTypeLabel(type)" :value="type" />
        </el-select>
      </div>
      <div class="filter-meta-row">
        <el-checkbox v-model="actionableOnly">{{ $t('audit.actionableOnly') }}</el-checkbox>
        <div class="filter-counts" aria-live="polite">
          <span>{{ $t('audit.filteredScopeCount', { scope: filterScopeLabel, count: filteredAnomalies.length }) }}</span>
          <strong v-if="selectedFilteredCount">{{ $t('audit.selectedFilteredCount', { count: selectedFilteredCount }) }}</strong>
        </div>
      </div>
      <div class="audit-table-region">
        <el-table :data="pagedAnomalies" height="100%" row-key="id" @row-click="openAnomaly">
          <el-table-column width="78" align="center">
            <template #header>
              <el-tooltip :content="$t('audit.selectAllFiltered')">
                <el-checkbox
                  :model-value="allFilteredSelected"
                  :indeterminate="someFilteredSelected"
                  :disabled="reviewLocked || report.executable === false || filteredActionableIds.length === 0"
                  @change="toggleAllFiltered"
                />
              </el-tooltip>
            </template>
            <template #default="scope">
              <el-tooltip v-if="scope.row.action" :content="$t('audit.previousReportReadOnly')" :disabled="!reviewLocked && report.executable !== false">
                <span class="anomaly-checkbox"><el-checkbox :model-value="selectedIdSet.has(scope.row.id)" :disabled="reviewLocked || report.executable === false" @click.stop @change="value => toggleAnomaly(scope.row.id, value)" /></span>
              </el-tooltip>
              <el-tag v-else size="small" type="info" effect="plain">{{ $t('audit.reportOnly') }}</el-tag>
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
            <template #default="scope"><el-tooltip :content="$t('audit.locate')"><el-button link :icon="FolderOpened" @click.stop="locate(scope.row.filepath)" /></el-tooltip></template>
          </el-table-column>
        </el-table>
      </div>
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        class="table-pagination"
        :page-sizes="pageSizes"
        :total="filteredAnomalies.length"
        layout="total, sizes, prev, pager, next, jumper"
      />
      <div class="review-action-bar">
        <div class="review-action-summary">
          <strong>{{ $t('audit.selectedAnomalyRepairs', { count: actionIds.length }) }}</strong>
          <span>{{ reviewStatusLabel }}</span>
        </div>
        <div class="review-action-buttons">
          <el-button :icon="Close" :disabled="reviewLocked || actionIds.length === 0" @click="$emit('update:actionIds', [])">{{ $t('audit.clearApproval') }}</el-button>
          <el-button :icon="DocumentChecked" :loading="reviewSaving" :disabled="reviewLocked || !reviewDirty" @click="$emit('save-review')">{{ $t('audit.saveReview') }}</el-button>
          <el-button type="danger" :icon="Select" :disabled="reviewLocked || actionIds.length === 0 || report.executable === false" @click="$emit('execute')">{{ $t('audit.executeAnomalyRepairs') }}</el-button>
        </div>
      </div>
    </template>
    <el-empty v-else :description="$t('audit.noAnomalyReport')" />

    <el-drawer v-model="drawer" :title="auditTypeLabel(selectedAnomaly?.type)" size="46%">
      <template v-if="selectedAnomaly">
        <div class="anomaly-detail-grid" :class="{ 'has-book-preview': selectedAnomaly.bookId }">
          <aside v-if="selectedAnomaly.bookId" class="anomaly-book-preview">
            <el-tooltip :content="$t('audit.openBookDetailWindow')" placement="bottom">
              <button type="button" class="anomaly-cover-button" :aria-label="$t('audit.openBookDetailWindow')" :disabled="detailOpening" @click="openBookDetail">
                <el-skeleton v-if="previewLoading" animated><template #template><el-skeleton-item variant="image" class="anomaly-cover" /></template></el-skeleton>
                <el-image v-else-if="bookPreview?.coverPath" class="anomaly-cover" :src="bookPreview.coverPath" fit="cover">
                  <template #error><div class="anomaly-cover-placeholder"><el-icon><Picture /></el-icon><span>{{ $t('audit.coverUnavailable') }}</span></div></template>
                </el-image>
                <div v-else class="anomaly-cover anomaly-cover-placeholder"><el-icon><Picture /></el-icon><span>{{ $t('audit.coverUnavailable') }}</span></div>
              </button>
            </el-tooltip>
            <p v-if="bookTitle" :title="bookTitle">{{ bookTitle }}</p>
          </aside>
          <div class="anomaly-description">
            <el-descriptions :column="1" border>
              <el-descriptions-item :label="$t('audit.severity')">{{ $t(`audit.${selectedAnomaly.severity}`) }}</el-descriptions-item>
              <el-descriptions-item :label="$t('audit.reason')">{{ selectedAnomaly.reason }}</el-descriptions-item>
              <el-descriptions-item :label="$t('audit.filepath')">{{ selectedAnomaly.filepath || '-' }}</el-descriptions-item>
              <el-descriptions-item :label="$t('audit.recommendation')">{{ selectedAnomaly.recommendedAction }}</el-descriptions-item>
              <el-descriptions-item v-if="currentEvidenceUrl" :label="$t('audit.currentUrl')">
                <el-link type="primary" :underline="false" @click="openExternalUrl(currentEvidenceUrl)"><span>{{ currentEvidenceUrl }}</span><el-icon><TopRight /></el-icon></el-link>
              </el-descriptions-item>
              <el-descriptions-item v-if="ehviewerEvidenceUrl && ehviewerEvidenceUrl !== currentEvidenceUrl" :label="$t('audit.ehviewerUrl')">
                <el-link type="primary" :underline="false" @click="openExternalUrl(ehviewerEvidenceUrl)"><span>{{ ehviewerEvidenceUrl }}</span><el-icon><TopRight /></el-icon></el-link>
              </el-descriptions-item>
              <el-descriptions-item v-if="currentAvailability" :label="$t('audit.currentAvailability')"><availability-list :value="currentAvailability" /></el-descriptions-item>
              <el-descriptions-item v-if="ehviewerAvailability && ehviewerEvidenceUrl !== currentEvidenceUrl" :label="$t('audit.ehviewerAvailability')"><availability-list :value="ehviewerAvailability" /></el-descriptions-item>
            </el-descriptions>
          </div>
        </div>
        <pre class="evidence-block">{{ JSON.stringify(selectedAnomaly.evidence || {}, null, 2) }}</pre>
      </template>
    </el-drawer>
  </section>
</template>

<script setup>
import { computed, defineComponent, h, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElIcon, ElMessage, ElTag } from 'element-plus'
import { Close, Connection, DocumentChecked, FolderOpened, Picture, Search, Select, TopRight, VideoPlay } from '@element-plus/icons-vue'

const props = defineProps({
  report: { type: Object, default: null },
  state: { type: Object, required: true },
  busy: Boolean,
  reviewLocked: Boolean,
  actionIds: { type: Array, default: () => [] },
  reviewSaving: Boolean,
  reviewDirty: Boolean
})
const emit = defineEmits(['start', 'verify-conflicts', 'update:actionIds', 'save-review', 'execute'])
const { t, te } = useI18n()
const onlinePolicy = ref('none')
const forceLocal = ref(false)
const forceOnline = ref(false)
const searchInput = ref('')
const search = ref('')
const severityFilter = ref('')
const typeFilter = ref('')
const actionableOnly = ref(false)
const page = ref(1)
const pageSize = ref(50)
const pageSizes = [50, 100, 200, 500]
const severities = ['critical', 'high', 'medium', 'low']
const drawer = ref(false)
const selectedAnomaly = ref(null)
const bookPreview = ref(null)
const previewLoading = ref(false)
const detailOpening = ref(false)
let searchTimer
let previewRequest = 0

const running = computed(() => ['running', 'cancelling'].includes(props.state.status))
const lastRunText = computed(() => props.state.completedAt ? t('audit.lastCheckedAt', { time: new Date(props.state.completedAt).toLocaleString() }) : t('audit.neverChecked'))
const anomalyBookCount = computed(() => props.report?.summary?.anomalyBooks ?? new Set((props.report?.anomalies || []).filter(item => item.bookId).map(item => String(item.bookId))).size)
const anomalyTypes = computed(() => [...new Set((props.report?.anomalies || []).map(item => item.type))].sort())
const searchIndex = computed(() => new Map((props.report?.anomalies || []).map(item => [item.id, normalizeSearchText(`${item.type} ${auditTypeLabel(item.type)} ${item.reason} ${item.filepath}`)])))
const filteredAnomalies = computed(() => (props.report?.anomalies || []).filter(item =>
  (!severityFilter.value || item.severity === severityFilter.value) &&
  (!typeFilter.value || item.type === typeFilter.value) &&
  (!actionableOnly.value || Boolean(item.action)) &&
  (!search.value || (searchIndex.value.get(item.id) || '').includes(search.value))))
const pagedAnomalies = computed(() => filteredAnomalies.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))
const selectedIdSet = computed(() => new Set(props.actionIds))
const filteredActionableIds = computed(() => filteredAnomalies.value.filter(item => item.action).map(item => item.id))
const selectedFilteredCount = computed(() => filteredAnomalies.value.reduce((count, item) => count + Number(selectedIdSet.value.has(item.id)), 0))
const allFilteredSelected = computed(() => filteredActionableIds.value.length > 0 && filteredActionableIds.value.every(id => selectedIdSet.value.has(id)))
const someFilteredSelected = computed(() => !allFilteredSelected.value && filteredActionableIds.value.some(id => selectedIdSet.value.has(id)))
const filterScopeLabel = computed(() => typeFilter.value ? auditTypeLabel(typeFilter.value) : search.value || severityFilter.value || actionableOnly.value ? t('audit.currentFilter') : t('audit.allAnomalies'))
const pendingOnlineBookIds = computed(() => [...new Set((props.report?.anomalies || [])
  .filter(item => item.bookId && !item.action && ['ehviewer-url-conflict', 'ehviewer-source-recoverable'].includes(item.type))
  .map(item => String(item.bookId)))])
const filteredBookIds = computed(() => [...new Set(filteredAnomalies.value.map(item => item.bookId).filter(Boolean).map(String))])
const currentEvidenceUrl = computed(() => selectedAnomaly.value?.evidence?.currentUrl || '')
const ehviewerEvidenceUrl = computed(() => {
  const value = selectedAnomaly.value?.evidence?.ehviewer
  return value?.gid && value?.token ? `https://exhentai.org/g/${value.gid}/${value.token}/` : ''
})
const currentAvailability = computed(() => selectedAnomaly.value?.evidence?.currentAvailability || null)
const ehviewerAvailability = computed(() => selectedAnomaly.value?.evidence?.ehviewerAvailability || null)
const bookTitle = computed(() => bookPreview.value?.title_jpn || bookPreview.value?.title || '')
const reviewStatusLabel = computed(() => props.reviewSaving
  ? t('audit.reviewSaving')
  : props.reviewDirty ? t('audit.reviewUnsaved') : t('audit.reviewAutoSaved'))

const availabilityLabel = value => {
  if (!value) return t('audit.availability_unchecked')
  const key = `audit.availability_${value.status}`
  const label = te(key) ? t(key) : value.status
  return value.claimant ? `${label}: ${value.claimant}` : value.region ? `${label}: ${value.region}` : label
}
const availabilityTagType = status => ({ available: 'success', copyright: 'danger', 'generic-unavailable': 'danger', 'gallery-not-found': 'danger', 'geo-blocked': 'warning', 'auth-required': 'warning', 'ip-banned': 'warning', 'service-unavailable': 'warning', 'network-error': 'info', unchecked: 'info', unknown: 'info' })[status] || 'info'
const AvailabilityList = defineComponent({
  props: { value: Object },
  setup(componentProps) {
    return () => h('span', { class: 'availability-list' }, ['ehentai', 'exhentai'].map(site => h('span', { class: 'availability-item' }, [
      h('strong', site === 'exhentai' ? 'ExHentai' : 'E-Hentai'),
      h(ElTag, { type: availabilityTagType(componentProps.value?.sites?.[site]?.status), effect: 'plain' }, () => availabilityLabel(componentProps.value?.sites?.[site]))
    ])))
  }
})

const normalizeSearchText = value => String(value || '').trim().toLocaleLowerCase()
const auditTypeLabel = value => { const key = `audit.type_${value}`; return value && te(key) ? t(key) : value || '' }
const severityTag = severity => ({ critical: 'danger', high: 'danger', medium: 'warning', low: 'info' })[severity] || 'info'
const start = () => emit('start', { onlinePolicy: onlinePolicy.value, forceLocal: forceLocal.value, forceOnline: forceOnline.value })
const toggleAnomaly = (id, value) => emit('update:actionIds', value ? [...new Set([...props.actionIds, id])] : props.actionIds.filter(item => item !== id))
const toggleAllFiltered = value => {
  const ids = new Set(filteredActionableIds.value)
  emit('update:actionIds', value ? [...new Set([...props.actionIds, ...ids])] : props.actionIds.filter(id => !ids.has(id)))
}
const locate = filepath => filepath && window.auditApi.showFile(filepath)
const openExternalUrl = url => url && window.auditApi.openUrl(url)
const openAnomaly = async row => {
  const requestId = ++previewRequest
  selectedAnomaly.value = row
  bookPreview.value = null
  drawer.value = true
  if (!row.bookId) return
  previewLoading.value = true
  try {
    const preview = await window.auditApi.getBookPreview(row.bookId)
    if (requestId === previewRequest) bookPreview.value = preview
  } finally {
    if (requestId === previewRequest) previewLoading.value = false
  }
}
const openBookDetail = async () => {
  if (!selectedAnomaly.value?.bookId || detailOpening.value) return
  detailOpening.value = true
  try {
    await window.auditApi.openBookDetail({ bookId: String(selectedAnomaly.value.bookId), navigationIds: filteredBookIds.value })
  } catch (error) {
    ElMessage.error(t('audit.openBookDetailFailed'))
  } finally {
    detailOpening.value = false
  }
}

watch(searchInput, value => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { search.value = normalizeSearchText(value); page.value = 1 }, 140) })
watch([severityFilter, typeFilter, actionableOnly], () => { page.value = 1 })
watch([() => filteredAnomalies.value.length, pageSize], ([total, size]) => { page.value = Math.min(page.value, Math.max(1, Math.ceil(total / size))) })
</script>

<style scoped>
.task-panel { min-height: 0; height: 100%; display: flex; flex-direction: column; }
.task-toolbar { flex: 0 0 auto; min-height: 48px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 8px 0; }
.task-toolbar-main, .filter-row, .filter-meta-row, .filter-counts { display: flex; align-items: center; gap: 12px; }
.online-policy { width: 190px; }
.last-run { flex: 0 0 auto; color: var(--el-text-color-secondary); font-size: 12px; }
.summary-band { flex: 0 0 auto; display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); border: 1px solid var(--el-border-color); border-radius: 4px; margin: 8px 0 12px; }
.summary-band div { padding: 9px 14px; border-right: 1px solid var(--el-border-color); }
.summary-band strong, .summary-band span { display: block; }
.summary-band strong { font-size: 18px; }.summary-band span { margin-top: 3px; color: var(--el-text-color-secondary); font-size: 12px; }
.filter-row { flex: 0 0 auto; display: grid; grid-template-columns: minmax(280px, 1fr) 180px 240px; margin-bottom: 8px; }
.filter-meta-row { flex: 0 0 auto; min-height: 30px; justify-content: space-between; }
.filter-counts { color: var(--el-text-color-secondary); font-size: 12px; }.filter-counts strong { color: var(--el-color-primary); }
.audit-table-region { flex: 1 1 auto; min-height: 220px; }.table-pagination { flex: 0 0 auto; justify-content: flex-end; padding-top: 8px; }
.review-action-bar { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 18px; min-height: 58px; margin-top: 8px; padding: 8px 12px; border: 1px solid var(--el-border-color); border-radius: 4px; background: var(--el-fill-color-lighter); }.review-action-summary { min-width: 0; }.review-action-summary strong, .review-action-summary span { display: block; }.review-action-summary span { margin-top: 3px; color: var(--el-text-color-secondary); font-size: 12px; }.review-action-buttons { display: flex; flex: 0 0 auto; gap: 8px; }
.anomaly-checkbox { display: inline-flex; align-items: center; justify-content: center; }
.anomaly-detail-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; align-items: start; }.anomaly-detail-grid.has-book-preview { grid-template-columns: 150px minmax(0, 1fr); }
.anomaly-description, .anomaly-book-preview { min-width: 0; }.anomaly-cover-button { display: block; width: 150px; padding: 0; border: 0; border-radius: 4px; color: inherit; background: transparent; cursor: pointer; }.anomaly-cover-button:disabled { cursor: wait; }.anomaly-cover-button:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }.anomaly-cover-button:not(:disabled):hover .anomaly-cover { border-color: var(--el-color-primary); box-shadow: 0 0 0 1px var(--el-color-primary-light-5); }
.anomaly-cover { box-sizing: border-box; display: block; width: 150px; aspect-ratio: 500 / 707; overflow: hidden; background: var(--el-fill-color-light); border: 1px solid var(--el-border-color); border-radius: 4px; }.anomaly-cover-placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--el-text-color-secondary); font-size: 12px; text-align: center; }.anomaly-cover-placeholder .el-icon { font-size: 28px; }.anomaly-book-preview p { display: -webkit-box; margin: 8px 0 0; overflow: hidden; color: var(--el-text-color-regular); font-size: 12px; line-height: 1.5; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
.availability-list { display: flex; flex-direction: column; gap: 8px; }.availability-item { display: inline-flex; align-items: center; gap: 8px; margin-right: 12px; }.evidence-block { padding: 14px; overflow: auto; white-space: pre-wrap; word-break: break-all; background: var(--el-fill-color-light); border: 1px solid var(--el-border-color); }
@media (max-width: 900px) { .task-toolbar, .task-toolbar-main, .review-action-bar { align-items: flex-start; flex-wrap: wrap; }.filter-row { grid-template-columns: 1fr; }.anomaly-detail-grid.has-book-preview { grid-template-columns: minmax(0, 1fr); } }
</style>

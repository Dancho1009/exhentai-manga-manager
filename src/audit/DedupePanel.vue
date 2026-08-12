<template>
  <section class="task-panel">
    <div class="task-toolbar">
      <div class="task-toolbar-main">
        <el-checkbox v-model="forceContent" :disabled="busy">{{ $t('audit.forceContent') }}</el-checkbox>
        <el-button type="primary" :icon="VideoPlay" :disabled="busy" @click="$emit('start', { forceContent })">{{ $t('audit.startDedupe') }}</el-button>
      </div>
      <span class="last-run">{{ lastRunText }}</span>
    </div>

    <el-alert v-if="running && report" type="info" :closable="false" :title="$t('audit.previousDedupeReportWhileRunning')" show-icon />
    <el-alert v-if="report?.legacy" type="warning" :closable="false" :title="$t('audit.legacyReportReadOnly')" show-icon />
    <div v-if="report" class="summary-band">
      <div><strong>{{ report.summary.libraryItems }}</strong><span>{{ $t('audit.libraryItems') }}</span></div>
      <div><strong>{{ report.summary.mangaRows }}</strong><span>{{ $t('audit.databaseRows') }}</span></div>
      <div><strong>{{ report.summary.duplicateGroups }}</strong><span>{{ $t('audit.duplicateGroups') }}</span></div>
      <div><strong>{{ report.summary.eligibleDuplicateGroups }}</strong><span>{{ $t('audit.approvableGroups') }}</span></div>
      <div><strong>{{ report.summary.excludedItems || 0 }}</strong><span>{{ $t('audit.excludedItems') }}</span></div>
      <div><strong>{{ formatBytes(report.summary.potentialBytes) }}</strong><span>{{ $t('audit.potentialSpace') }}</span></div>
    </div>
    <el-alert v-if="report?.excludedItems?.length" type="warning" :closable="false" :title="$t('audit.excludedItemsInfo', { count: report.excludedItems.length })" show-icon />

    <template v-if="report">
      <div class="filter-row">
        <el-input v-model="searchInput" :prefix-icon="Search" clearable :placeholder="$t('audit.filterPlaceholder')" />
        <el-select v-model="kindFilter" clearable filterable :placeholder="$t('audit.type')">
          <el-option v-for="kind in kinds" :key="kind" :label="auditTypeLabel(kind)" :value="kind" />
        </el-select>
      </div>
      <div class="audit-table-region">
        <el-table :data="pagedGroups" height="100%" row-key="id" @row-click="openGroup">
          <el-table-column width="48" align="center"><template #default="scope"><el-icon v-if="selections[scope.row.id]"><Select /></el-icon></template></el-table-column>
          <el-table-column :label="$t('audit.type')" width="190"><template #default="scope">{{ auditTypeLabel(scope.row.kind) }}</template></el-table-column>
          <el-table-column :label="$t('audit.eligibility')" width="140">
            <template #default="scope">
              <el-tag :type="scope.row.eligible ? 'success' : scope.row.actionable === false ? 'info' : 'warning'" effect="plain">
                {{ scope.row.eligible ? $t('audit.approvable') : scope.row.actionable === false ? $t('audit.reportOnly') : $t('audit.manualReview') }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="$t('audit.itemCount')" width="100"><template #default="scope">{{ scope.row.items.length }}</template></el-table-column>
          <el-table-column :label="$t('audit.potentialSpace')" width="130"><template #default="scope">{{ formatBytes(scope.row.potentialBytes) }}</template></el-table-column>
          <el-table-column :label="$t('audit.filepath')" min-width="480" show-overflow-tooltip><template #default="scope">{{ scope.row.items.map(item => item.filepath).join(' | ') }}</template></el-table-column>
        </el-table>
      </div>
      <el-pagination v-model:current-page="page" v-model:page-size="pageSize" class="table-pagination" :page-sizes="pageSizes" :total="filteredGroups.length" layout="total, sizes, prev, pager, next, jumper" />
    </template>
    <el-empty v-else :description="$t('audit.noDedupeReport')" />

    <el-drawer v-model="drawer" :title="auditTypeLabel(selectedGroup?.kind)" size="52%">
      <template v-if="selectedGroup">
        <el-alert v-if="selectedGroup.actionable === false" type="info" :closable="false" show-icon :title="selectedGroup.reviewReason || $t('audit.reportOnlyInfo')" />
        <el-alert v-else-if="!selectedGroup.eligible" type="warning" :closable="false" show-icon :title="selectedGroup.reviewReason" />
        <div class="duplicate-editor-actions">
          <el-button v-if="selectedGroup.eligible && selectedGroup.actionable !== false" :disabled="reviewLocked" @click="useSuggestion">{{ $t('audit.useSuggestion') }}</el-button>
          <el-button v-if="selectedGroup.actionable !== false" :disabled="reviewLocked" @click="clearSelection">{{ $t('audit.clearApproval') }}</el-button>
        </div>
        <el-table :data="selectedGroup.items" row-key="id" height="390">
          <el-table-column :label="$t('audit.keep')" width="64" align="center"><template #default="scope"><el-radio v-model="draftKeepId" :value="scope.row.id" :disabled="reviewLocked || selectedGroup.actionable === false" /></template></el-table-column>
          <el-table-column :label="$t('audit.quarantine')" width="88" align="center"><template #default="scope"><el-checkbox v-model="draftQuarantineIds" :value="scope.row.id" :disabled="reviewLocked || selectedGroup.actionable === false || draftKeepId === scope.row.id" /></template></el-table-column>
          <el-table-column prop="title" :label="$t('audit.titleColumn')" min-width="180" show-overflow-tooltip />
          <el-table-column prop="filepath" :label="$t('audit.filepath')" min-width="340" show-overflow-tooltip />
          <el-table-column prop="url" label="URL" min-width="210" show-overflow-tooltip />
        </el-table>
        <pre class="evidence-block">{{ JSON.stringify(selectedGroup.evidence || {}, null, 2) }}</pre>
        <div v-if="selectedGroup.actionable !== false" class="drawer-footer"><el-button type="primary" :disabled="reviewLocked" @click="applyDraft">{{ $t('audit.approveSelection') }}</el-button></div>
      </template>
    </el-drawer>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { Search, Select, VideoPlay } from '@element-plus/icons-vue'

const props = defineProps({
  report: { type: Object, default: null },
  state: { type: Object, required: true },
  busy: Boolean,
  reviewLocked: Boolean,
  selections: { type: Object, default: () => ({}) }
})
const emit = defineEmits(['start', 'update:selections'])
const { t, te } = useI18n()
const forceContent = ref(false)
const searchInput = ref('')
const search = ref('')
const kindFilter = ref('')
const page = ref(1)
const pageSize = ref(50)
const pageSizes = [50, 100, 200, 500]
const drawer = ref(false)
const selectedGroup = ref(null)
const draftKeepId = ref(null)
const draftQuarantineIds = ref([])
let searchTimer

const running = computed(() => ['running', 'cancelling'].includes(props.state.status))
const lastRunText = computed(() => props.state.completedAt ? t('audit.lastCheckedAt', { time: new Date(props.state.completedAt).toLocaleString() }) : t('audit.neverChecked'))
const kinds = computed(() => [...new Set((props.report?.groups || []).map(item => item.kind))].sort())
const searchIndex = computed(() => new Map((props.report?.groups || []).map(item => [item.id, normalizeSearchText(`${item.kind} ${auditTypeLabel(item.kind)} ${(item.items || []).map(book => `${book.title} ${book.filepath}`).join(' ')}`)])))
const filteredGroups = computed(() => (props.report?.groups || []).filter(item => (!kindFilter.value || item.kind === kindFilter.value) && (!search.value || (searchIndex.value.get(item.id) || '').includes(search.value))))
const pagedGroups = computed(() => filteredGroups.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))

const normalizeSearchText = value => String(value || '').trim().toLocaleLowerCase()
const auditTypeLabel = value => { const key = `audit.type_${value}`; return value && te(key) ? t(key) : value || '' }
const formatBytes = value => {
  let size = Number(value || 0)
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let index = 0
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1 }
  return `${size.toFixed(index === 0 ? 0 : 2)} ${units[index]}`
}
const openGroup = row => {
  selectedGroup.value = row
  const saved = props.selections[row.id]
  draftKeepId.value = saved?.keepId || row.suggestedKeepId
  draftQuarantineIds.value = [...(saved?.quarantineIds || [])]
  drawer.value = true
}
const useSuggestion = () => {
  draftKeepId.value = selectedGroup.value.suggestedKeepId
  draftQuarantineIds.value = selectedGroup.value.items.filter(item => item.id !== draftKeepId.value).map(item => item.id)
}
const clearSelection = () => {
  const next = { ...props.selections }
  delete next[selectedGroup.value.id]
  draftQuarantineIds.value = []
  emit('update:selections', next)
}
const applyDraft = () => {
  if (!draftKeepId.value || draftQuarantineIds.value.length === 0) return ElMessage.warning(t('audit.invalidSelection'))
  emit('update:selections', {
    ...props.selections,
    [selectedGroup.value.id]: {
      keepId: draftKeepId.value,
      quarantineIds: draftQuarantineIds.value.filter(id => id !== draftKeepId.value)
    }
  })
  drawer.value = false
}

watch(searchInput, value => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { search.value = normalizeSearchText(value); page.value = 1 }, 140) })
watch(kindFilter, () => { page.value = 1 })
watch([() => filteredGroups.value.length, pageSize], ([total, size]) => { page.value = Math.min(page.value, Math.max(1, Math.ceil(total / size))) })
</script>

<style scoped>
.task-panel { min-height: 0; height: 100%; display: flex; flex-direction: column; }.task-toolbar { flex: 0 0 auto; min-height: 48px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 8px 0; }.task-toolbar-main { display: flex; align-items: center; gap: 12px; }.last-run { color: var(--el-text-color-secondary); font-size: 12px; }
.summary-band { flex: 0 0 auto; display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); border: 1px solid var(--el-border-color); border-radius: 4px; margin: 8px 0 12px; }.summary-band div { padding: 9px 14px; border-right: 1px solid var(--el-border-color); }.summary-band strong, .summary-band span { display: block; }.summary-band strong { font-size: 18px; }.summary-band span { margin-top: 3px; color: var(--el-text-color-secondary); font-size: 12px; }
.filter-row { flex: 0 0 auto; display: grid; grid-template-columns: minmax(280px, 1fr) 260px; gap: 12px; margin: 10px 0 8px; }.audit-table-region { flex: 1 1 auto; min-height: 220px; }.table-pagination { flex: 0 0 auto; justify-content: flex-end; padding-top: 8px; }
.duplicate-editor-actions { display: flex; gap: 8px; margin: 12px 0; }.evidence-block { padding: 14px; overflow: auto; white-space: pre-wrap; word-break: break-all; background: var(--el-fill-color-light); border: 1px solid var(--el-border-color); }.drawer-footer { display: flex; justify-content: flex-end; margin-top: 16px; }
@media (max-width: 900px) { .task-toolbar, .task-toolbar-main { align-items: flex-start; flex-wrap: wrap; }.filter-row { grid-template-columns: 1fr; } }
</style>

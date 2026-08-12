<template>
  <section class="approval-panel">
    <div class="approval-summary">
      <div><span>{{ $t('audit.approvedRepairs') }}</span><strong>{{ anomalyReview.actionIds.length }}</strong><small>{{ anomalyReportLabel }}</small></div>
      <div><span>{{ $t('audit.approvedDuplicateGroups') }}</span><strong>{{ Object.keys(dedupeReview.selections).length }}</strong><small>{{ dedupeReportLabel }}</small></div>
      <div><span>{{ $t('audit.approvedQuarantineFiles') }}</span><strong>{{ quarantineFileCount }}</strong><small>{{ formatBytes(approvedPotentialBytes) }}</small></div>
    </div>
    <div class="path-line">
      <el-input :model-value="quarantineRoot" :disabled="busy" @update:model-value="$emit('update:quarantineRoot', $event)">
        <template #prepend>{{ $t('audit.quarantinePath') }}</template>
      </el-input>
      <el-tooltip :content="$t('audit.chooseFolder')"><el-button :icon="FolderOpened" :disabled="busy" @click="$emit('select-quarantine')" /></el-tooltip>
    </div>
    <el-alert type="warning" :closable="false" show-icon :title="$t('audit.executionWarning')" />
    <el-alert v-if="legacyApproval" type="error" :closable="false" show-icon :title="$t('audit.legacyApprovalBlocked')" />
    <div class="approval-actions">
      <el-button :icon="DocumentChecked" :disabled="busy" @click="$emit('save')">{{ $t('audit.saveReview') }}</el-button>
      <el-button type="danger" :icon="Select" :disabled="busy || approvedCount === 0 || legacyApproval" @click="$emit('execute')">{{ $t('audit.executeApproved') }}</el-button>
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { DocumentChecked, FolderOpened, Select } from '@element-plus/icons-vue'

const props = defineProps({
  anomalyReport: { type: Object, default: null },
  anomalyReview: { type: Object, required: true },
  dedupeReport: { type: Object, default: null },
  dedupeReview: { type: Object, required: true },
  quarantineRoot: { type: String, required: true },
  busy: Boolean
})
defineEmits(['save', 'execute', 'select-quarantine', 'update:quarantineRoot'])
const { t } = useI18n()
const approvedCount = computed(() => props.anomalyReview.actionIds.length + Object.keys(props.dedupeReview.selections).length)
const quarantineFileCount = computed(() => Object.values(props.dedupeReview.selections).reduce((sum, selection) => sum + (selection.quarantineIds || []).length, 0))
const approvedPotentialBytes = computed(() => Object.entries(props.dedupeReview.selections).reduce((sum, [groupId, selection]) => {
  const group = props.dedupeReport?.groups?.find(item => item.id === groupId)
  if (!group) return sum
  const ids = new Set(selection.quarantineIds || [])
  return sum + group.items.filter(item => ids.has(item.id)).reduce((groupSum, item) => groupSum + Number(item.size || 0), 0)
}, 0))
const legacyApproval = computed(() => (props.anomalyReview.actionIds.length > 0 && props.anomalyReport?.executable === false) || (Object.keys(props.dedupeReview.selections).length > 0 && props.dedupeReport?.executable === false))
const anomalyReportLabel = computed(() => props.anomalyReport ? t('audit.reportCreatedAt', { time: new Date(props.anomalyReport.createdAt).toLocaleString() }) : t('audit.noReport'))
const dedupeReportLabel = computed(() => props.dedupeReport ? t('audit.reportCreatedAt', { time: new Date(props.dedupeReport.createdAt).toLocaleString() }) : t('audit.noReport'))
const formatBytes = value => {
  let size = Number(value || 0)
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let index = 0
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1 }
  return `${size.toFixed(index === 0 ? 0 : 2)} ${units[index]}`
}
</script>

<style scoped>
.approval-panel { max-width: 920px; padding: 18px 0; }.approval-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border: 1px solid var(--el-border-color); border-radius: 4px; }.approval-summary div { min-width: 0; padding: 14px 18px; border-right: 1px solid var(--el-border-color); }.approval-summary div:last-child { border-right: 0; }.approval-summary span, .approval-summary strong, .approval-summary small { display: block; }.approval-summary strong { margin: 4px 0; font-size: 24px; }.approval-summary small { overflow: hidden; color: var(--el-text-color-secondary); text-overflow: ellipsis; white-space: nowrap; }.path-line { display: grid; grid-template-columns: minmax(0, 1fr) 40px; gap: 8px; margin: 18px 0 12px; }.approval-actions { display: flex; gap: 10px; margin-top: 18px; }
@media (max-width: 760px) { .approval-summary { grid-template-columns: 1fr; }.approval-summary div { border-right: 0; border-bottom: 1px solid var(--el-border-color); } }
</style>

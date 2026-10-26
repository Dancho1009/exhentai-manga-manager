<template>
  <el-dialog
    :model-value="modelValue"
    :title="dialogTitle"
    :width="preview?.taskType === 'dedupe' ? '90%' : '620px'"
    :close-on-click-modal="false"
    :close-on-press-escape="!submitting"
    :show-close="!submitting"
    @update:model-value="$emit('update:modelValue', $event)"
    @closed="riskConfirmed = false"
  >
    <el-alert type="warning" :closable="false" show-icon :title="warningText" />

    <el-descriptions v-if="preview" class="execution-preview" :column="1" border>
      <template v-if="preview.taskType === 'anomaly'">
        <el-descriptions-item :label="$t('audit.approvedRepairs')">{{ preview.selectedCount }}</el-descriptions-item>
        <el-descriptions-item :label="$t('audit.sameIdentitySwitches')">{{ preview.sameIdentityCount }}</el-descriptions-item>
        <el-descriptions-item :label="$t('audit.versionUpgrades')">{{ preview.versionUpgradeCount || 0 }}</el-descriptions-item>
        <el-descriptions-item :label="$t('audit.sourceRecoveries')">{{ preview.sourceRecoveryCount || 0 }}</el-descriptions-item>
        <el-descriptions-item :label="$t('audit.ehviewerRebuilds')">{{ preview.ehviewerRebuildCount || 0 }}</el-descriptions-item>
        <el-descriptions-item :label="$t('audit.localScanRepairs')">{{ preview.localScanCount || 0 }}</el-descriptions-item>
        <el-descriptions-item :label="$t('audit.orphanMetadataCount')">{{ preview.orphanMetadataCount || 0 }}</el-descriptions-item>
        <el-descriptions-item :label="$t('audit.identityReplacements')">{{ preview.identityReplacementCount }}</el-descriptions-item>
      </template>
      <template v-else>
        <el-descriptions-item :label="$t('audit.approvedDuplicateGroups')">{{ preview.selectedGroupCount }}</el-descriptions-item>
        <el-descriptions-item :label="$t('audit.approvedQuarantineFiles')">{{ preview.quarantineFileCount }}</el-descriptions-item>
        <el-descriptions-item :label="$t('audit.approvedRecordOnly')">{{ preview.recordOnlyCount || 0 }}</el-descriptions-item>
        <el-descriptions-item :label="$t('audit.approvedPotentialSpace')">{{ formatBytes(preview.potentialBytes) }}</el-descriptions-item>
        <el-descriptions-item :label="$t('audit.quarantinePath')">{{ preview.quarantineRoot }}</el-descriptions-item>
        <el-descriptions-item :label="$t('audit.manualReviewGroups')">{{ preview.manualReviewGroupCount }}</el-descriptions-item>
      </template>
    </el-descriptions>
    <template v-if="preview?.taskType === 'dedupe'">
      <div class="quarantine-choice"><el-button :disabled="submitting" @click="$emit('select-quarantine')">{{ $t('audit.chooseFolder') }}</el-button><span>{{ $t('audit.dedupeReview.quarantineNote') }}</span></div>
      <p>{{ $t('audit.dedupeReview.mergeRule') }}</p>
      <el-table :data="preview.files || []" max-height="370" class="execution-files">
        <el-table-column :label="$t('audit.dedupeReview.quarantineFile')" min-width="200"><template #default="{ row }"><strong>{{ row.title }}</strong><p>{{ row.source }}</p></template></el-table-column>
        <el-table-column :label="$t('audit.dedupeReview.mergeTarget')" min-width="180"><template #default="{ row }"><template v-if="row.keepId"><strong>{{ row.keepTitle }}</strong><p>{{ row.keepPath }}</p></template><span v-else>{{ $t('audit.dedupeReview.noMergeTarget') }}</span></template></el-table-column>
        <el-table-column :label="$t('audit.dedupeReview.target')" min-width="210"><template #default="{ row }"><strong>{{ $t('audit.dedupeReview.mode_' + row.mode) }}</strong><p v-if="row.target">{{ row.target }}</p><span v-if="row.mode === 'move' || row.mode === 'split-folder'">{{ formatBytes(row.size) }}</span></template></el-table-column>
        <el-table-column :label="$t('audit.dedupeReview.impact')" min-width="220"><template #default="{ row }"><p v-if="row.reason">{{ row.reason }}</p><p v-if="!row.equivalent && row.referenceTitle">{{ $t('audit.dedupeReview.comparisonReference', { title: row.referenceTitle }) }}</p><p v-if="row.verified">{{ $t('audit.dedupeReview.comparisonImpact', { matched: row.matchedPages, keep: row.keepPages, removed: row.removedPages }) }}</p><p v-else>{{ $t('audit.dedupeReview.comparisonUnavailable') }}</p><p v-if="row.verified">{{ $t('audit.dedupeReview.uniquePageImpact', { count: row.uniquePages }) }}</p><p v-if="row.verified">{{ $t('audit.dedupeReview.keepUniqueImpact', { count: row.keepUniquePages }) }}</p><p v-for="entry in row.ancillaryLoss || []" :key="entry.path">{{ entry.path }} · {{ entry.status }}</p><p v-if="row.uncoveredEntries?.length">{{ $t('audit.dedupeReview.uncovered', { count: row.uncoveredEntries.length }) }}</p><p v-if="row.collectionTitles?.length">{{ row.collectionTitles.join('、') }} · {{ $t('audit.dedupeReview.collection_' + row.collectionAction) }}</p><p v-if="row.mergedReadCount !== undefined">{{ $t('audit.dedupeReview.reading') }}: {{ row.mergedReadCount }} · {{ $t('audit.dedupeReview.' + (row.mergedMark ? 'marked' : 'unmarked')) }}</p></template></el-table-column>
      </el-table>
    </template>

    <el-checkbox v-if="requiresRiskConfirmation" v-model="riskConfirmed" class="risk-confirmation">
      {{ riskConfirmationText }}
    </el-checkbox>

    <template #footer>
      <el-button :disabled="submitting" @click="$emit('update:modelValue', false)">{{ $t('c.cancel') }}</el-button>
      <el-button type="danger" :loading="submitting" :disabled="requiresRiskConfirmation && !riskConfirmed" @click="$emit('confirm')">
        {{ confirmLabel }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({
  modelValue: Boolean,
  preview: { type: Object, default: null },
  submitting: Boolean
})
defineEmits(['update:modelValue', 'confirm', 'select-quarantine'])
const { t } = useI18n()
const riskConfirmed = ref(false)

const dialogTitle = computed(() => props.preview?.taskType === 'dedupe'
  ? t('audit.confirmDedupeTitle')
  : t('audit.confirmAnomalyTitle'))
const warningText = computed(() => props.preview?.taskType === 'dedupe'
  ? t('audit.confirmDedupeWarning')
  : Number(props.preview?.orphanMetadataCount || 0) > 0
    ? t('audit.confirmAnomalyMetadataWarning', { count: props.preview.orphanMetadataCount })
  : t('audit.confirmAnomalyWarning'))
const confirmLabel = computed(() => props.preview?.taskType === 'dedupe'
  ? t('audit.executeDedupeQuarantine')
  : t('audit.executeAnomalyRepairs'))
const requiresRiskConfirmation = computed(() => props.preview?.taskType === 'anomaly'
  ? Number(props.preview?.identityReplacementCount || 0) > 0 || Number(props.preview?.orphanMetadataCount || 0) > 0
  : Number(props.preview?.manualReviewGroupCount || 0) > 0)
const riskConfirmationText = computed(() => props.preview?.taskType === 'anomaly'
  ? Number(props.preview?.orphanMetadataCount || 0) > 0
    ? t('audit.confirmAnomalyRisk', {
        orphan: props.preview.orphanMetadataCount,
        identity: props.preview.identityReplacementCount || 0
      })
    : t('audit.confirmIdentityReplacement')
  : t('audit.confirmManualDedupe'))

const formatBytes = value => {
  let size = Number(value || 0)
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let index = 0
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1 }
  return `${size.toFixed(index === 0 ? 0 : 2)} ${units[index]}`
}
</script>

<style scoped>
.execution-preview { margin-top: 16px; }
.execution-preview :deep(.el-descriptions__label) { width: 180px; }
.risk-confirmation { height: auto; margin-top: 16px; white-space: normal; }
.quarantine-choice { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-top: 14px; font-size: 12px; color: var(--el-text-color-secondary); }
.execution-files p { margin: 5px 0; overflow-wrap: anywhere; font-size: 12px; }
</style>

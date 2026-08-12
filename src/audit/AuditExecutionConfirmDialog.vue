<template>
  <el-dialog
    :model-value="modelValue"
    :title="dialogTitle"
    width="620px"
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
        <el-descriptions-item :label="$t('audit.identityReplacements')">{{ preview.identityReplacementCount }}</el-descriptions-item>
      </template>
      <template v-else>
        <el-descriptions-item :label="$t('audit.approvedDuplicateGroups')">{{ preview.selectedGroupCount }}</el-descriptions-item>
        <el-descriptions-item :label="$t('audit.approvedQuarantineFiles')">{{ preview.quarantineFileCount }}</el-descriptions-item>
        <el-descriptions-item :label="$t('audit.approvedPotentialSpace')">{{ formatBytes(preview.potentialBytes) }}</el-descriptions-item>
        <el-descriptions-item :label="$t('audit.quarantinePath')">{{ preview.quarantineRoot }}</el-descriptions-item>
        <el-descriptions-item :label="$t('audit.manualReviewGroups')">{{ preview.manualReviewGroupCount }}</el-descriptions-item>
      </template>
    </el-descriptions>

    <el-checkbox v-if="requiresRiskConfirmation" v-model="riskConfirmed" class="risk-confirmation">
      {{ riskConfirmationText }}
    </el-checkbox>

    <template #footer>
      <el-button :disabled="submitting" @click="$emit('update:modelValue', false)">{{ $t('m.cancel') }}</el-button>
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
defineEmits(['update:modelValue', 'confirm'])
const { t } = useI18n()
const riskConfirmed = ref(false)

const dialogTitle = computed(() => props.preview?.taskType === 'dedupe'
  ? t('audit.confirmDedupeTitle')
  : t('audit.confirmAnomalyTitle'))
const warningText = computed(() => props.preview?.taskType === 'dedupe'
  ? t('audit.confirmDedupeWarning')
  : t('audit.confirmAnomalyWarning'))
const confirmLabel = computed(() => props.preview?.taskType === 'dedupe'
  ? t('audit.executeDedupeQuarantine')
  : t('audit.executeAnomalyRepairs'))
const requiresRiskConfirmation = computed(() => props.preview?.taskType === 'anomaly'
  ? Number(props.preview?.identityReplacementCount || 0) > 0
  : Number(props.preview?.manualReviewGroupCount || 0) > 0)
const riskConfirmationText = computed(() => props.preview?.taskType === 'anomaly'
  ? t('audit.confirmIdentityReplacement')
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
</style>

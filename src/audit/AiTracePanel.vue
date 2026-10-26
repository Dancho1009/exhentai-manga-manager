<template>
  <section v-if="api && (run || batches.length)" class="ai-trace-panel">
    <div class="trace-heading"><strong>{{ t('aiTrace.title') }}</strong><el-button size="small" @click="api.open({runId})">{{ t('aiTrace.open') }}</el-button></div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <div v-if="run" class="trace-summary">
      <span>{{ t(`aiTrace.phase_${run.phase || 'preparing'}`) }} · {{ t(`aiTrace.status_${run.partial && run.status === 'completed' ? 'partial' : run.status}`) }}</span>
      <span>{{ t('aiTrace.totalBooks') }} <b>{{ run.totalBooks ?? '—' }}</b></span>
      <template v-if="run.task !== 'dedupe'">
      <span>{{ t('aiTrace.cached') }} <b>{{ run.cachedBooks || 0 }}</b></span>
      <span>{{ t('aiTrace.saved') }} <b>{{ run.savedBooks || 0 }}</b></span>
      <span>{{ t('aiTrace.firstPassSaved') }} <b>{{ run.normalizationFirstPassSaved ?? '—' }}</b></span>
      <span>{{ t('aiTrace.retrySaved') }} <b>{{ run.normalizationRetrySaved ?? '—' }}</b></span>
      <span>{{ t('aiTrace.retryPending') }} <b>{{ run.normalizationRetryPending ?? '—' }}</b></span>
      <span>{{ t('aiTrace.failedBooks') }} <b>{{ run.failedBooks || 0 }}</b></span>
      <span>{{ t('aiTrace.missing') }} <b>{{ run.missingBooks || 0 }}</b></span>
      <span>{{ t('aiTrace.notRequested') }} <b>{{ Math.max(0,(run.totalBooks || 0)-(run.cachedBooks || 0)-(run.normalizationSubmitted || 0)) }}</b></span>
      </template>
      <span>{{ t('aiTrace.pairsCompleted') }} {{ run.classificationSucceeded || 0 }}/{{ run.candidateCount || 0 }}</span>
      <span>{{ t('aiTrace.pairsFailed') }} {{ run.classificationFailed || 0 }}</span>
      <span>{{ t('aiTrace.pairsMissing') }} {{ run.classificationMissing || 0 }}</span>
      <span>{{ t('aiTrace.httpAttempts') }} {{ attempts.length }}</span>
      <span>{{ t('aiTrace.tokens') }} {{ knownUsage || (unknownUsage ? t('aiTrace.unknown') : 0) }} {{ unknownUsage && knownUsage ? ` · ${t('aiTrace.plusUnknown')}` : '' }}</span>
      <span v-if="run.verificationTotal">{{ t('aiTrace.verification') }} {{ run.verifiedCount || 0 }}/{{ run.verificationTotal }}</span>
      <span v-if="run.queueGroups !== undefined">{{ t('aiTrace.queueGroups') }} {{ run.queueGroups }}</span>
      <span>{{ t('aiTrace.concurrency') }} {{ activeCount }}/{{ run.concurrency || '—' }}</span>
      <span>{{ run.force ? t('aiTrace.force') : t('aiTrace.reuse') }}</span>
    </div>
    <ai-batch-list :batches="batches" @select="row => api.open({runId:row.runId,batchId:row.batchId})" />
  </section>
</template>
<script setup>
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAiTrace, activeStatuses } from './aiTrace.mjs'
import AiBatchList from './AiBatchList.vue'
const api = window.auditApi?.aiTrace
const emit = defineEmits(['logs'])
const { t } = useI18n()
const { runId, run, batches, logs, error } = useAiTrace(api)
const activeCount = computed(() => batches.value.filter(batch => activeStatuses.has(batch.status)).length)
const attempts = computed(() => batches.value.flatMap(batch => batch.attempts || []))
const knownUsage = computed(() => attempts.value.reduce((sum,attempt) => sum + (attempt.usage?.total_tokens || 0),0))
const unknownUsage = computed(() => attempts.value.some(attempt => attempt.usage?.total_tokens == null))
watch(logs, value => emit('logs', value), { immediate:true })
</script>
<style scoped>
.ai-trace-panel { border-bottom:1px solid var(--el-border-color);padding:12px 0 }
.trace-heading { display:flex;justify-content:space-between;align-items:center }
.trace-summary { display:flex;gap:14px;flex-wrap:wrap;margin-top:12px;font-size:13px }
</style>

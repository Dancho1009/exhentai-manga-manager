<template>
  <el-config-provider :locale="elementLocale">
  <main class="inspector-shell">
    <header><h2>{{ t('aiTrace.open') }}</h2><el-select v-model="selectedRun" :placeholder="t('aiTrace.run')" style="width:330px" @change="changeRun"><el-option v-for="item in runs" :key="item.runId" :value="item.runId" :label="`${formatBeijingLogTime(item.startedAt)} · ${t(`aiTrace.status_${item.partial && item.status === 'completed' ? 'partial' : item.status}`)}`" /></el-select><small>{{ t('aiTrace.beijing') }}</small></header>
    <el-alert v-if="error || localError" :title="error || localError" type="error" :closable="false" />
    <div class="inspector-body">
      <aside><ai-batch-list :batches="batches" compact height="calc(100vh - 235px)" @select="selectBatch" /></aside>
      <section class="request-detail">
        <el-empty v-if="!selected" :description="t('aiTrace.choose')" />
        <template v-else>
          <div class="detail-heading"><strong>#{{ selected.batchIndex }}/{{ selected.batchTotal }} · {{ t(`aiTrace.phase_${selected.phase}`) }}</strong><el-tag disable-transitions :type="selected.status === 'failed' ? 'danger' : 'info'">{{ t(`aiTrace.status_${selected.status}`) }}</el-tag><el-select v-if="selected.attempts?.length" v-model="attemptNumber" size="small" style="width:180px" @change="resetText"><el-option v-for="item in selected.attempts" :key="item.attempt" :value="item.attempt" :label="`${t('aiTrace.attempt')} ${item.attempt} · HTTP ${item.httpStatus || '—'}`" /></el-select></div>
          <p v-if="selected.errorCode" :class="selected.status === 'recovered' ? 'request-note' : 'request-error'"><span v-if="selected.status === 'recovered'">{{ t('aiTrace.initialError') }} · </span>{{ selected.errorCode }}<span v-if="selected.errorDetail"> · {{ selected.errorDetail.reason }} · {{ selected.errorDetail.path }}</span></p>
          <p v-if="selected.recoverySavedCount !== undefined" class="request-note">{{ t('aiTrace.retrySaved') }} {{ selected.recoverySavedCount }} · {{ t('aiTrace.unresolved') }} {{ selected.unresolvedCount }}</p>
          <p v-if="attempt?.truncationReason" class="request-note">{{ t('aiTrace.truncation_' + attempt.truncationReason) }}</p>
          <p v-if="attempt?.thinkingControlMismatch || selected.thinkingMode === 'disabled' && ((attempt?.reasoningBytes || 0) > 0 || (attempt?.usage?.completion_tokens_details?.reasoning_tokens || 0) > 0)" class="request-note">{{ t('aiTrace.thinkingControlMismatch') }}</p>
          <p v-if="selected.recoverySizes?.length" class="request-note">{{ t('aiTrace.splitInto') }} {{ selected.recoverySizes.join(' + ') }} · {{ t('aiTrace.recoveryReason') }} {{ selected.truncationReason || selected.recoveryReason }}</p>
          <p v-if="attempt?.limitKind" class="request-error">{{ t('aiTrace.clientLimit') }} · {{ attempt.limitKind }} · {{ bytesText(attempt.receivedBytes) }} ({{ attempt.receivedBytes }} B) / {{ bytesText(attempt.limitBytes) }} ({{ attempt.limitBytes }} B)</p>
          <p v-if="selected.status === 'cached'" class="request-note">{{ t('aiTrace.cacheNote') }}</p>
          <p v-else-if="attempt?.complete === false" class="request-note">{{ t('aiTrace.incomplete') }}</p>
          <p v-if="selected.attempts?.length" class="request-tps" :title="t('aiTrace.tpsHelp')">{{ t('aiTrace.tps') }} <strong>{{ tpsText(attempt, t) }}</strong> · {{ t('aiTrace.tpsHelp') }}</p>
          <el-tabs v-model="tab" @tab-change="resetText">
            <el-tab-pane :label="t('aiTrace.messages')" name="messages" />
            <el-tab-pane :label="t('aiTrace.raw')" name="raw" />
            <el-tab-pane :label="t('aiTrace.parsed')" name="parsed" />
            <el-tab-pane :label="t('aiTrace.meta')" name="meta" />
          </el-tabs>
          <div v-if="tab === 'meta'" class="metadata">
            <dl><template v-for="[key,value] in metadata" :key="key"><dt>{{ key }}</dt><dd>{{ value }}</dd></template></dl>
            <details><summary>{{ t('aiTrace.metaJson') }}</summary><pre>{{ JSON.stringify({run, batch:selected},null,2) }}</pre></details>
          </div>
          <template v-else>
            <div class="text-toolbar">
              <el-radio-group v-if="tab === 'raw'" v-model="rawKind" size="small" @change="resetText"><el-radio-button value="content">{{ t('aiTrace.content') }}</el-radio-button><el-radio-button value="reasoning">{{ t('aiTrace.reasoning') }}</el-radio-button><el-radio-button value="sse">SSE</el-radio-button></el-radio-group>
              <el-radio-group v-if="tab === 'parsed'" v-model="parsedKind" size="small" @change="resetText"><el-radio-button value="parsed">JSON</el-radio-button><el-radio-button value="validation">{{ t('aiTrace.validation') }}</el-radio-button></el-radio-group>
              <el-input v-model="search" size="small" :placeholder="t('aiTrace.find')" style="width:180px" @keyup.enter="findText" />
              <el-button size="small" @click="findText">{{ t('aiTrace.find') }}</el-button>
              <el-button size="small" @click="copyText">{{ t('aiTrace.copy') }}</el-button>
              <el-button size="small" :disabled="!attempt" @click="exportText">{{ t('aiTrace.export') }}</el-button>
              <el-checkbox v-model="follow">{{ t('aiTrace.follow') }}</el-checkbox>
            </div>
            <textarea ref="viewer" class="raw-viewer" readonly :value="text" :aria-label="t('aiTrace.raw')" spellcheck="false" />
            <div class="text-footer"><span>{{ bytesText(textInfo.nextOffset) }} / {{ bytesText(textInfo.totalBytes) }} · {{ t('aiTrace.previewNote') }}</span><el-button v-if="textInfo.hasMore" size="small" @click="loadMore">{{ t('aiTrace.loadMore') }}</el-button><span v-if="!text">{{ t('aiTrace.noText') }}</span></div>
          </template>
        </template>
      </section>
    </div>
  </main>
  </el-config-provider>
</template>
<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import zhCN from 'element-plus/es/locale/lang/zh-cn'
import zhTW from 'element-plus/es/locale/lang/zh-tw'
import enUS from 'element-plus/es/locale/lang/en'
import AiBatchList from './audit/AiBatchList.vue'
import { useAiTrace, bytesText, formatBeijingLogTime, tpsText } from './audit/aiTrace.mjs'
const props = defineProps({initialSelection:{type:Object,default:() => ({})}})
const api = window.aiTraceApi
const { t, locale } = useI18n()
const elementLocale = computed(() => ({'zh-CN':zhCN,'zh-TW':zhTW,'en-US':enUS})[locale.value] || zhCN)
const {runId,runs,run,batches,error,refresh} = useAiTrace(api, {followLatest:false})
const selectedRun = ref(props.initialSelection.runId || ''), batchId = ref(props.initialSelection.batchId || ''), attemptNumber = ref(1)
const tab = ref('messages'), rawKind = ref('content'), parsedKind = ref('parsed'), search = ref(''), follow = ref(true)
const text = ref(''), textInfo = ref({nextOffset:0,totalBytes:0,hasMore:false}), viewer = ref(null), localError = ref('')
let removeSelect, timer, textRevision = 0, loading = false
const selected = computed(() => batches.value.find(batch => batch.batchId === batchId.value))
const attempt = computed(() => selected.value?.attempts?.find(item => item.attempt === attemptNumber.value))
const kind = computed(() => tab.value === 'raw' ? rawKind.value : tab.value === 'parsed' ? parsedKind.value : 'messages')
const request = () => ({runId:runId.value,batchId:batchId.value,requestId:selected.value?.requestId,attempt:attemptNumber.value,kind:kind.value})
const loadMore = async (revision = textRevision) => {
  if (!attempt.value || tab.value === 'meta' || loading) return
  loading = true
  try {
    const result = await api.readText({...request(),offset:textInfo.value.nextOffset,limit:65536})
    if (revision !== textRevision) return
    text.value += result.text
    textInfo.value = result
    await nextTick()
    if (follow.value && viewer.value) viewer.value.scrollTop = viewer.value.scrollHeight
  } catch (value) { localError.value = String(value.message || value) }
  finally { loading = false }
}
const resetText = async () => { const revision = ++textRevision; text.value = ''; textInfo.value = {nextOffset:0,totalBytes:0,hasMore:false}; loading = false; await loadMore(revision) }
const selectBatch = row => { batchId.value = row.batchId; attemptNumber.value = row.attempts?.at(-1)?.attempt || 1; void resetText() }
const changeRun = async value => { batchId.value = ''; await refresh(value); if(batches.value.length) selectBatch(batches.value[0]) }
watch(runId,value => { selectedRun.value = value })
watch(batches, value => { if (!selected.value && value.length) selectBatch(value.find(item => item.batchId === batchId.value) || value.find(item => item.attempts?.length) || value[0]) })
watch(() => selected.value?.attempts?.length, () => { if (selected.value?.attempts?.length) { attemptNumber.value = selected.value.attempts.at(-1).attempt; void resetText() } })
const metadata = computed(() => {
  const row = selected.value || {}, a = attempt.value || {}
  const span = (end,start) => end && start ? `${Date.parse(end)-Date.parse(start)} ms` : '—'
  return [[t('aiTrace.run'),runId.value],[t('aiTrace.batch'),row.batchId],['requestId',row.requestId ?? '—'],[t('aiTrace.attempt'),a.attempt ?? '—'],
    [t('aiTrace.model'),a.model || run.value?.model || '—'],[t('aiTrace.endpoint'),a.endpoint || '—'],[t('aiTrace.status'),t(`aiTrace.status_${row.status}`)],['HTTP',a.httpStatus ?? '—'],
    [t('aiTrace.startedAt'),formatBeijingLogTime(a.startedAt)],[t('aiTrace.firstByte'),formatBeijingLogTime(a.firstByteAt)],[t('aiTrace.firstContent'),formatBeijingLogTime(a.firstContentAt)],
    [t('aiTrace.lastByte'),formatBeijingLogTime(a.lastByteAt)],[t('aiTrace.finishedAt'),formatBeijingLogTime(a.completedAt)],[t('aiTrace.firstByteDuration'),span(a.firstByteAt,a.startedAt)],
    [t('aiTrace.timeout'),`${row.timeoutMs || '—'} ms · ${row.timeoutMode || '—'}`],[t('aiTrace.stream'),String(row.stream ?? '—')],
    [t('ai.compatibleReasoningProtocol'),row.reasoningProtocol || t('aiTrace.unknown')],
    [t('ai.compatibleThinkingMode'),row.thinkingMode ? t('ai.thinking_' + row.thinkingMode) : t('aiTrace.unknown')],
    [t('ai.reasoningEffort'),row.reasoningEffort || (row.thinkingMode ? t('aiTrace.notSent') : t('aiTrace.unknown'))],
    [t('ai.maxOutputTokens'),Object.hasOwn(row,'maxOutputTokens') ? row.maxOutputTokens ?? t('ai.thinking_inherit') : t('aiTrace.unknown')],
    [t('ai.outputTokenField'),row.maxOutputTokens ? row.outputTokenField : row.thinkingMode ? t('aiTrace.notSent') : t('aiTrace.unknown')],
    ['finish_reason',a.finishReason || t('aiTrace.unknown')],
    ['requestParameter',a.requestParameter || '—'],
    [t('aiTrace.recoveryParent'),row.recoveryOf || '—'],
    [t('aiTrace.received'),bytesText(a.streamBytes)],[t('aiTrace.content'),bytesText(a.contentBytes)],[t('aiTrace.reasoning'),bytesText(a.reasoningBytes)],
    [t('aiTrace.inputTokens'),a.usage?.prompt_tokens ?? t('aiTrace.unknown')],[t('aiTrace.outputTokens'),a.usage?.completion_tokens ?? t('aiTrace.unknown')],[t('aiTrace.totalTokens'),a.usage?.total_tokens ?? t('aiTrace.unknown')],
    [t('aiTrace.reasoningTokens'),a.usage?.completion_tokens_details?.reasoning_tokens ?? t('aiTrace.unknown')],
    [t('aiTrace.tps'),tpsText(attempt.value, t)],
    [t('aiTrace.tpsDuration'),Number.isFinite(a.tpsDurationMs) ? `${a.tpsDurationMs} ms` : t('aiTrace.unknown')],
    [t('aiTrace.counts'),`${row.bookCount ?? 0} / ${row.returnedCount ?? '—'} / ${row.savedCount || 0}`],[t('aiTrace.error'),row.errorCode || '—']]
})
const findText = () => { const el = viewer.value; if (!el || !search.value) return; let index=text.value.indexOf(search.value,el.selectionEnd); if(index<0) index=text.value.indexOf(search.value); if(index>=0) {el.focus();el.setSelectionRange(index,index+search.value.length)} }
const copyText = async () => { try { await navigator.clipboard.writeText(text.value); ElMessage.success(t('aiTrace.copied')) } catch(value){localError.value=String(value.message||value)} }
const exportText = async () => { try { await api.export(request()) } catch(value){localError.value=String(value.message||value)} }
onMounted(() => {
  if (props.initialSelection.runId) void refresh(props.initialSelection.runId)
  removeSelect = api.onSelect(async value => { if(value.runId) await refresh(value.runId); if(value.batchId) batchId.value=value.batchId; attemptNumber.value=selected.value?.attempts?.at(-1)?.attempt || 1; await resetText() })
  timer = setInterval(() => { if (follow.value && tab.value !== 'meta' && text.value.length < 256*1024) void loadMore() }, 750)
})
onBeforeUnmount(() => {removeSelect?.();clearInterval(timer)})
</script>
<style scoped>
.inspector-shell { height:100vh;display:flex;flex-direction:column;color:var(--el-text-color-primary);background:var(--el-bg-color);font-family:system-ui,sans-serif }
header { display:flex;align-items:center;gap:16px;padding:12px 18px;border-bottom:1px solid var(--el-border-color) }
h2 {font-size:20px;margin:0} header small {margin-left:auto;color:var(--el-text-color-secondary)}
.inspector-body { flex:1;min-height:0;display:grid;grid-template-columns:minmax(330px,38%) minmax(0,1fr) }
aside {padding:0 12px;border-right:1px solid var(--el-border-color);overflow:auto}
.request-detail {padding:14px 18px;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}
.detail-heading,.text-toolbar,.text-footer {display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.detail-heading {min-height:32px}.request-error {color:var(--el-color-danger);overflow-wrap:anywhere;margin:8px 0}.request-note {color:var(--el-color-warning);margin:8px 0}
.text-toolbar {margin:0 0 10px}.text-footer {font-size:12px;color:var(--el-text-color-secondary);padding-top:10px}
.raw-viewer {flex:1;min-height:180px;resize:none;box-sizing:border-box;width:100%;padding:12px;border:1px solid var(--el-border-color);border-radius:6px;background:var(--el-fill-color-blank);color:var(--el-text-color-primary);font:13px/1.6 Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.request-tps {font-size:12px;color:var(--el-text-color-secondary);margin:8px 0;overflow-wrap:anywhere}
.metadata {overflow:auto;min-height:0}.metadata dl {display:grid;grid-template-columns:145px minmax(0,1fr);font-size:13px;gap:10px;margin:0 0 15px}.metadata dt {color:var(--el-text-color-secondary)}.metadata dd {margin:0;overflow-wrap:anywhere} pre {white-space:pre-wrap;overflow-wrap:anywhere}
@media(max-width:1000px){.inspector-body{grid-template-columns:330px minmax(0,1fr)}.request-detail{padding:12px}.text-toolbar{gap:6px}header small{display:none}}
</style>
<style>body {margin:0}</style>

<template>
  <section class="ai-settings" v-loading="loading">
    <el-alert v-if="!api" type="info" :closable="false" :title="t('ai.unavailable')" />
    <el-form v-else label-position="top" @submit.prevent="save">
      <el-form-item><el-switch v-model="config.enabled" :active-text="t('ai.enabled')" data-testid="ai-enabled" /></el-form-item>
      <el-form-item :label="t('ai.provider')">
        <el-select v-model="config.provider" :aria-label="t('ai.provider')" data-testid="ai-provider">
          <el-option :label="t('ai.providerCompatible')" value="compatible" />
          <el-option label="ChatGPT (JSON)" value="chatgpt-json" />
          <el-option label="ChatGPT (Account)" value="chatgpt-account" />
        </el-select>
      </el-form-item>
      <template v-if="compatible">
        <el-form-item :label="t('ai.baseUrl')"><el-input v-model="config.baseUrl" placeholder="https://api.example.com/v1" data-testid="ai-base-url" /></el-form-item>
        <el-form-item :label="t('ai.apiKey')">
          <el-input v-model="apiKey" type="password" show-password autocomplete="new-password" :placeholder="t(hasApiKey ? 'ai.keyStored' : 'ai.keyPlaceholder')" data-testid="ai-key" />
        </el-form-item>
      </template>
      <div v-else class="ai-auth-panel" data-testid="ai-auth-panel" aria-live="polite">
        <div class="ai-auth-heading"><strong>{{ t('ai.account') }}</strong><el-tag :type="authTagType">{{ authStatusText }}</el-tag></div>
        <div v-if="hasAuth" class="ai-account-summary">
          <div class="ai-account-identity">
            <div class="ai-account-avatar" aria-hidden="true">{{ accountInitial }}</div>
            <div class="ai-account-profile">
              <strong class="ai-auth-account" data-testid="ai-account-label">{{ auth.account?.email || auth.account?.label || t('ai.emailUnknown') }}</strong>
              <span v-if="!auth.account?.email && auth.account?.label" class="ai-account-secondary">{{ t('ai.emailUnknown') }}</span>
              <span class="ai-account-secondary" data-testid="ai-account-date">{{ accountDateText }}</span>
            </div>
          </div>
          <div class="ai-usage-windows" data-testid="ai-usage-windows">
            <div v-for="window in usageWindows" :key="window.key" class="ai-usage-window" :data-testid="'ai-usage-' + window.key">
              <span class="ai-usage-label">{{ window.label }}</span>
              <div class="ai-usage-track" role="progressbar" :aria-label="window.label" :aria-valuenow="window.remaining ?? undefined" aria-valuemin="0" aria-valuemax="100" :aria-valuetext="window.remaining == null ? t('ai.usageNotFetched') : t('ai.usageRemaining', { value: window.remaining })"><span v-if="window.remaining != null" :style="{ width: window.remaining + '%' }" /></div>
              <span class="ai-usage-remaining">{{ window.remaining == null ? t('ai.usageNotFetched') : t('ai.usageRemaining', { value: window.remaining }) }}</span>
              <span class="ai-usage-reset">{{ resetText(window.resetsAt) }}</span>
            </div>
          </div>
          <div class="ai-usage-refresh">
            <span data-testid="ai-usage-updated">{{ usageUpdatedText }}</span>
            <el-button size="small" :loading="usageRefreshing || auth.usage?.status === 'loading'" :disabled="Boolean(pending) || usageRefreshing || auth.loginPending || !api.refreshUsage" data-testid="ai-refresh-usage" @click="refreshUsage">{{ t('ai.refreshUsage') }}</el-button>
            <el-button v-if="auth.usage?.error === 'AI_USAGE_UNAVAILABLE' && api.openUsagePage" size="small" :disabled="Boolean(pending)" @click="openUsagePage">{{ t('ai.openUsagePage') }}</el-button>
          </div>
          <p v-if="usageStatusText" class="ai-help ai-usage-note" :class="{ 'ai-usage-error': auth.usage?.status === 'failed' }" data-testid="ai-usage-status">{{ usageStatusText }}</p>
        </div>
        <p v-if="auth.account" class="ai-help ai-auth-detail">{{ expiryText }} · {{ t(auth.account.canRefresh ? 'ai.autoRefresh' : 'ai.manualRefresh') }}</p>
        <el-alert v-if="auth.error" :title="formatAuthError(auth.error)" type="error" :closable="false" />
        <template v-if="config.provider === 'chatgpt-json'">
          <template v-if="!hasAuth || editingJson">
            <el-input v-model="oauthJson" type="textarea" :rows="4" autocomplete="off" spellcheck="false" :aria-label="t('ai.oauthJson')" :placeholder="t('ai.oauthJsonPlaceholder')" data-testid="ai-oauth-json" />
            <div class="ai-auth-actions">
              <el-button type="primary" :loading="pending === 'import'" :disabled="Boolean(pending) || !oauthJson.trim() || !api.importOAuthJson" @click="importJson">{{ t('ai.importJson') }}</el-button>
              <el-button v-if="hasAuth" :disabled="Boolean(pending)" @click="cancelJsonEdit">{{ t('ai.cancelImport') }}</el-button>
            </div>
          </template>
          <div v-else class="ai-auth-actions">
            <el-button :disabled="Boolean(pending)" @click="editingJson = true">{{ t('ai.replaceJson') }}</el-button>
          </div>
          <el-button v-if="hasAuth" class="ai-auth-clear" :loading="pending === 'logout'" :disabled="Boolean(pending) || !api.logout" @click="logout">{{ t('ai.clearCredentials') }}</el-button>
        </template>
        <template v-else>
          <p class="ai-help">{{ t(auth.loginPending ? 'ai.loginWaiting' : 'ai.loginDescription') }}</p>
          <div class="ai-auth-actions">
            <template v-if="auth.loginPending">
              <el-button :loading="pending === 'reopen'" :disabled="Boolean(pending) || !api.reopenLogin" @click="reopenLogin">{{ t('ai.reopenLogin') }}</el-button>
              <el-button :loading="pending === 'cancelLogin'" :disabled="Boolean(pending) || !api.cancelLogin" @click="cancelLogin">{{ t('ai.cancelLogin') }}</el-button>
            </template>
            <el-button v-else type="primary" :loading="pending === 'login'" :disabled="Boolean(pending) || !api.startLogin" @click="startLogin">{{ t(hasAuth ? 'ai.switchAccount' : 'ai.loginBrowser') }}</el-button>
            <el-button v-if="hasAuth" :loading="pending === 'logout'" :disabled="Boolean(pending) || auth.loginPending || !api.logout" @click="logout">{{ t('ai.logout') }}</el-button>
          </div>
        </template>
      </div>
      <el-form-item :label="t('ai.model')">
        <div class="ai-model-picker">
          <el-select v-model="selectedModel" filterable :allow-create="compatible" clearable default-first-option :reserve-keyword="false" :placeholder="t(compatible ? 'ai.modelPlaceholder' : 'ai.chatgptModelPlaceholder')" :aria-label="t('ai.model')" data-testid="ai-model">
            <el-option v-for="model in modelOptions" :key="model.id" :label="model.label" :value="model.id" />
          </el-select>
          <el-button :loading="pending === 'models'" :disabled="Boolean(pending) || !api.listModels || (!compatible && !authReady)" @click="loadModels">{{ t('ai.getModels') }}</el-button>
        </div>
        <p v-if="!compatible && !authReady" class="ai-help ai-model-note">{{ t(config.provider === 'chatgpt-json' ? 'ai.importBeforeModels' : 'ai.loginBeforeModels') }}</p>
        <el-alert v-if="modelMessage" class="ai-model-message" :type="modelMessageType" :title="modelMessage" :closable="false" show-icon />
      </el-form-item>
      <el-form-item v-if="!compatible" :label="t('ai.reasoningEffort')">
        <el-select v-model="selectedReasoningEffort" :aria-label="t('ai.reasoningEffort')" data-testid="ai-reasoning-effort">
          <el-option v-for="level in reasoningLevels" :key="level" :label="t('ai.reasoning_' + level)" :value="level" :disabled="!supportsReasoning(level)" />
        </el-select>
        <p v-if="reasoningUnsupported" class="ai-help ai-model-note">{{ t('ai.reasoningUnsupported') }}</p>
      </el-form-item>
      <div v-if="compatible" class="ai-settings-grid">
        <el-form-item :label="t('ai.compatibleReasoningProtocol')">
          <el-select v-model="config.compatibleReasoningProtocol" :aria-label="t('ai.compatibleReasoningProtocol')" data-testid="ai-thinking-protocol">
            <el-option label="DeepSeek" value="deepseek" /><el-option label="OpenAI Chat Completions" value="openai" />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('ai.compatibleThinkingMode')">
          <el-select v-model="config.compatibleThinkingMode" :aria-label="t('ai.compatibleThinkingMode')" data-testid="ai-thinking-mode">
            <el-option v-for="mode in ['inherit','disabled','enabled']" :key="mode" :label="t('ai.thinking_' + mode)" :value="mode" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="config.compatibleThinkingMode === 'enabled'" :label="t('ai.reasoningEffort')">
          <el-select v-model="config.compatibleReasoningEffort" :aria-label="t('ai.reasoningEffort')" data-testid="ai-compatible-effort">
            <el-option v-for="level in compatibleLevels" :key="level" :label="t('ai.reasoning_' + level)" :value="level" />
          </el-select>
          <p v-if="!compatibleLevels.includes(config.compatibleReasoningEffort)" class="ai-help">{{ t('ai.compatibleEffortUnsupported') }}</p>
        </el-form-item>
        <el-form-item :label="t('ai.maxOutputTokens')">
          <el-input-number v-model="config.compatibleMaxOutputTokens" :min="1" :precision="0" :placeholder="t('ai.thinking_inherit')" :aria-label="t('ai.maxOutputTokens')" data-testid="ai-max-output-tokens" />
        </el-form-item>
        <el-form-item v-if="config.compatibleMaxOutputTokens != null" :label="t('ai.outputTokenField')">
          <el-select v-model="config.compatibleOutputTokenField" :aria-label="t('ai.outputTokenField')" data-testid="ai-output-token-field">
            <el-option label="max_tokens" value="max_tokens" /><el-option label="max_completion_tokens" value="max_completion_tokens" />
          </el-select>
        </el-form-item>
      </div>
      <p v-if="compatible" class="ai-help ai-request-note">{{ t('ai.compatibleThinkingHelp') }} {{ t('ai.maxOutputTokensHelp') }}</p>
      <el-form-item :label="t('ai.streaming')">
        <el-switch v-if="compatible" v-model="config.stream" :aria-label="t('ai.streaming')" data-testid="ai-stream" />
        <el-switch v-else :model-value="true" disabled :aria-label="t('ai.streaming')" data-testid="ai-stream" />
        <p class="ai-help ai-request-note ai-stream-note">{{ t(compatible ? 'ai.streamingHelp' : 'ai.streamingRequired') }}</p>
      </el-form-item>
      <div class="ai-settings-grid">
        <el-form-item v-if="compatible" :label="t('ai.responseMode')">
          <el-select v-model="config.responseMode" :aria-label="t('ai.responseMode')" data-testid="ai-response-mode"><el-option :label="t('ai.schemaMode')" value="json_schema" :disabled="jsonObjectOnly" /><el-option :label="t('ai.objectMode')" value="json_object" /></el-select>
          <p v-if="jsonObjectOnly" class="ai-help ai-format-note">{{ t('ai.deepseekObjectMode') }}</p>
        </el-form-item>
        <el-form-item :label="t('ai.timeout')"><el-input-number v-model="timeoutSeconds" :min="1" :max="300" /><p class="ai-help ai-request-note">{{ t('ai.timeoutHelp') }}</p></el-form-item>
        <el-form-item :label="t('ai.normalizationBatchSize')">
          <el-input-number v-model="config.normalizationBatchSize" :min="1" :max="1000" :precision="0" :aria-label="t('ai.normalizationBatchSize')" data-testid="ai-batch-size" />
          <p class="ai-help ai-request-note">{{ t('ai.normalizationBatchSizeHelp') }}</p>
        </el-form-item>
        <el-form-item :label="t('ai.concurrency')">
          <el-input-number v-model="config.concurrency" :min="1" :max="1000" :precision="0" :aria-label="t('ai.concurrency')" data-testid="ai-concurrency" />
          <p class="ai-help ai-request-note">{{ t('ai.concurrencyHelp') }}</p>
        </el-form-item>
      </div>
      <div class="ai-switches"><el-checkbox v-model="config.dedupeEnabled">{{ t('ai.dedupeEnabled') }}</el-checkbox><el-checkbox v-model="config.seriesEnabled">{{ t('ai.seriesEnabled') }}</el-checkbox></div>
      <p class="ai-help">{{ t('ai.dataScope') }}</p>
      <div class="ai-settings-actions">
        <el-button type="primary" :loading="pending === 'save'" :disabled="Boolean(pending)" @click="save">{{ t('ai.save') }}</el-button>
        <el-button :loading="pending === 'test'" :disabled="Boolean(pending) || (!compatible && (!authReady || !selectedModel))" @click="testConnection">{{ t('ai.testConnection') }}</el-button>
        <el-button v-if="compatible" :loading="pending === 'clear'" :disabled="Boolean(pending) || !hasApiKey" @click="clearKey">{{ t('ai.clearKey') }}</el-button>
      </div>
      <el-alert v-if="message" class="ai-settings-message" :type="messageType" :title="message" :closable="false" show-icon />
    </el-form>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { jsonObjectOnlyHosts, compatibleReasoningEfforts } from '../../modules/ai_provider_capabilities.json'

const props = defineProps({ api: { type: Object, default: null } })
const emit = defineEmits(['saved'])
const { t, te } = useI18n()
const api = computed(() => props.api || window.aiApi || window.auditApi?.ai)
const config = reactive({ enabled: false, provider: 'compatible', baseUrl: '', model: '', chatgptJsonModel: '', chatgptAccountModel: '', reasoningEffort: 'medium', compatibleReasoningProtocol:'deepseek', compatibleThinkingMode:'inherit', compatibleReasoningEffort:'low', compatibleOutputTokenField:'max_tokens', compatibleMaxOutputTokens:null, chatgptJsonReasoningEffort: 'medium', chatgptAccountReasoningEffort: 'medium', responseMode: 'json_schema', stream: false, timeoutMs: 30000, normalizationBatchSize: 8, concurrency: 2, dedupeEnabled: true, seriesEnabled: true })
const compatibleLevels = computed(() => compatibleReasoningEfforts[config.compatibleReasoningProtocol] || [])
const compatible = computed(() => config.provider === 'compatible')
const modelField = computed(() => compatible.value ? 'model' : config.provider === 'chatgpt-json' ? 'chatgptJsonModel' : 'chatgptAccountModel')
const selectedModel = computed({ get: () => config[modelField.value], set: value => { config[modelField.value] = value } })
const reasoningLevels = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const reasoningField = computed(() => compatible.value ? 'reasoningEffort' : config.provider === 'chatgpt-json' ? 'chatgptJsonReasoningEffort' : 'chatgptAccountReasoningEffort')
const selectedReasoningEffort = computed({ get: () => config[reasoningField.value], set: value => { config[reasoningField.value] = value } })
const jsonObjectOnly = computed(() => {
  try { return jsonObjectOnlyHosts.includes(new URL(config.baseUrl).hostname) } catch { return false }
})
watch([jsonObjectOnly, () => config.responseMode], ([required, mode]) => {
  if (required && mode !== 'json_object') config.responseMode = 'json_object'
}, { flush: 'sync', immediate: true })
const apiKey = ref(''), hasApiKey = ref(false), loading = ref(false), pending = ref(''), message = ref(''), messageType = ref('info')
const oauthJson = ref(''), editingJson = ref(false)
const authStates = reactive({
  'chatgpt-json': { provider: 'chatgpt-json', status: 'signed-out', account: null, loginPending: false },
  'chatgpt-account': { provider: 'chatgpt-account', status: 'signed-out', account: null, loginPending: false }
})
const auth = computed(() => authStates[config.provider] || {})
const clock = ref(Date.now()), usageRefreshing = ref(false)
const accountInitial = computed(() => String(auth.value.account?.email || auth.value.account?.label || '?').slice(0, 1).toUpperCase())
const formatDate = value => {
  const date = new Date(value)
  return value != null && Number.isFinite(date.getTime()) ? date.toLocaleString() : null
}
const accountDateText = computed(() => {
  const account = auth.value.account || {}
  const timestamp = account.loggedInAt || account.importedAt
  const formatted = formatDate(timestamp)
  return formatted ? t(account.loggedInAt ? 'ai.accountLoggedInAt' : 'ai.accountImportedAt', { value: formatted }) : t('ai.accountDateUnknown')
})
const remainingPercent = value => typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(100, Math.max(0, value)) * 10) / 10 : null
const usageWindowLabel = (key, window) => {
  const seconds = window?.windowSeconds
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return t(key === 'primary' ? 'ai.usageFiveHours' : 'ai.usageWeekly')
  if (seconds === 604800) return t('ai.usageWeekly')
  return t('ai.usageWindow', { value: durationText(seconds * 1000) })
}
const usageWindows = computed(() => [
  { key: 'primary', label: usageWindowLabel('primary', auth.value.usage?.primary), remaining: remainingPercent(auth.value.usage?.primary?.remainingPercent), resetsAt: auth.value.usage?.primary?.resetsAt },
  { key: 'secondary', label: usageWindowLabel('secondary', auth.value.usage?.secondary), remaining: remainingPercent(auth.value.usage?.secondary?.remainingPercent), resetsAt: auth.value.usage?.secondary?.resetsAt }
])
const durationText = milliseconds => {
  const minutes = Math.max(1, Math.ceil(milliseconds / 60000))
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), rest = minutes % 60
  return [days ? t('ai.durationDays', { value: days }) : '', hours ? t('ai.durationHours', { value: hours }) : '', !days && rest ? t('ai.durationMinutes', { value: rest }) : ''].filter(Boolean).join(' ')
}
const resetText = timestamp => typeof timestamp !== 'number' || !Number.isFinite(timestamp) ? t('ai.resetUnknown') : timestamp <= clock.value ? t('ai.resetPending') : t('ai.resetsIn', { value: durationText(timestamp - clock.value) })
const usageUpdatedText = computed(() => {
  const timestamp = auth.value.usage?.fetchedAt
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return t('ai.usageNeverUpdated')
  const elapsed = Math.max(0, clock.value - timestamp)
  return t('ai.usageUpdated', { value: elapsed < 60000 ? t('ai.justNow') : t('ai.timeAgo', { value: durationText(elapsed) }) })
})
const usageStatusText = computed(() => {
  const usage = auth.value.usage
  if (usage?.status === 'failed') return formatAuthError(usage.error || 'AI_USAGE_FETCH_FAILED')
  if (usage?.status === 'unavailable' && usage.error) return formatAuthError(usage.error)
  if (usage?.status === 'loading') return t('ai.usageLoading')
  return ''
})
const hasAuth = computed(() => auth.value.hasCredential ?? Boolean(auth.value.account))
const authReady = computed(() => !auth.value.loginPending && (auth.value.usable ?? (['imported', 'signed-in'].includes(auth.value.status) || (auth.value.status === 'expired' && auth.value.account?.canRefresh))))
const verifiedConnections = reactive({})
const authIdentity = value => value.credentialId || JSON.stringify([value.account?.kind, value.account?.label])
const connectionKey = computed(() => JSON.stringify([config.provider, authIdentity(auth.value), selectedModel.value, selectedReasoningEffort.value]))
const authStatusText = computed(() => t('ai.auth_' + (authReady.value && !auth.value.error && verifiedConnections[connectionKey.value] ? 'verified' : auth.value.status || 'signed-out')))
const authTagType = computed(() => ['signed-in', 'imported'].includes(auth.value.status) ? 'success' : ['expired', 'failed'].includes(auth.value.status) ? 'danger' : 'info')
const expiryText = computed(() => {
  const timestamp = auth.value.account?.expiresAt
  const date = new Date(typeof timestamp === 'number' && timestamp < 1e12 ? timestamp * 1000 : timestamp)
  return timestamp && Number.isFinite(date.getTime()) ? t('ai.expiresAt', { value: date.toLocaleString() }) : t('ai.expiryUnknown')
})
const models = ref([]), modelMessage = ref(''), modelMessageType = ref('info')
const modelOptions = computed(() => {
  const options = [...models.value]
  if (selectedModel.value && !options.some(option => option.id === selectedModel.value)) options.unshift({ id: selectedModel.value, label: selectedModel.value })
  return options
})
const modelCapabilities = computed(() => models.value.find(option => option.id === selectedModel.value))
const supportsReasoning = level => !Array.isArray(modelCapabilities.value?.reasoningEfforts) || modelCapabilities.value.reasoningEfforts.includes(level)
const reasoningUnsupported = computed(() => !supportsReasoning(selectedReasoningEffort.value))
let modelRevision = 0
const invalidateModels = () => {
  modelRevision += 1
  models.value = []; modelMessage.value = ''
}
watch([() => config.provider, () => config.baseUrl, apiKey, hasApiKey], invalidateModels, { flush: 'sync' })
watch(() => config.provider, () => { message.value = ''; editingJson.value = false })
const timeoutSeconds = computed({ get: () => config.timeoutMs / 1000, set: value => { config.timeoutMs = Number(value || 30) * 1000 } })
const applyAuth = value => {
  if (!value || !Object.hasOwn(authStates, value.provider) || unmounted) return
  const previous = authStates[value.provider]
  const changed = authIdentity(previous) !== authIdentity(value) || previous.hasCredential !== value.hasCredential || previous.loginPending !== value.loginPending
  authStates[value.provider] = value
  clock.value = Date.now()
  if (value.provider === config.provider && changed) invalidateModels()
}
const applyConfig = value => { Object.assign(config, value.config); hasApiKey.value = Boolean(value.hasApiKey); apiKey.value = ''; if (value.auth) applyAuth(value.auth) }
const formatError = error => {
  const raw = String(error?.message || error), code = error?.code || raw.match(/AI_[A-Z_]+/)?.[0]
  if (code === 'AI_REQUEST_OPTIONS_UNSUPPORTED') return t('ai.error_AI_REQUEST_OPTIONS_UNSUPPORTED', { parameter: raw.match(/\b(thinking|reasoning_effort|max_completion_tokens|max_tokens)\b/)?.[1] || '' })
  return code && te('ai.error_' + code) ? t('ai.error_' + code) : raw
}
const formatAuthError = error => {
  const raw = String(error?.message || error), code = error?.code || raw.match(/AI_[A-Z_]+/)?.[0]
  if (raw.includes('LIBRARY_AUDIT_LOCKED') || code === 'LIBRARY_AUDIT_LOCKED') return t('ai.authAuditLocked')
  return code && te('ai.error_' + code) ? t('ai.error_' + code) : t('ai.error_AI_AUTH_OPERATION_FAILED')
}
const showError = error => { message.value = compatible.value ? formatError(error) : formatAuthError(error); messageType.value = 'error' }
const draftRequest = () => ({ config: { ...config }, ...(compatible.value && apiKey.value ? { apiKey: apiKey.value } : {}) })
const loadModels = async () => {
  if (pending.value) return
  const revision = modelRevision
  pending.value = 'models'; modelMessage.value = ''; message.value = ''
  try {
    const value = await api.value.listModels(draftRequest())
    if (revision !== modelRevision) return
    const options = new Map((value.modelOptions || []).map(option => [option.id, option]))
    models.value = [...new Set(value.models || [])].map(id => ({ ...options.get(id), id, label: options.get(id)?.label || id }))
    modelMessage.value = t(models.value.length ? 'ai.modelsLoaded' : compatible.value ? 'ai.noModels' : 'ai.noChatgptModels', { count: models.value.length })
    modelMessageType.value = models.value.length ? 'success' : 'info'
  } catch (error) {
    if (revision !== modelRevision) return
    modelMessage.value = compatible.value ? formatError(error) : formatAuthError(error); modelMessageType.value = 'error'
  } finally { pending.value = '' }
}
const run = async (operation, callback, authOperation = false) => {
  if (pending.value) return
  pending.value = operation; message.value = ''
  try { await callback() } catch (error) { if (authOperation) { message.value = formatAuthError(error); messageType.value = 'error' } else showError(error) } finally { pending.value = '' }
}
const save = () => run('save', async () => {
  const keyDraft = apiKey.value
  const value = await api.value.saveConfig(draftRequest())
  applyConfig(value); message.value = t('ai.saved'); messageType.value = 'success'; emit('saved', value)
  if (!compatible.value) apiKey.value = keyDraft
})
const clearKey = () => run('clear', async () => {
  const value = await api.value.saveConfig({ config: { ...config }, clearKey: true })
  applyConfig(value); message.value = t('ai.keyCleared'); messageType.value = 'success'; emit('saved', value)
})
const testConnection = () => run('test', async () => {
  const key = connectionKey.value
  delete verifiedConnections[key]
  const value = await api.value.testConnection(draftRequest())
  if (!value.ok) throw new Error(value.error || t('ai.connectionFailed'))
  if (!compatible.value && key === connectionKey.value) verifiedConnections[key] = true
  message.value = t('ai.connected', { model: value.model || selectedModel.value }); messageType.value = 'success'
})
const cancelJsonEdit = () => { editingJson.value = false; oauthJson.value = '' }
const importJson = () => run('import', async () => {
  applyAuth(await api.value.importOAuthJson({ json: oauthJson.value }))
  oauthJson.value = ''; editingJson.value = false
  message.value = t('ai.jsonImported'); messageType.value = 'success'
}, true)
const startLogin = () => run('login', async () => { applyAuth(await api.value.startLogin(hasAuth.value ? { newAccount: true } : undefined)) }, true)
const reopenLogin = () => run('reopen', async () => { applyAuth(await api.value.reopenLogin()) }, true)
const cancelLogin = () => run('cancelLogin', async () => { applyAuth(await api.value.cancelLogin()) }, true)
const logout = () => run('logout', async () => {
  const result = await api.value.logout({ provider: config.provider })
  applyAuth(result)
  oauthJson.value = ''; editingJson.value = false
  message.value = result?.warning ? formatAuthError(result.warning) : t(config.provider === 'chatgpt-json' ? 'ai.credentialsCleared' : 'ai.loggedOut'); messageType.value = result?.warning ? 'warning' : 'success'
}, true)
const refreshUsage = async () => {
  if (usageRefreshing.value || pending.value) return
  const provider = config.provider
  usageRefreshing.value = true
  try { applyAuth(await api.value.refreshUsage({ provider })) }
  catch (error) {
    if (!unmounted && Object.hasOwn(authStates, provider)) authStates[provider] = { ...authStates[provider], usage: { ...authStates[provider].usage, status: 'failed', error: error?.code || String(error?.message || error).match(/AI_[A-Z_]+/)?.[0] || 'AI_USAGE_FETCH_FAILED' } }
  } finally { usageRefreshing.value = false }
}
const openUsagePage = () => run('usagePage', async () => { await api.value.openUsagePage({ provider: config.provider }) }, true)
let unsubscribeAuth, clockTimer, unmounted = false
onMounted(async () => {
  if (!api.value) return
  unsubscribeAuth = api.value.onAuthState?.(applyAuth)
  clockTimer = setInterval(() => { clock.value = Date.now() }, 30000)
  loading.value = true
  try {
    applyConfig(await api.value.getConfig())
    if (api.value.getAuthState) {
      const values = await Promise.allSettled(['chatgpt-json', 'chatgpt-account'].map(provider => api.value.getAuthState({ provider })))
      for (const value of values) { if (value.status === 'fulfilled') applyAuth(value.value); else { message.value = formatAuthError(value.reason); messageType.value = 'error' } }
    }
  } catch (error) { showError(error) } finally { loading.value = false }
})
onBeforeUnmount(() => { unmounted = true; unsubscribeAuth?.(); clearInterval(clockTimer); oauthJson.value = '' })
</script>

<style scoped>
.ai-settings { padding: 12px 4px; }
.ai-settings :deep(.el-form-item__content > .el-select) { width: 100%; }
.ai-auth-panel { border: 1px solid var(--el-border-color); border-radius: 6px; padding: 14px; margin-bottom: 18px; overflow-wrap: anywhere; }
.ai-auth-heading, .ai-auth-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; }
.ai-auth-heading { justify-content: space-between; }
.ai-auth-actions { margin-top: 12px; }
.ai-auth-actions :deep(.el-button) { margin-left: 0; }
.ai-account-summary { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 1.4fr); gap: 12px 16px; align-items: center; margin-top: 16px; }
.ai-account-identity { display: flex; align-items: center; gap: 10px; min-width: 0; }
.ai-account-avatar { width: 36px; height: 36px; display: grid; place-items: center; border: 1px solid var(--el-border-color); border-radius: 50%; background: var(--el-fill-color-light); flex: 0 0 36px; font-size: 18px; }
.ai-account-profile { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.ai-auth-account { font-size: 14px; overflow-wrap: anywhere; }
.ai-account-secondary { color: var(--el-text-color-secondary); font-size: 12px; }
.ai-usage-windows { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.ai-usage-window { display: grid; grid-template-columns: 3.2em minmax(24px, 1fr) auto auto; align-items: center; gap: 7px; font-size: 12px; }
.ai-usage-track { height: 5px; background: var(--el-fill-color); border-radius: 3px; overflow: hidden; }
.ai-usage-track > span { display: block; height: 100%; background: var(--el-color-primary); border-radius: inherit; }
.ai-usage-label, .ai-usage-remaining, .ai-usage-reset { white-space: nowrap; }
.ai-usage-reset { color: var(--el-text-color-secondary); }
.ai-usage-refresh { grid-column: 1 / -1; display: flex; justify-content: flex-end; align-items: center; flex-wrap: wrap; gap: 8px; color: var(--el-text-color-secondary); font-size: 12px; }
.ai-usage-note { grid-column: 1 / -1; font-size: 12px; margin: 0; }
.ai-usage-error { color: var(--el-color-danger); }
.ai-auth-detail { font-size: 12px; margin: 4px 0 12px; }
.ai-auth-clear { margin-top: 12px; }
.ai-auth-panel :deep(.el-alert) { margin-bottom: 12px; }
.ai-model-note { margin: 8px 0 0; }
.ai-settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 18px; }
.ai-settings-grid :deep(.el-select), .ai-settings-grid :deep(.el-input-number) { width: 100%; }
.ai-model-picker { display: flex; gap: 10px; width: 100%; }
.ai-model-picker :deep(.el-select) { flex: 1; min-width: 0; }
.ai-model-message { margin-top: 10px; }
.ai-switches, .ai-settings-actions { display: flex; flex-wrap: wrap; gap: 8px 14px; }
.ai-settings-actions :deep(.el-button) { margin-left: 0; }
.ai-help { color: var(--el-text-color-secondary); line-height: 1.6; }
.ai-request-note { margin: 6px 0 0; font-size: 12px; }
.ai-stream-note { width: 100%; }
.ai-format-note { width: 100%; margin: 8px 0 0; font-size: 12px; }
.ai-settings-message { margin-top: 16px; }
@media (max-width: 620px) { .ai-account-summary { grid-template-columns: 1fr; } }
@media (max-width: 520px) { .ai-settings-grid { grid-template-columns: 1fr; } }
</style>

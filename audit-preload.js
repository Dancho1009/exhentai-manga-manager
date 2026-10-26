const { contextBridge, ipcRenderer } = require('electron')

const listen = (channel, listener) => {
  const wrapped = (_event, payload) => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}
const cloneIpcPayload = value => JSON.parse(JSON.stringify(value ?? null))

contextBridge.exposeInMainWorld('auditApi', {
  aiTrace: {
    snapshot: request => ipcRenderer.invoke('ai-trace:snapshot', cloneIpcPayload(request)),
    open: request => ipcRenderer.invoke('ai-trace:open', cloneIpcPayload(request)),
    onEvents: listener => listen('ai-trace:events', listener)
  },
  ai: {
    getConfig: () => ipcRenderer.invoke('ai:get-config'),
    saveConfig: request => ipcRenderer.invoke('ai:save-config', cloneIpcPayload(request)),
    testConnection: request => ipcRenderer.invoke('ai:test-connection', cloneIpcPayload(request)),
    listModels: request => ipcRenderer.invoke('ai:list-models', cloneIpcPayload(request)),
    getAuthState: request => ipcRenderer.invoke('ai:get-auth-state', cloneIpcPayload(request)),
    refreshUsage: request => ipcRenderer.invoke('ai:refresh-usage', cloneIpcPayload(request)),
    openUsagePage: request => ipcRenderer.invoke('ai:open-usage-page', cloneIpcPayload(request)),
    importOAuthJson: request => ipcRenderer.invoke('ai:import-oauth-json', cloneIpcPayload(request)),
    startLogin: request => ipcRenderer.invoke('ai:start-login', cloneIpcPayload(request)),
    reopenLogin: () => ipcRenderer.invoke('ai:reopen-login'),
    cancelLogin: () => ipcRenderer.invoke('ai:cancel-login'),
    logout: request => ipcRenderer.invoke('ai:logout', cloneIpcPayload(request)),
    onAuthState: listener => listen('ai:auth-state', listener),
    getState: () => ipcRenderer.invoke('ai:get-state'),
    getResults: request => ipcRenderer.invoke('ai:get-results', cloneIpcPayload(request)),
    start: request => ipcRenderer.invoke('ai:start', cloneIpcPayload(request)),
    discoverAndQueue: request => ipcRenderer.invoke('ai:discover-and-queue', cloneIpcPayload(request)),
    cancel: () => ipcRenderer.invoke('ai:cancel'),
    verifyCandidates: request => ipcRenderer.invoke('ai:verify-candidates', cloneIpcPayload(request)),
    onState: listener => listen('ai:state', listener)
  },
  loadSetting: () => ipcRenderer.invoke('load-setting'),
  getLocale: () => ipcRenderer.invoke('get-locale'),
  getWorkspaceState: () => ipcRenderer.invoke('audit:get-workspace-state'),
  getReport: taskType => ipcRenderer.invoke('audit:get-report', taskType),
  getReview: taskType => ipcRenderer.invoke('audit:get-review', taskType),
  getLogs: limit => ipcRenderer.invoke('audit:get-logs', limit),
  getBookPreview: bookId => ipcRenderer.invoke('audit:get-book-preview', bookId),
  buildManualSourceAction: request => ipcRenderer.invoke('audit:build-manual-source-action', request),
  openBookDetail: request => ipcRenderer.invoke('audit:open-book-detail', request),
  startAnomaly: options => ipcRenderer.invoke('audit:start-anomaly', options),
  startDedupe: options => ipcRenderer.invoke('audit:start-dedupe', options),
  getDedupeComparison: request => ipcRenderer.invoke('audit:dedupe-comparison', cloneIpcPayload(request)),
  getDedupePreview: request => ipcRenderer.invoke('audit:dedupe-preview', cloneIpcPayload(request)),
  cleanupDedupePreview: () => ipcRenderer.invoke('audit:dedupe-preview-cleanup'),
  getDedupeHistory: () => ipcRenderer.invoke('audit:dedupe-history'),
  cancelActive: () => ipcRenderer.invoke('audit:cancel-active'),
  clearInspectionRecords: () => ipcRenderer.invoke('audit:clear-inspection-records'),
  saveReview: (taskType, review) => ipcRenderer.invoke('audit:save-review', { taskType, review }),
  prepareSafeActions: () => ipcRenderer.invoke('audit:prepare-safe-actions'),
  getExecutionPreview: request => ipcRenderer.invoke('audit:get-execution-preview', request),
  executeApproved: options => ipcRenderer.invoke('audit:execute-approved', options),
  showFile: filepath => ipcRenderer.invoke('audit:show-file', filepath),
  openUrl: url => ipcRenderer.invoke('audit:open-url', url),
  pageRecovery: {
    fetch: request => ipcRenderer.invoke('audit:page-recovery-fetch', cloneIpcPayload(request)),
    searchNhentai: request => ipcRenderer.invoke('audit:nhentai-recovery-search', cloneIpcPayload(request)),
    getNhentaiPageCount: request => ipcRenderer.invoke('audit:nhentai-recovery-page-count', cloneIpcPayload(request)),
    searchJmComic: request => ipcRenderer.invoke('audit:jmcomic-recovery-search', cloneIpcPayload(request)),
    getJmComicPageCount: request => ipcRenderer.invoke('audit:jmcomic-recovery-page-count', cloneIpcPayload(request)),
    getState: recoveryId => ipcRenderer.invoke('audit:page-recovery-get-state', recoveryId),
    getLatest: request => ipcRenderer.invoke('audit:page-recovery-get-latest', cloneIpcPayload(request)),
    listLatest: request => ipcRenderer.invoke('audit:page-recovery-list-latest', cloneIpcPayload(request)),
    apply: request => ipcRenderer.invoke('audit:page-recovery-apply', cloneIpcPayload(request)),
    applyBatch: request => ipcRenderer.invoke('audit:page-recovery-apply-batch', cloneIpcPayload(request)),
    cancel: recoveryId => ipcRenderer.invoke('audit:page-recovery-cancel', recoveryId),
    cleanup: recoveryId => ipcRenderer.invoke('audit:page-recovery-cleanup', recoveryId)
  },
  selectQuarantine: defaultPath => ipcRenderer.invoke('audit:select-quarantine', defaultPath),
  onState: listener => listen('audit:state', listener),
  onLog: listener => listen('audit:log', listener)
})

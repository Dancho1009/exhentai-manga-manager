const { contextBridge, ipcRenderer } = require('electron')

const listen = (channel, listener) => {
  const wrapped = (_event, payload) => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

contextBridge.exposeInMainWorld('auditApi', {
  loadSetting: () => ipcRenderer.invoke('load-setting'),
  getLocale: () => ipcRenderer.invoke('get-locale'),
  getWorkspaceState: () => ipcRenderer.invoke('audit:get-workspace-state'),
  getReport: taskType => ipcRenderer.invoke('audit:get-report', taskType),
  getReview: taskType => ipcRenderer.invoke('audit:get-review', taskType),
  getLogs: limit => ipcRenderer.invoke('audit:get-logs', limit),
  getBookPreview: bookId => ipcRenderer.invoke('audit:get-book-preview', bookId),
  openBookDetail: request => ipcRenderer.invoke('audit:open-book-detail', request),
  startAnomaly: options => ipcRenderer.invoke('audit:start-anomaly', options),
  startDedupe: options => ipcRenderer.invoke('audit:start-dedupe', options),
  cancelActive: () => ipcRenderer.invoke('audit:cancel-active'),
  saveReview: (taskType, review) => ipcRenderer.invoke('audit:save-review', { taskType, review }),
  getExecutionPreview: request => ipcRenderer.invoke('audit:get-execution-preview', request),
  executeApproved: options => ipcRenderer.invoke('audit:execute-approved', options),
  showFile: filepath => ipcRenderer.invoke('audit:show-file', filepath),
  openUrl: url => ipcRenderer.invoke('audit:open-url', url),
  selectQuarantine: defaultPath => ipcRenderer.invoke('audit:select-quarantine', defaultPath),
  onState: listener => listen('audit:state', listener),
  onLog: listener => listen('audit:log', listener)
})

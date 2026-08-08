const { contextBridge, ipcRenderer } = require('electron')

const listen = (channel, listener) => {
  const wrapped = (_event, payload) => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

contextBridge.exposeInMainWorld('auditApi', {
  loadSetting: () => ipcRenderer.invoke('load-setting'),
  getLocale: () => ipcRenderer.invoke('get-locale'),
  getState: () => ipcRenderer.invoke('audit:get-state'),
  getReport: () => ipcRenderer.invoke('audit:get-report'),
  getReview: () => ipcRenderer.invoke('audit:get-review'),
  start: options => ipcRenderer.invoke('audit:start', options),
  cancel: () => ipcRenderer.invoke('audit:cancel'),
  saveReview: review => ipcRenderer.invoke('audit:save-review', review),
  executeApproved: options => ipcRenderer.invoke('audit:execute-approved', options),
  showFile: filepath => ipcRenderer.invoke('audit:show-file', filepath),
  openUrl: url => ipcRenderer.invoke('audit:open-url', url),
  selectQuarantine: defaultPath => ipcRenderer.invoke('audit:select-quarantine', defaultPath),
  onState: listener => listen('audit:state', listener),
  onLog: listener => listen('audit:log', listener)
})

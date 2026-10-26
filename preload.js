const { contextBridge, ipcRenderer, webFrame } = require('electron')

contextBridge.exposeInMainWorld('aiApi', {
  traceSnapshot: request => ipcRenderer.invoke('ai-trace:snapshot', request),
  openTrace: request => ipcRenderer.invoke('ai-trace:open', request),
  getConfig: () => ipcRenderer.invoke('ai:get-config'),
  saveConfig: request => ipcRenderer.invoke('ai:save-config', request),
  testConnection: request => ipcRenderer.invoke('ai:test-connection', request),
  listModels: request => ipcRenderer.invoke('ai:list-models', request),
  getAuthState: request => ipcRenderer.invoke('ai:get-auth-state', request),
  refreshUsage: request => ipcRenderer.invoke('ai:refresh-usage', request),
  openUsagePage: request => ipcRenderer.invoke('ai:open-usage-page', request),
  importOAuthJson: request => ipcRenderer.invoke('ai:import-oauth-json', request),
  startLogin: request => ipcRenderer.invoke('ai:start-login', request),
  reopenLogin: () => ipcRenderer.invoke('ai:reopen-login'),
  cancelLogin: () => ipcRenderer.invoke('ai:cancel-login'),
  logout: request => ipcRenderer.invoke('ai:logout', request),
  onAuthState: listener => {
    const wrapped = (_event, value) => listener(value)
    ipcRenderer.on('ai:auth-state', wrapped)
    return () => ipcRenderer.removeListener('ai:auth-state', wrapped)
  },
  getState: () => ipcRenderer.invoke('ai:get-state'),
  getResults: request => ipcRenderer.invoke('ai:get-results', request),
  start: request => ipcRenderer.invoke('ai:start', request),
  cancel: () => ipcRenderer.invoke('ai:cancel'),
  verifyCandidates: request => ipcRenderer.invoke('ai:verify-candidates', request),
  onState: listener => {
    const wrapped = (_event, value) => listener(value)
    ipcRenderer.on('ai:state', wrapped)
    return () => ipcRenderer.removeListener('ai:state', wrapped)
  }
})

contextBridge.exposeInMainWorld('ipcRenderer', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, listener) => ipcRenderer.on(channel, listener),
  sendSync: (channel, ...args) => ipcRenderer.sendSync(channel, ...args),
})

contextBridge.exposeInMainWorld('electronFunction', {
  'get-zoom-level': () => webFrame.getZoomLevel(),
  'set-zoom-level': (level) => webFrame.setZoomLevel(level),
  'insert-css': (css) => webFrame.insertCSS(css, { cssOrigin: 'user' }),
})

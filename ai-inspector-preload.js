const { contextBridge, ipcRenderer } = require('electron')
const listen = (channel, listener) => {
  const callback = (_event, value) => listener(value)
  ipcRenderer.on(channel, callback)
  return () => ipcRenderer.removeListener(channel, callback)
}
contextBridge.exposeInMainWorld('aiTraceApi', {
  bootstrap: () => ipcRenderer.invoke('ai-trace:bootstrap'),
  snapshot: request => ipcRenderer.invoke('ai-trace:snapshot', request),
  readText: request => ipcRenderer.invoke('ai-trace:read-text', request),
  export: request => ipcRenderer.invoke('ai-trace:export', request),
  onEvents: listener => listen('ai-trace:events', listener),
  onSelect: listener => listen('ai-trace:select', listener)
})

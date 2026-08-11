const { contextBridge, ipcRenderer } = require('electron')

const invokeChannels = new Set([
  'book-detail:get-bootstrap',
  'book-detail:get-context',
  'book-detail:get-book',
  'book-detail:get-tag-catalog',
  'book-detail:navigate',
  'book-detail:close-window',
  'book-detail:request-main-action',
  'save-book',
  'increment-read-count',
  'open-local-book',
  'patch-local-metadata-by-book',
  'delete-local-book',
  'show-file',
  'open-url',
  'get-ehviewer-data',
  'ehentai:get-availability',
  'ehentai:get-page',
  'ehentai:get-metadata',
  'nhentai-comments',
  'nhentai-metadata',
  'nhentai-search',
  'get-ex-webpage',
  'copy-text-to-clipboard',
  'read-text-from-clipboard'
])

const eventChannels = new Set([
  'book-detail:open',
  'book-detail:book-changed',
  'book-detail:library-changed',
  'book-detail:lock-state',
  'book-detail:setting-changed',
  'book-detail:translation-changed'
])

const assertChannel = (channel, allowed) => {
  if (!allowed.has(channel)) throw new Error(`IPC channel is not allowed: ${channel}`)
}

const listen = (channel, listener, payloadOnly = false) => {
  assertChannel(channel, eventChannels)
  const wrapped = (event, payload) => payloadOnly ? listener(payload) : listener(event, payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

contextBridge.exposeInMainWorld('ipcRenderer', {
  invoke: (channel, ...args) => {
    assertChannel(channel, invokeChannels)
    return ipcRenderer.invoke(channel, ...args)
  },
  on: (channel, listener) => listen(channel, listener),
  sendSync: (channel, ...args) => {
    if (channel !== 'get-path-sep') throw new Error(`IPC channel is not allowed: ${channel}`)
    return ipcRenderer.sendSync(channel, ...args)
  }
})

contextBridge.exposeInMainWorld('bookDetailApi', {
  getBootstrap: () => ipcRenderer.invoke('book-detail:get-bootstrap'),
  getContext: () => ipcRenderer.invoke('book-detail:get-context'),
  getBook: bookId => ipcRenderer.invoke('book-detail:get-book', bookId),
  getTagCatalog: () => ipcRenderer.invoke('book-detail:get-tag-catalog'),
  navigate: context => ipcRenderer.invoke('book-detail:navigate', context),
  closeWindow: () => ipcRenderer.invoke('book-detail:close-window'),
  requestMainAction: request => ipcRenderer.invoke('book-detail:request-main-action', request),
  onOpen: listener => listen('book-detail:open', listener, true),
  onBookChanged: listener => listen('book-detail:book-changed', listener, true),
  onLibraryChanged: listener => listen('book-detail:library-changed', listener, true),
  onLockState: listener => listen('book-detail:lock-state', listener, true),
  onSettingChanged: listener => listen('book-detail:setting-changed', listener, true),
  onTranslationChanged: listener => listen('book-detail:translation-changed', listener, true)
})

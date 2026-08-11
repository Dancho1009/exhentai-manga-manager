const { contextBridge, ipcRenderer, webFrame } = require('electron')

const invokeChannels = new Set([
  'book-detail:get-bootstrap',
  'book-detail:get-context',
  'book-detail:get-book',
  'book-detail:get-tag-catalog',
  'book-detail:search-books',
  'book-detail:navigate',
  'book-detail:close-window',
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
  'set-progress-bar',
  'load-manga-image-list',
  'release-sendimagelock',
  'use-new-cover',
  'delete-image',
  'copy-image-to-clipboard',
  'update-window-title',
  'copy-text-to-clipboard',
  'read-text-from-clipboard'
])

const eventChannels = new Set([
  'book-detail:open',
  'book-detail:book-changed',
  'book-detail:library-changed',
  'book-detail:lock-state',
  'book-detail:setting-changed',
  'book-detail:translation-changed',
  'send-message',
  'manga-image',
  'manga-thumbnail-image',
  'manga-load-error'
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
  searchBooks: request => ipcRenderer.invoke('book-detail:search-books', request),
  navigate: context => ipcRenderer.invoke('book-detail:navigate', context),
  closeWindow: () => ipcRenderer.invoke('book-detail:close-window'),
  onOpen: listener => listen('book-detail:open', listener, true),
  onBookChanged: listener => listen('book-detail:book-changed', listener, true),
  onLibraryChanged: listener => listen('book-detail:library-changed', listener, true),
  onLockState: listener => listen('book-detail:lock-state', listener, true),
  onSettingChanged: listener => listen('book-detail:setting-changed', listener, true),
  onTranslationChanged: listener => listen('book-detail:translation-changed', listener, true),
  onMessage: listener => listen('send-message', listener, true)
})

contextBridge.exposeInMainWorld('electronFunction', {
  'get-zoom-level': () => webFrame.getZoomLevel(),
  'set-zoom-level': level => webFrame.setZoomLevel(level),
  'insert-css': css => webFrame.insertCSS(css, { cssOrigin: 'user' })
})

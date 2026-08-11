<template>
  <el-config-provider :locale="elementLocale">
    <main class="book-detail-window" v-loading="loading || tagSearchLoading">
      <BookDetailDialog
        ref="detailRef"
        standalone
        @open-content-view="openContentView"
        @open-thumbnail-view="openThumbnailView"
        @open-search-dialog="openSearchDialog"
        @get-book-info="getBookInfo"
        @search-from-tag="searchFromTag"
        @jump-mange-detail="jumpBook"
        @handle-remove-book-display="handleBookRemoved"
      />

      <section v-if="tagSearchVisible" class="local-search-view">
        <header class="local-search-header">
          <el-button circle :icon="Back" :title="$t('c.back')" @click="returnToDetail" />
          <h2>{{ tagSearchTitle }}</h2>
          <el-tag type="info">{{ tagSearchBooks.length }}</el-tag>
        </header>
        <el-scrollbar class="local-search-scroll">
          <div v-if="pagedTagSearchBooks.length" class="local-search-grid">
            <BookCard
              v-for="book in pagedTagSearchBooks"
              :key="book.id"
              :book="book"
              @open-book-detail="openSearchResultDetail(book)"
              @handle-click-cover="handleSearchResultCover(book)"
              @on-book-context-menu="onResultContextMenu"
              @handle-search-string="searchFromCardSignal"
              @search-from-tag="searchFromTag"
              @open-local-book="openSearchResultLocal(book)"
              @view-manga="openContentView(book)"
            />
          </div>
          <el-empty v-else :description="$t('m.noResults')" />
        </el-scrollbar>
        <footer v-if="tagSearchBooks.length > tagSearchPageSize" class="local-search-footer">
          <el-pagination
            v-model:current-page="tagSearchPage"
            :page-size="tagSearchPageSize"
            layout="total, prev, pager, next"
            :total="tagSearchBooks.length"
            background
          />
        </footer>
      </section>

      <SearchDialog ref="searchRef" />
      <InternalViewer
        ref="viewerRef"
        @to-next-manga="toNextManga"
        @to-next-manga-random="toNextMangaRandom"
        @update-window-title="updateWindowTitle"
        @rescan-book="book => detailRef?.rescanBook(book)"
      />
    </main>
  </el-config-provider>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { Back } from '@element-plus/icons-vue'
import ContextMenu from '@imengyu/vue3-context-menu'
import zhCn from 'element-plus/dist/locale/zh-cn.mjs'
import zhTw from 'element-plus/dist/locale/zh-tw.mjs'
import en from 'element-plus/dist/locale/en.mjs'
import BookCard from './components/BookCard.vue'
import BookDetailDialog from './components/BookDetailDialog.vue'
import InternalViewer from './components/InternalViewer.vue'
import SearchDialog from './components/SearchDialog.vue'
import { useAppStore } from './pinia.js'

const props = defineProps({
  initialBootstrap: {
    type: Object,
    required: true
  }
})

const { t, locale } = useI18n()
const appStore = useAppStore()
const {
  setting,
  resolvedTranslation,
  bookDetail,
  bookList,
  displayBookList,
  auditLocked,
  keyMap
} = storeToRefs(appStore)
const {
  copyTagClipboard,
  getDisplayTitle,
  pasteTagClipboard,
  printMessage,
  resetMetadata
} = appStore

setting.value = props.initialBootstrap.setting || {}
resolvedTranslation.value = props.initialBootstrap.translation || {}
auditLocked.value = Boolean(props.initialBootstrap.lock?.auditRunning)

const detailRef = ref(null)
const searchRef = ref(null)
const viewerRef = ref(null)
const loading = ref(true)
const currentContext = ref(null)
const tagCatalog = ref({})
const tagSearchVisible = ref(false)
const tagSearchLoading = ref(false)
const tagSearchBooks = ref([])
const tagSearchTitle = ref('')
const tagSearchRequest = ref(null)
const tagSearchPage = ref(1)
const tagSearchPageSize = 48
const disposers = []
let loadRequestId = 0
let activeLoadKey = null
let searchRequestId = 0

const elementLocale = computed(() => {
  if (setting.value.language === 'zh-TW') return zhTw
  if (setting.value.language === 'en-US') return en
  return zhCn
})

const pagedTagSearchBooks = computed(() => {
  const start = (tagSearchPage.value - 1) * tagSearchPageSize
  return tagSearchBooks.value.slice(start, start + tagSearchPageSize)
})

const prepareBook = book => {
  if (!book) return book
  book.pageDiff = Number.isInteger(book.filecount) &&
    Number.isInteger(book.pageCount) &&
    Math.abs(book.filecount - book.pageCount) > 5
  return book
}

const refreshStoreBookList = book => {
  const books = []
  const seen = new Set()
  for (const item of [book, ...tagSearchBooks.value]) {
    if (!item?.id || seen.has(item.id)) continue
    seen.add(item.id)
    books.push(item)
  }
  books.push({ id: '__book_detail_tag_catalog__', tags: tagCatalog.value })
  bookList.value = books
  displayBookList.value = tagSearchVisible.value ? tagSearchBooks.value : (book?.id ? [book] : [])
}

const applyBook = async (book, { showDetail = true } = {}) => {
  if (!book?.id) return null
  prepareBook(book)
  if (bookDetail.value?.id === book.id) Object.assign(bookDetail.value, book)
  else bookDetail.value = book
  refreshStoreBookList(bookDetail.value)
  if (showDetail) {
    tagSearchVisible.value = false
    await nextTick()
    detailRef.value?.openBookDetail(bookDetail.value, false)
  }
  return bookDetail.value
}

const loadContext = async (context, { showDetail = true, resetSearch = false } = {}) => {
  if (!context?.bookId) return null
  const loadKey = `${context.bookId}:${(context.navigationIds || []).join(',')}`
  if (loading.value && activeLoadKey === loadKey) return null
  const requestId = ++loadRequestId
  activeLoadKey = loadKey
  loading.value = true
  try {
    const book = await window.bookDetailApi.getBook(context.bookId)
    if (requestId !== loadRequestId) return null
    if (!book) {
      ElMessage.error(t('c.bookDetailNotFound'))
      await window.bookDetailApi.closeWindow()
      return null
    }
    currentContext.value = context
    if (resetSearch) {
      tagSearchVisible.value = false
      tagSearchBooks.value = []
      tagSearchRequest.value = null
    }
    return await applyBook(book, { showDetail })
  } catch (error) {
    console.error(error)
    ElMessage.error(String(error?.message || error))
    return null
  } finally {
    if (requestId === loadRequestId) {
      activeLoadKey = null
      loading.value = false
    }
  }
}

const navigateToBook = async (bookId, navigationIds, options = {}) => {
  const context = await window.bookDetailApi.navigate({ bookId, navigationIds })
  return await loadContext(context, options)
}

const getAdjacentContext = step => {
  const context = currentContext.value
  const ids = context?.navigationIds || []
  const currentIndex = ids.indexOf(context?.bookId)
  const nextIndex = currentIndex + step
  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= ids.length) return null
  return { bookId: ids[nextIndex], navigationIds: ids }
}

const jumpBook = async step => {
  const context = getAdjacentContext(step)
  if (!context) {
    printMessage('info', t('c.outOfRange'))
    return null
  }
  return await navigateToBook(context.bookId, context.navigationIds)
}

const jumpBookRandom = async () => {
  const ids = currentContext.value?.navigationIds || []
  const candidates = ids.filter(id => id !== currentContext.value?.bookId)
  if (!candidates.length) {
    printMessage('info', t('c.outOfRange'))
    return null
  }
  const bookId = candidates[Math.floor(Math.random() * candidates.length)]
  return await navigateToBook(bookId, ids)
}

const ensureActiveBook = async book => {
  if (!book?.id) return null
  if (currentContext.value?.bookId === book.id) return bookDetail.value
  const resultIds = tagSearchBooks.value.map(item => item.id)
  const navigationIds = resultIds.includes(book.id)
    ? resultIds
    : [...new Set([...(currentContext.value?.navigationIds || []), book.id])]
  return await navigateToBook(book.id, navigationIds)
}

const openViewer = async (book, showThumbnail) => {
  const activeBook = await ensureActiveBook(book)
  if (!activeBook) return
  viewerRef.value.showThumbnail = showThumbnail
  viewerRef.value.viewManga(activeBook)
}

const openContentView = book => openViewer(book, false)
const openThumbnailView = book => openViewer(book, true)

const toNextManga = async step => {
  viewerRef.value?.handleStopReadManga()
  const nextBook = await jumpBook(step)
  if (nextBook) viewerRef.value?.viewManga(nextBook)
}

const toNextMangaRandom = async () => {
  viewerRef.value?.handleStopReadManga()
  const nextBook = await jumpBookRandom()
  if (nextBook) viewerRef.value?.viewManga(nextBook)
}

const updateWindowTitle = book => {
  ipcRenderer.invoke('update-window-title', book ? getDisplayTitle(book) : undefined)
}

const openSearchDialog = () => searchRef.value?.openSearchDialog(bookDetail.value)
const getBookInfo = () => searchRef.value?.getBookInfo(bookDetail.value)

const runLocalSearch = async (request, title, { activate = true } = {}) => {
  const requestId = ++searchRequestId
  tagSearchLoading.value = true
  try {
    const books = await window.bookDetailApi.searchBooks(request)
    if (requestId !== searchRequestId) return
    tagSearchRequest.value = request
    tagSearchTitle.value = title
    tagSearchBooks.value = books
      .map(prepareBook)
      .filter(book => !book.collectionHide && !book.hiddenBook)
    tagSearchPage.value = 1
    if (activate) {
      tagSearchVisible.value = true
      if (detailRef.value) detailRef.value.dialogVisibleBookDetail = false
    }
    refreshStoreBookList(bookDetail.value)
  } catch (error) {
    console.error(error)
    printMessage('error', String(error?.message || error))
  } finally {
    if (requestId === searchRequestId) tagSearchLoading.value = false
  }
}

const searchFromTag = async (tag, cat) => {
  const namespace = cat ? (resolvedTranslation.value[cat]?._name || cat) : ''
  const title = namespace ? `${namespace}: ${tag}` : String(tag || '')
  await runLocalSearch({ tag, cat }, `${t('m.search')}: ${title}`)
}

const searchFromCardSignal = async value => {
  if (String(value).startsWith(':count=')) {
    const readCount = Number(String(value).slice(7))
    await runLocalSearch({ readCount }, `${t('m.readCount')}: ${readCount}`)
  } else if (value === 'pageDiff') {
    await runLocalSearch({ pageDiff: true }, `${t('m.search')}: pageDiff`)
  }
}

const returnToDetail = async () => {
  tagSearchVisible.value = false
  refreshStoreBookList(bookDetail.value)
  await nextTick()
  if (bookDetail.value?.id) detailRef.value?.openBookDetail(bookDetail.value, false)
}

const openSearchResultDetail = async book => {
  const ids = tagSearchBooks.value.map(item => item.id)
  await navigateToBook(book.id, ids)
}

const handleSearchResultCover = async book => {
  switch (setting.value.directEnter) {
    case 'internalViewer':
      await openContentView(book)
      break
    case 'externalViewer':
      await openSearchResultLocal(book)
      break
    default:
      await openSearchResultDetail(book)
      break
  }
}

const openSearchResultLocal = async book => {
  const activeBook = await ensureActiveBook(book)
  if (activeBook) detailRef.value?.openLocalBook(activeBook)
}

const onResultContextMenu = (event, book) => {
  event.preventDefault()
  ContextMenu.showContextMenu({
    x: event.x,
    y: event.y,
    items: [
      {
        label: t('m.getMetadata'),
        disabled: auditLocked.value,
        onClick: () => searchRef.value?.openSearchDialog(book)
      },
      {
        label: t('m.resetMetadata'),
        disabled: auditLocked.value,
        onClick: () => resetMetadata(book)
      },
      {
        label: t('m.openMangaFileLocation'),
        onClick: () => detailRef.value?.showFile(book.filepath)
      },
      {
        label: t('m.deleteFile'),
        disabled: auditLocked.value,
        onClick: () => detailRef.value?.deleteLocalBook(book)
      },
      {
        label: `${t('m.hideManga')}/${t('m.showManga')}`,
        disabled: auditLocked.value,
        onClick: async () => {
          await detailRef.value?.triggerHiddenBook(book)
          if (book.hiddenBook) tagSearchBooks.value = tagSearchBooks.value.filter(item => item.id !== book.id)
          refreshStoreBookList(bookDetail.value)
        }
      },
      {
        label: t('m.copyTagClipboard'),
        onClick: () => copyTagClipboard(book)
      },
      {
        label: t('m.pasteTagClipboard'),
        disabled: auditLocked.value,
        onClick: () => pasteTagClipboard(book)
      }
    ]
  })
}

const handleBookRemoved = async removedBook => {
  const removedId = removedBook?.id || bookDetail.value?.id
  tagSearchBooks.value = tagSearchBooks.value.filter(book => book.id !== removedId)
  if (currentContext.value) {
    currentContext.value = {
      ...currentContext.value,
      navigationIds: (currentContext.value.navigationIds || []).filter(id => id !== removedId)
    }
  }
  if (bookDetail.value?.id === removedId) {
    if (tagSearchBooks.value.length) {
      tagSearchVisible.value = true
      refreshStoreBookList(null)
    } else {
      await window.bookDetailApi.closeWindow()
    }
  } else {
    refreshStoreBookList(bookDetail.value)
  }
}

const currentUi = () => {
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return 'input'
  if (document.querySelector('.is-message-box')) return 'message-box'
  if (searchRef.value?.dialogVisibleEhSearch) return 'search-dialog'
  if (viewerRef.value?.drawerVisibleViewer) return viewerRef.value.showThumbnail ? 'viewer-thumbnail' : 'viewer-content'
  if (viewerRef.value?.isComicReadDisplay) return 'viewer-comicread'
  if (tagSearchVisible.value) return 'tag-search'
  if (detailRef.value?.editingTag) return 'edit-tag'
  return 'book-detail'
}

const resolveKey = event => {
  const ui = currentUi()
  if (ui !== 'input' && event.key === 'Backspace') {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    return
  }

  let next
  let prev
  if (setting.value.reverseLeftRight) ({ next, prev } = keyMap.value.reverse)
  else ({ next, prev } = keyMap.value.normal)

  if (ui === 'viewer-content' || ui === 'viewer-thumbnail') {
    if (event.key === 'PageDown') event.shiftKey ? toNextMangaRandom() : toNextManga(1)
    else if (event.key === 'PageUp') toNextManga(-1)
    else if (event.key === '=') viewerRef.value.showThumbnail = !viewerRef.value.showThumbnail
    if (ui !== 'viewer-content') return

    if (viewerRef.value.imageStyleType === 'single' || viewerRef.value.imageStyleType === 'double') {
      if (event.key === next || event.key === 'ArrowDown' || event.key === ' ') viewerRef.value.currentImageIndex += 1
      else if (event.key === prev || event.key === 'ArrowUp') viewerRef.value.currentImageIndex -= 1
      else if (event.key === 'Home') viewerRef.value.currentImageIndex = 0
      else if (event.key === 'End') {
        viewerRef.value.currentImageIndex = viewerRef.value.imageStyleType === 'single'
          ? viewerRef.value.viewerImageList.length - 1
          : viewerRef.value.viewerImageListDouble.length - 1
      } else if (event.key === '/' && viewerRef.value.imageStyleType === 'double') {
        viewerRef.value.insertEmptyPageIndex = viewerRef.value.currentImageIndex
        viewerRef.value.insertEmptyPage = !viewerRef.value.insertEmptyPage
      }
    } else {
      const body = document.querySelector('.viewer-drawer .el-drawer__body')
      if (!body) return
      if (event.key === prev || event.key === 'ArrowUp') body.scrollBy(0, event.ctrlKey ? -window.innerHeight / 10 : -window.innerHeight / 1.2)
      else if (event.key === next || event.key === 'ArrowDown' || event.key === ' ') body.scrollBy(0, event.ctrlKey ? window.innerHeight / 10 : window.innerHeight / 1.2)
      else if (event.key === 'Home') body.scrollTop = 0
      else if (event.key === 'End') body.scrollTop = body.scrollHeight
    }
    return
  }

  if (ui === 'tag-search' && event.key === 'Escape') {
    returnToDetail()
  } else if (ui === 'edit-tag' && event.key === 'Escape') {
    detailRef.value?.editTags()
  } else if (ui === 'book-detail') {
    if (event.key === 'Enter') {
      event.preventDefault()
      openContentView(bookDetail.value)
    } else if (event.key === "'") {
      detailRef.value?.openLocalBook(bookDetail.value)
    } else if (event.key === 'Delete') {
      detailRef.value?.deleteLocalBook(bookDetail.value)
    } else if (event.key === 'PageDown') {
      event.shiftKey ? jumpBookRandom() : jumpBook(1)
    } else if (event.key === 'PageUp') {
      jumpBook(-1)
    } else if (event.key === 'Escape') {
      window.bookDetailApi.closeWindow()
    }
  }
}

const resolveWheel = event => {
  if (!event.ctrlKey || !window.electronFunction) return
  const level = window.electronFunction['get-zoom-level']()
  window.electronFunction['set-zoom-level'](event.deltaY > 0 ? level - 1 : level + 1)
}

const resolveMouseDown = event => {
  if (event.button !== 3) return
  const ui = currentUi()
  if (ui === 'viewer-comicread') {
    viewerRef.value?.closeComicReader()
  } else if (ui === 'viewer-content' || ui === 'viewer-thumbnail') {
    viewerRef.value.drawerVisibleViewer = false
  } else if (ui === 'tag-search') {
    returnToDetail()
  } else if (ui === 'edit-tag') {
    detailRef.value?.editTags()
  } else if (ui === 'search-dialog') {
    searchRef.value.dialogVisibleEhSearch = false
  } else if (ui === 'book-detail') {
    window.bookDetailApi.closeWindow()
  }
}

const handleExternalOpen = async context => {
  if (searchRef.value?.dialogVisibleEhSearch) searchRef.value.dialogVisibleEhSearch = false
  if (viewerRef.value?.isComicReadDisplay) {
    viewerRef.value.closeComicReader()
    viewerRef.value.handleStopReadManga()
  }
  if (viewerRef.value?.drawerVisibleViewer) {
    viewerRef.value.drawerVisibleViewer = false
  }
  await loadContext(context, { resetSearch: true })
}

onMounted(async () => {
  disposers.push(
    window.bookDetailApi.onOpen(handleExternalOpen),
    window.bookDetailApi.onBookChanged(async payload => {
      if (!payload?.bookId) return
      const resultIndex = tagSearchBooks.value.findIndex(book => book.id === payload.bookId)
      if (payload.type === 'deleted' || !payload.book) {
        if (resultIndex >= 0) tagSearchBooks.value.splice(resultIndex, 1)
        if (payload.bookId === currentContext.value?.bookId) {
          ElMessage.info(t('c.bookDetailDeleted'))
          await handleBookRemoved({ id: payload.bookId })
        } else {
          refreshStoreBookList(bookDetail.value)
        }
        return
      }
      prepareBook(payload.book)
      if (resultIndex >= 0) {
        if (payload.book.hiddenBook || payload.book.collectionHide) tagSearchBooks.value.splice(resultIndex, 1)
        else Object.assign(tagSearchBooks.value[resultIndex], payload.book)
      }
      if (payload.bookId === currentContext.value?.bookId) await applyBook(payload.book, { showDetail: false })
      else refreshStoreBookList(bookDetail.value)
    }),
    window.bookDetailApi.onLibraryChanged(async () => {
      if (currentContext.value) await loadContext(currentContext.value, { showDetail: !tagSearchVisible.value })
      if (tagSearchVisible.value && tagSearchRequest.value) {
        await runLocalSearch(tagSearchRequest.value, tagSearchTitle.value)
      }
    }),
    window.bookDetailApi.onLockState(lock => {
      auditLocked.value = Boolean(lock?.auditRunning)
    }),
    window.bookDetailApi.onSettingChanged(nextSetting => {
      setting.value = nextSetting || {}
      document.documentElement.className = setting.value.theme || 'light e-hentai'
      if (['zh-CN', 'zh-TW', 'en-US'].includes(setting.value.language)) locale.value = setting.value.language
    }),
    window.bookDetailApi.onTranslationChanged(translation => {
      resolvedTranslation.value = translation || {}
    }),
    window.bookDetailApi.onMessage(message => {
      printMessage('info', message)
      if (String(message).includes('failed')) console.error(message)
    })
  )

  window.addEventListener('keydown', resolveKey)
  window.addEventListener('wheel', resolveWheel)
  window.addEventListener('mousedown', resolveMouseDown)

  const context = await window.bookDetailApi.getContext()
  if (context) await loadContext(context)
  window.bookDetailApi.getTagCatalog().then(catalog => {
    tagCatalog.value = catalog || {}
    if (bookDetail.value?.id) refreshStoreBookList(bookDetail.value)
  }).catch(error => console.error(error))
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', resolveKey)
  window.removeEventListener('wheel', resolveWheel)
  window.removeEventListener('mousedown', resolveMouseDown)
  for (const dispose of disposers) dispose()
})
</script>

<style lang="stylus">
html, body, #book-detail-app, .book-detail-window
  width: 100%
  height: 100%
  margin: 0
  overflow: hidden
  background: var(--el-bg-color)

.book-detail-window
  position: relative

.local-search-view
  box-sizing: border-box
  width: 100%
  height: 100%
  padding: 18px 20px 12px
  color: var(--el-text-color-primary)

.local-search-header
  height: 46px
  display: flex
  align-items: center
  gap: 12px
  border-bottom: 1px solid var(--el-border-color)
  h2
    min-width: 0
    margin: 0
    font-size: 18px
    font-weight: 600
    flex: 1
    overflow: hidden
    text-overflow: ellipsis
    white-space: nowrap

.local-search-scroll
  height: calc(100% - 98px)

.local-search-grid
  display: grid
  grid-template-columns: repeat(auto-fill, 220px)
  justify-content: center
  align-items: start
  gap: 18px
  padding: 18px 4px

.local-search-footer
  height: 52px
  display: flex
  align-items: center
  justify-content: center
  border-top: 1px solid var(--el-border-color)
</style>

<template>
  <el-config-provider :locale="elementLocale">
    <main class="book-detail-window" v-loading="loading">
      <BookDetailDialog
        ref="detailRef"
        standalone
        @open-content-view="book => requestMainAction('openContentView', book)"
        @open-thumbnail-view="book => requestMainAction('openThumbnailView', book)"
        @open-search-dialog="openSearchDialog"
        @get-book-info="getBookInfo"
        @search-from-tag="searchFromTag"
        @jump-mange-detail="jumpBook"
        @handle-remove-book-display="handleBookRemoved"
        @request-main-action="requestMainAction"
      />
      <SearchDialog ref="searchRef" />
    </main>
  </el-config-provider>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import zhCn from 'element-plus/dist/locale/zh-cn.mjs'
import zhTw from 'element-plus/dist/locale/zh-tw.mjs'
import en from 'element-plus/dist/locale/en.mjs'
import BookDetailDialog from './components/BookDetailDialog.vue'
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
  auditLocked
} = storeToRefs(appStore)

setting.value = props.initialBootstrap.setting || {}
resolvedTranslation.value = props.initialBootstrap.translation || {}
auditLocked.value = Boolean(props.initialBootstrap.lock?.auditRunning)

const detailRef = ref(null)
const searchRef = ref(null)
const loading = ref(true)
const currentContext = ref(null)
const tagCatalog = ref({})
const disposers = []
let loadRequestId = 0
let activeLoadKey = null

const elementLocale = computed(() => {
  if (setting.value.language === 'zh-TW') return zhTw
  if (setting.value.language === 'en-US') return en
  return zhCn
})

const refreshStoreBookList = book => {
  if (!book?.id) {
    bookList.value = []
    displayBookList.value = []
    return
  }
  const catalogEntry = { id: '__book_detail_tag_catalog__', tags: tagCatalog.value }
  bookList.value = [book, catalogEntry]
  displayBookList.value = [book]
}

const applyBook = async (book, { open = false } = {}) => {
  if (!book?.id) return
  if (!open && bookDetail.value?.id === book.id) {
    Object.assign(bookDetail.value, book)
    const current = bookList.value.find(item => item.id === book.id)
    if (current && current !== bookDetail.value) Object.assign(current, book)
    return
  }
  bookDetail.value = book
  refreshStoreBookList(bookDetail.value)
  await nextTick()
  detailRef.value?.openBookDetail(bookDetail.value, false)
}

const loadContext = async context => {
  if (!context?.bookId) return
  const loadKey = `${context.bookId}:${(context.navigationIds || []).join(',')}`
  if (loading.value && activeLoadKey === loadKey) return
  const requestId = ++loadRequestId
  activeLoadKey = loadKey
  loading.value = true
  try {
    const book = await window.bookDetailApi.getBook(context.bookId)
    if (requestId !== loadRequestId) return
    if (!book) {
      ElMessage.error(t('c.bookDetailNotFound'))
      await window.bookDetailApi.closeWindow()
      return
    }
    currentContext.value = context
    await applyBook(book, { open: true })
  } catch (error) {
    console.error(error)
    ElMessage.error(String(error?.message || error))
  } finally {
    if (requestId === loadRequestId) {
      activeLoadKey = null
      loading.value = false
    }
  }
}

const jumpBook = async step => {
  const context = currentContext.value
  const ids = context?.navigationIds || []
  const currentIndex = ids.indexOf(context?.bookId)
  const nextIndex = currentIndex + step
  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= ids.length) {
    appStore.printMessage('info', t('c.outOfRange'))
    return
  }
  const nextContext = await window.bookDetailApi.navigate({
    bookId: ids[nextIndex],
    navigationIds: ids
  })
  await loadContext(nextContext)
}

const requestMainAction = async (action, book = bookDetail.value) => {
  await window.bookDetailApi.requestMainAction({ action, bookId: book?.id })
}

const searchFromTag = async (tag, cat) => {
  await window.bookDetailApi.requestMainAction({
    action: 'searchFromTag',
    bookId: bookDetail.value?.id,
    payload: { tag, cat }
  })
}

const openSearchDialog = () => searchRef.value?.openSearchDialog(bookDetail.value)
const getBookInfo = () => searchRef.value?.getBookInfo(bookDetail.value)
const handleBookRemoved = () => window.bookDetailApi.closeWindow()

onMounted(async () => {
  disposers.push(
    window.bookDetailApi.onOpen(loadContext),
    window.bookDetailApi.onBookChanged(async payload => {
      if (payload?.bookId !== currentContext.value?.bookId) return
      if (payload.type === 'deleted' || !payload.book) {
        ElMessage.info(t('c.bookDetailDeleted'))
        await window.bookDetailApi.closeWindow()
        return
      }
      await applyBook(payload.book)
    }),
    window.bookDetailApi.onLibraryChanged(async () => {
      if (currentContext.value) await loadContext(currentContext.value)
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
    })
  )

  const context = await window.bookDetailApi.getContext()
  if (context) await loadContext(context)
  window.bookDetailApi.getTagCatalog().then(catalog => {
    tagCatalog.value = catalog || {}
    if (bookDetail.value?.id) refreshStoreBookList(bookDetail.value)
  }).catch(error => console.error(error))
})

onBeforeUnmount(() => {
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
</style>

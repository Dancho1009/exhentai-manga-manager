<template>
  <el-dialog v-model="dialogVisibleEhSearch"
    width="60vw"
    :title="$t('m.search')"
    destroy-on-close
    class="dialog-search"
  >
    <el-form :inline="true">
      <el-form-item>
        <el-input
          v-model="searchStringDialog"
          @keyup.enter="getBookListFromWeb(bookDetail.hash.toUpperCase(), searchStringDialog, searchTypeDialog, bookDetail.filepath)"
          class="search-input"
        >
          <template #append>
            <el-select class="search-type-select" v-model="searchTypeDialog">
              <el-option v-for="searchType in searchTypeList" :key="searchType.value" :label="searchType.label" :value="searchType.value" />
            </el-select>
          </template>
        </el-input>
      </el-form-item>
      <el-form-item>
        <el-button
          type="primary" plain :icon="Search32Filled"
          @click="getBookListFromWeb(bookDetail.hash.toUpperCase(), searchStringDialog, searchTypeDialog, bookDetail.filepath)"
        />
      </el-form-item>
      <el-form-item>
        <el-button
          type="primary" plain :icon="Link"
          @click="redirectSearch(bookDetail.hash.toUpperCase(), searchStringDialog, searchTypeDialog)"
        />
      </el-form-item>
    </el-form>
    <div v-loading="searchResultLoading">
      <div class="search-result" v-if="ehSearchResultList.length > 0">
        <p
          v-for="result in ehSearchResultList"
          :key="result.url"
          @click="resolveSearchResult(bookDetail.id, result.url, result.type)"
          class="search-result-ind"
        >{{result.title}}</p>
      </div>
      <el-empty v-else :description="$t('m.noResults')" :image-size="100" />
    </div>
  </el-dialog>
</template>

<script setup>
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Search32Filled } from '@vicons/fluent'
import { Link } from '@element-plus/icons-vue'
import he from 'he'

import { storeToRefs } from 'pinia'
import { useAppStore } from '../pinia.js'
const appStore = useAppStore()
const {
  searchTypeList, categoryOption,
  setting, bookList, serviceAvailable,
  cookie, tag2cat
} = storeToRefs(appStore)
const { printMessage, returnTrimFileName, runWithTaskMessage, saveBook } = appStore

const { t } = useI18n()

const dialogVisibleEhSearch = ref(false)
const searchResultLoading = ref(false)
const searchStringDialog = ref('')
const searchTypeDialog = ref('')
const ehSearchResultList = ref([])
const bookDetail = ref({})

const createSerialQueue = () => {
  let queue = Promise.resolve()
  return (task) => {
    const result = queue.then(task)
    queue = result.catch(() => {})
    return result
  }
}

const runSerially = async (items, task, shouldContinue = () => true) => {
  for (let index = 0; index < items.length; index++) {
    if (!shouldContinue()) break
    await task(items[index], index)
  }
}

const openSearchDialog = (book, server) => {
  if (!searchTypeDialog.value) searchTypeDialog.value = setting.value.defaultScraper || 'exhentai'
  dialogVisibleEhSearch.value = true
  bookDetail.value = _.cloneDeep(book)
  if (server) searchTypeDialog.value = server
  ehSearchResultList.value = []
  searchStringDialog.value = returnTrimFileName(bookDetail.value)
  getBookListFromWeb(bookDetail.value.hash.toUpperCase(), searchStringDialog.value, searchTypeDialog.value, bookDetail.value.filepath)
}



const resolveSearchResult = async (bookId, url, type) => {
  const book = _.find(bookList.value, {id: bookId})
  if (type === 'hentag') {
    book.url = url
    await getBookInfoFromHentag(book)
  } else if (type === 'e-hentai') {
    await getBookInfoFromEh(book, url)
  } else if (type === 'nhentai') {
    book.url = url
    await getBookInfoFromNhentai(book)
  }
  dialogVisibleEhSearch.value = false
}

const applyBookInfoFromHentag = (book, data) => {
  const tags = {}
  data.language === 11 ? tags['language'] = ['chinese','translated'] : ''
  data.parodies.length > 0 ? tags['parody'] = data.parodies.map(parody => parody.name) : ''
  data.characters.length > 0 ? tags['character'] = data.characters.map(character => character.name) : ''
  data.circles.length > 0 ? tags['group'] = data.circles.map(circle => circle.name) : ''
  data.artists.length > 0 ? tags['artist'] = data.artists.map(artist => artist.name) : ''
  data.maleTags.length > 0 ? tags['male'] = data.maleTags.map(maleTag => maleTag.name) : ''
  data.femaleTags.length > 0 ? tags['female'] = data.femaleTags.map(femaleTag => femaleTag.name) : ''
  if (data.otherTags.length > 0) {
    data.otherTags.forEach(({ name }) => {
      const cat = tag2cat.value[name]
      if (cat) {
        if (tags[cat]) {
          tags[cat].push(name)
        } else {
          tags[cat] = [name]
        }
      } else {
        if (tags['misc']) {
          tags['misc'].push(name)
        } else {
          tags['misc'] = [name]
        }
      }
    })
  }
  _.assign(book, {
    title: data.title,
    posted: Math.floor(data.createdAt / 1000),
    category: categoryOption.value[data.category - 1],
    tags
  })
  book.status = 'tagged'
}

const fetchAndApplyBookInfoFromHentag = async (book) => {
  const data = await fetch(`https://hentag.com/public/api/vault/${book.url.slice(25)}`).then(res => res.json())
  applyBookInfoFromHentag(book, data)
}

const getBookInfoFromHentag = async (book) => {
  await fetchAndApplyBookInfoFromHentag(book)
  await saveBook(book)
}

const applyBookInfoFromEh = (book, metadata) => {
  _.assign(
    book,
    _.pick(metadata, ['tags', 'title', 'title_jpn', 'filecount', 'rating', 'posted', 'filesize', 'category']),
  )
  book.posted = +book.posted
  book.filecount = +book.filecount
  book.rating = +book.rating
  book.title = he.decode(book.title)
  book.title_jpn = he.decode(book.title_jpn)
  const tagObject = _.groupBy(book.tags, tag => {
    const result = /(.+):/.exec(tag)
    if (result) {
      return /(.+):/.exec(tag)[1]
    } else {
      return 'misc'
    }
  })
  _.forIn(tagObject, (arr, key) => {
    tagObject[key] = arr.map(tag => {
      const result = /:(.+)$/.exec(tag)
      if (result) {
        return /:(.+)$/.exec(tag)[1]
      } else {
        return tag
      }
    })
  })
  book.tags = tagObject
  book.status = 'tagged'
}

const summarizeEhResult = result => {
  const statuses = Object.values(result?.sites || {}).map(site => site.status)
  if (['network-error', 'service-unavailable', 'unknown'].includes(result?.gdata?.status)) return 'network'
  if (statuses.includes('available')) return 'success'
  if (statuses.includes('auth-required') || statuses.includes('ip-banned')) return 'blocked'
  if (statuses.some(status => ['network-error', 'service-unavailable', 'unknown'].includes(status))) return 'network'
  if (statuses.includes('copyright')) return 'copyright'
  return 'unavailable'
}

const applyBookInfoFromEhFailure = (result, silent = false) => {
  const statuses = Object.values(result?.sites || {}).map(site => site.status)
  if (statuses.includes('ip-banned')) {
    printMessage('error', t('c.ipBanned'))
    serviceAvailable.value = false
  } else if (statuses.includes('auth-required')) {
    if (!silent) printMessage('error', t('c.ehentaiAuthRequired'))
    serviceAvailable.value = false
  } else if (!silent) {
    printMessage('error', t('c.getMetadataFailed'))
  }
}

const fetchAndApplyBookInfoFromEh = async (book, candidateUrl = book.url, { silent = false } = {}) => {
  const result = await ipcRenderer.invoke('ehentai:get-metadata', {
    url: candidateUrl
  })
  const status = summarizeEhResult(result)
  const hasAvailablePage = Object.values(result?.sites || {}).some(site => site.status === 'available')
  const hasUncertainPage = Object.values(result?.sites || {}).some(site =>
    ['auth-required', 'ip-banned', 'service-unavailable', 'network-error', 'unknown'].includes(site.status)
  )
  if (result?.gdata?.status !== 'available' || !result.gdata.metadata || (!hasAvailablePage && hasUncertainPage)) {
    applyBookInfoFromEhFailure(result, silent)
    return { changed: false, status, result }
  }
  const nextBook = _.cloneDeep(book)
  nextBook.url = result.preferredUrl || candidateUrl
  applyBookInfoFromEh(nextBook, result.gdata.metadata)
  _.assign(book, nextBook)
  if (!silent && status === 'copyright') {
    const claimant = Object.values(result.sites).find(site => site.status === 'copyright')?.claimant || ''
    printMessage('warning', t('c.ehentaiCopyright', { claimant }))
  }
  return { changed: true, status, result }
}

const getBookInfoFromEh = async (book, candidateUrl = book.url) => {
  const outcome = await fetchAndApplyBookInfoFromEh(book, candidateUrl)
  if (outcome.changed) await saveBook(book)
  return outcome
}

const isNhentaiMissingApiKeyError = (error) => {
  return String(error?.message || '').includes('NHENTAI_API_KEY_MISSING')
}

const handleNhentaiError = (error) => {
  if (isNhentaiMissingApiKeyError(error)) {
    serviceAvailable.value = false
    printMessage('error', t('c.nhentaiMissingApiKey'))
  } else {
    printMessage('error', t('c.getMetadataFailed'))
  }
}

const applyBookInfoFromNhentai = (book, metadata) => {
  _.assign(
    book,
    _.pick(metadata, ['tags', 'title', 'title_jpn', 'filecount', 'posted', 'category', 'url', 'status']),
  )
  if (book.filecount !== undefined) book.filecount = +book.filecount
  if (book.posted !== undefined) book.posted = +book.posted
  if (book.title) book.title = he.decode(book.title)
  if (book.title_jpn) book.title_jpn = he.decode(book.title_jpn)
  book.status = 'tagged'
}

const fetchAndApplyBookInfoFromNhentai = async (book) => {
  try {
    const metadata = await ipcRenderer.invoke('nhentai-metadata', {
      url: book.url,
      filepath: book.filepath,
      title: returnTrimFileName(book)
    })
    if (!metadata) return false
    applyBookInfoFromNhentai(book, metadata)
    return true
  } catch (error) {
    handleNhentaiError(error)
    throw error
  }
}

const getBookInfoFromNhentai = async (book) => {
  const changed = await fetchAndApplyBookInfoFromNhentai(book)
  if (changed) await saveBook(book)
}

const getBookInfo = (book) => {
  if (!book.url) return Promise.resolve()
  if (book.url.startsWith('https://hentag.com')) {
    return getBookInfoFromHentag(book)
  } else if (book.url.includes('exhentai') || book.url.includes('e-hentai')) {
    return getBookInfoFromEh(book)
  } else if (book.url.includes('nhentai.net/g/')) {
    return getBookInfoFromNhentai(book)
  }
  return Promise.resolve()
}
const getBooksMetadata = async (bookList, gap, callback, options = {}) => {
  const server = options.server || setting.value.defaultScraper || 'exhentai'
  serviceAvailable.value = true
  const timer = ms => new Promise(res => setTimeout(res, ms))
  const saveQueue = createSerialQueue()
  let completedCount = 0
  const stats = { success: 0, copyright: 0, unavailable: 0, blocked: 0, network: 0 }
  try {
    await runWithTaskMessage({
      message: t('c.gettingMetadata'),
      showClose: true,
      onClose: () => {
        serviceAvailable.value = false
      },
      task: async () => {
        await runSerially(bookList, async (book) => {
          try {
            if (!serviceAvailable.value) return
            let outcome = { changed: false, status: 'unavailable' }
            if (!book.url || options.forceSearch) {
              const resultList = await getBookListFromWebRaw(
                book.hash.toUpperCase(),
                returnTrimFileName(book),
                server,
                book.filepath
              )
              if (resultList?.[0]) {
                outcome = await fetchAndApplySearchResult(book, resultList[0].url, resultList[0].type, { silent: true })
                if (outcome.changed) await saveQueue(() => saveBook(book))
              }
            } else {
              outcome = await fetchAndApplyBookInfo(book, { silent: true })
              if (outcome.changed) await saveQueue(() => saveBook(book))
            }
            stats[outcome.status] = (stats[outcome.status] || 0) + 1
            await timer(gap)
          } catch (error) {
            stats.network += 1
            console.error(error)
          } finally {
            completedCount += 1
            ipcRenderer.invoke('set-progress-bar', bookList.length ? completedCount / bookList.length : 1)
          }
        }, () => serviceAvailable.value)
      }
    })
    printMessage('success', t('c.metadataBatchSummary', stats))
  } finally {
    ipcRenderer.invoke('set-progress-bar', -1)
    if (callback) callback()
  }
}

const fetchAndApplyBookInfo = async (book, options = {}) => {
  if (book.url.startsWith('https://hentag.com')) {
    await fetchAndApplyBookInfoFromHentag(book)
    return { changed: true, status: 'success' }
  } else if (book.url.includes('exhentai') || book.url.includes('e-hentai')) {
    return await fetchAndApplyBookInfoFromEh(book, book.url, options)
  } else if (book.url.includes('nhentai.net/g/')) {
    const changed = await fetchAndApplyBookInfoFromNhentai(book)
    return { changed, status: changed ? 'success' : 'unavailable' }
  }
  return { changed: false, status: 'unavailable' }
}

const fetchAndApplySearchResult = async (book, url, type, options = {}) => {
  if (type === 'hentag') {
    book.url = url
    await fetchAndApplyBookInfoFromHentag(book)
    return { changed: true, status: 'success' }
  } else if (type === 'e-hentai') {
    return await fetchAndApplyBookInfoFromEh(book, url, options)
  } else if (type === 'nhentai') {
    book.url = url
    const changed = await fetchAndApplyBookInfoFromNhentai(book)
    return { changed, status: changed ? 'success' : 'unavailable' }
  }
  return { changed: false, status: 'unavailable' }
}

const getBookListFromWebRaw = async (bookHash, title, server = 'e-hentai', bookPath = '') => {
  let resultList = []
  if (server === 'e-hentai') {
    resultList = await fetch(`https://e-hentai.org/?f_shash=${bookHash}&fs_similar=on&fs_exp=on&f_cats=161`)
    .then(res => res.text())
    .then(res => {
      return resolveEhentaiResult(res)
    })
  } else if (server === 'exhentai') {
    resultList = await ipcRenderer.invoke('get-ex-webpage', {
      url: `https://exhentai.org/?f_shash=${bookHash}&fs_similar=on&fs_exp=on&f_cats=161`,
      cookie: cookie.value
    })
    .then(res => {
      return resolveEhentaiResult(res)
    })
  } else if (server === 'e-search') {
    resultList = await fetch(`https://e-hentai.org/?f_search=${encodeURI(title)}&f_cats=161`)
    .then(res => res.text())
    .then(res => {
      return resolveEhentaiResult(res)
    })
  } else if (server === 'exsearch') {
    resultList = await ipcRenderer.invoke('get-ex-webpage', {
      url: `https://exhentai.org/?f_search=${encodeURI(title)}&f_cats=161`,
      cookie: cookie.value
    })
    .then(res => {
      return resolveEhentaiResult(res)
    })
  } else if (server === 'hentag') {
    resultList = await fetch(`https://hentag.com/public/api/vault-search?t=${encodeURI(title)}`)
    .then(res => res.json())
    .then(res => {
      return resolveHentagResult(res)
    })
  } else if (server === 'nhentai') {
    try {
      resultList = await ipcRenderer.invoke('nhentai-search', {
        title,
        filepath: bookPath
      })
    } catch (error) {
      handleNhentaiError(error)
      resultList = []
    }
  } else if (server === '.ehviewer') {
    const ehviewerData = await ipcRenderer.invoke('get-ehviewer-data', bookPath)

    if (ehviewerData) {
      resultList = [{
        title,
        url: `https://exhentai.org/g/${ehviewerData.gid}/${ehviewerData.token}/`,
        type: 'e-hentai'
      }]
    }
  }
  return resultList
}

const getBookListFromWeb = async (bookHash, title, server = 'e-hentai', bookPath = '') => {
  searchResultLoading.value = true
  ehSearchResultList.value = []
  try {
    const resultList = await getBookListFromWebRaw(bookHash, title, server, bookPath)
    ehSearchResultList.value = resultList || []
    return resultList
  } finally {
    searchResultLoading.value = false
  }
}

const redirectSearch = (bookHash, title, server = 'e-hentai') => {
  let url
  switch (server) {
    case 'e-hentai':
      url = `https://e-hentai.org/?f_shash=${bookHash}&fs_similar=on&fs_exp=on&f_cats=161`
      break
    case 'exhentai':
      url = `https://exhentai.org/?f_shash=${bookHash}&fs_similar=on&fs_exp=on&f_cats=161`
      break
    case 'e-search':
      url = `https://e-hentai.org/?f_search=${encodeURI(title)}&f_cats=161`
      break
    case '.ehviewer':
    case 'exsearch':
      url = `https://exhentai.org/?f_search=${encodeURI(title)}&f_cats=161`
      break
    case 'hentag':
      url = `https://hentag.com/?t=${encodeURI(title)}`
      break
    case 'nhentai':
      url = `https://nhentai.net/search/?q=${encodeURI(title)}`
      break
  }
  ipcRenderer.invoke('open-url', url)
}

const resolveEhentaiResult = (htmlString) => {
  try {
    const resultNodes = new DOMParser().parseFromString(htmlString, 'text/html').querySelectorAll('.gl3c.glname')
    const resultList = []
    resultNodes.forEach((node) => {
      resultList.push({
        title: node.querySelector('.glink').innerHTML,
        url: node.querySelector('a').getAttribute('href'),
        type: 'e-hentai'
      })
    })
    return resultList
  } catch (e) {
    console.log(e)
    if (htmlString.includes('Your IP address has been')) {
      serviceAvailable.value = false
      printMessage('error', t('c.ipBanned'))
    } else {
      printMessage('error', t('c.getMetadataFailed'))
    }
  }
}

const resolveHentagResult = (data) => {
  const resultList = data.works.slice(0, 30)
  return resultList.map((result) => {
    const findExUrl = result.locations.find((location) => location.startsWith('https://exhentai.org'))
    if (findExUrl) {
      return {
        title: result.title,
        url: findExUrl,
        type: 'e-hentai'
      }
    } else {
      return {
        title: result.title,
        url: `https://hentag.com/vault/${result.id}`,
        type: 'hentag'
      }
    }
  })
}

defineExpose({
  dialogVisibleEhSearch,
  openSearchDialog,
  getBookInfo,
  getBooksMetadata,
})

</script>

<style lang="stylus">
.dialog-search
  .el-form-item
    margin-right: 4px
  .search-input
    width: calc(60vw - 152px)
  .search-type-select
    width: 160px
  .search-result-ind
    cursor: pointer
    text-align: left
    margin: 8px 0
  .search-result-ind:hover
    background-color: var(--el-fill-color-dark)
</style>

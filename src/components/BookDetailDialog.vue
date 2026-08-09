<template>
  <el-dialog v-model="dialogVisibleBookDetail"
    fullscreen
    class="dialog-detail"
  >
    <template #header>
      <p class="detail-book-title">
        <span class="url-link" @click="openUrl(bookDetail.url)" @contextmenu="onMangaTitleContextMenu($event, bookDetail)">{{getDisplayTitle(bookDetail)}}</span>
      </p>
    </template>
    <el-row :gutter="20" class="book-detail-card">
      <el-col :span="6">
        <el-row class="book-detail-function book-detail-cover-frame">
          <img
            class="book-detail-cover"
            :src="bookDetail.coverPath"
            @click="$emit('openContentView', bookDetail)"
            @mousedown.middle.prevent="openLocalBook(bookDetail)"
            @contextmenu="$emit('openThumbnailView', bookDetail)"
          />
          <el-icon
            :size="30"
            :color="bookDetail.mark ? '#E6A23C' : '#666666'"
            class="book-detail-star" @click="!auditLocked && switchMark(bookDetail)"
          ><BookmarkTwotone /></el-icon>
          <div class="next-manga-pane" @click="$emit('jumpMangeDetail', 1)"><el-icon text><CaretRight20Regular /></el-icon></div>
          <div class="prev-manga-pane" @click="$emit('jumpMangeDetail', -1)"><el-icon text><CaretLeft20Regular /></el-icon></div>
        </el-row>
        <el-row :gutter="20" class="book-detail-rate">
          <el-rate v-model="bookDetail.rating" size="large" allow-half :disabled="auditLocked" @change="saveBook(bookDetail)"/>
        </el-row>
        <el-row class="book-detail-function">
          <el-descriptions :column="1">
            <el-descriptions-item :label="$t('m.pageCount')+':'" :class-name="bookDetail.pageDiff ? 'text-red' : ''">
              {{bookDetail.pageCount}} | {{bookDetail.filecount}}
            </el-descriptions-item>
            <el-descriptions-item :label="$t('m.fileSize')+':'">
              {{Math.floor(bookDetail.bundleSize / 1048576)}} | {{Math.floor(bookDetail.filesize / 1048576)}} MB
            </el-descriptions-item>
            <el-descriptions-item :label="$t('m.readCount')+':'">{{bookDetail.readCount}}</el-descriptions-item>
            <el-descriptions-item :label="$t('m.mtime')+':'">{{new Date(bookDetail.mtime).toLocaleString("zh-CN")}}</el-descriptions-item>
            <el-descriptions-item :label="$t('m.postTime')+':'">{{new Date(bookDetail.posted * 1000).toLocaleString("zh-CN")}}</el-descriptions-item>
          </el-descriptions>
        </el-row>
        <el-row class="book-detail-function">
          <el-button-group style="margin-right: 12px;">
            <el-button type="success" style="padding-right: 0;" plain @click="openLocalBook(bookDetail)">{{$t('m.re')}}</el-button>
            <el-button type="success" style="padding-left: 0;" plain @click="$emit('openContentView', bookDetail)">{{$t('m.ad')}}</el-button>
          </el-button-group>
          <el-button plain @click="triggerShowComment">{{setting.showComment ? $t('m.hideComment') : $t('m.showComment')}}</el-button>
          <el-button type="primary" plain @click="editTags" :disabled="auditLocked">{{editingTag ? $t('m.showTag') : $t('m.editTag')}}</el-button>
        </el-row>
        <el-row class="book-detail-function">
          <el-button type="primary" plain
            @click="$emit('openSearchDialog')" :disabled="auditLocked"
          >{{$t('m.getMetadata')}}</el-button>
          <el-button type="primary" plain @click="triggerHiddenBook(bookDetail)" :disabled="auditLocked">{{bookDetail.hiddenBook ? $t('m.showManga') : $t('m.hideManga')}}</el-button>
        </el-row>
        <el-row class="book-detail-function">
          <el-button type="danger" plain @click="deleteLocalBook(bookDetail)" :disabled="auditLocked">{{$t('m.deleteFile')}}</el-button>
          <el-button plain @click="rescanBook(bookDetail)" :disabled="auditLocked">{{$t('m.rescan')}}</el-button>
          <el-button type="primary" plain @click="showFile(bookDetail.filepath)">{{$t('m.openMangaFileLocation')}}</el-button>
        </el-row>
      </el-col>
      <el-col :span="setting.showComment ? 10 : 18">
        <el-scrollbar class="book-tag-frame">
          <div v-if="editingTag">
            <div class="edit-line">
              <el-input v-model="bookDetail.title_jpn" :placeholder="$t('m.title')" :disabled="auditLocked" @change="saveBook(bookDetail)"></el-input>
            </div>
            <div class="edit-line">
              <el-input v-model="bookDetail.title" :placeholder="$t('m.englishTitle')" :disabled="auditLocked" @change="saveBook(bookDetail)"></el-input>
            </div>
            <div class="edit-line">
              <el-select v-model="bookDetail.status" :placeholder="$t('m.metadataStatus')" :disabled="auditLocked" @change="saveBook(bookDetail)">
                <el-option v-for="status in statusOption" :value="status" :key="status" :label="status" />
              </el-select>
            </div>
            <div class="edit-line">
              <el-input v-model="bookDetail.url" :placeholder="$t('m.ehexAddress')" :disabled="auditLocked" @change="saveBook(bookDetail)"></el-input>
            </div>
            <div class="edit-line">
              <el-select v-model="bookDetail.category" :placeholder="$t('m.category')" :disabled="auditLocked" @change="saveBook(bookDetail)" clearable>
                <el-option v-for="cat in categoryOption" :value="cat" :key="cat" :label="cat" />
              </el-select>
            </div>
            <div class="edit-line" v-for="(arr, key) in tagGroup" :key="key">
              <el-select-v2
                v-model="bookDetail.tags[key]" :placeholder="key" @change="saveBookTags(bookDetail)"
                filterable clearable allow-create multiple :reserve-keyword="false" :height="340" :disabled="auditLocked"
                :options="arr"
              >
              </el-select-v2>
            </div>
            <el-space wrap class="tag-edit-buttons">
              <el-button @click="addTagCat" :disabled="auditLocked">{{$t('m.addCategory')}}</el-button>
              <el-button @click="$emit('getBookInfo')" :disabled="auditLocked">{{$t('m.getTagbyUrl')}}</el-button>
              <el-button @click="resetMetadata(bookDetail)" :disabled="auditLocked">{{$t('m.resetMetadata')}}</el-button>
              <el-button @click="copyTagClipboard(bookDetail)">{{$t('m.copyTagClipboard')}}</el-button>
              <el-button @click="pasteTagClipboard(bookDetail)" :disabled="auditLocked">{{$t('m.pasteTagClipboard')}}</el-button>
            </el-space>
          </div>
          <div v-else>
            <el-descriptions :column="1">
              <el-descriptions-item :label="$t('m.title')+':'">{{bookDetail.title_jpn}}</el-descriptions-item>
              <el-descriptions-item :label="$t('m.englishTitle')+':'">{{bookDetail.title}}</el-descriptions-item>
              <el-descriptions-item :label="$t('m.filename')+':'">{{returnFileNameWithExt(bookDetail.filepath)}}</el-descriptions-item>
              <el-descriptions-item :label="$t('m.fileLocation')+':'">{{returnDirname(bookDetail.filepath)}}</el-descriptions-item>
              <el-descriptions-item v-if="showEhAvailability()" :label="$t('audit.sourceAvailability')+':'">
                <div class="source-availability">
                  <div class="source-availability-toolbar">
                    <el-button
                      text circle :icon="Refresh" :loading="availabilityLoading"
                      :title="$t('audit.refreshAvailability')"
                      @click="refreshEhAvailability(bookDetail, true)"
                    />
                  </div>
                  <div v-if="ehSources.current.url" class="source-availability-group">
                    <div class="source-url url-link" @click="openUrl(ehSources.current.url)">
                      {{$t('audit.currentUrl')}}: {{ehSources.current.url}}
                    </div>
                    <div v-if="ehSources.current.preferredUrl && ehSources.current.preferredUrl !== ehSources.current.url" class="source-url url-link" @click="openUrl(ehSources.current.preferredUrl)">
                      {{$t('audit.preferredUrl')}}: {{ehSources.current.preferredUrl}}
                    </div>
                    <div class="source-site-list">
                      <span v-for="site in ehSiteNames" :key="`current-${site}`">
                        {{siteLabel(site)}}
                        <el-tag size="small" :type="availabilityTagType(ehSources.current.availability?.sites?.[site]?.status)">
                          {{availabilityLabel(ehSources.current.availability?.sites?.[site])}}
                        </el-tag>
                      </span>
                    </div>
                  </div>
                  <div v-if="ehSources.ehviewer.url && !sameEhIdentity(ehSources.current.url, ehSources.ehviewer.url)" class="source-availability-group">
                    <div class="source-url url-link" @click="openUrl(ehSources.ehviewer.url)">
                      {{$t('audit.ehviewerUrl')}}: {{ehSources.ehviewer.url}}
                    </div>
                    <div v-if="ehSources.ehviewer.preferredUrl && ehSources.ehviewer.preferredUrl !== ehSources.ehviewer.url" class="source-url url-link" @click="openUrl(ehSources.ehviewer.preferredUrl)">
                      {{$t('audit.preferredUrl')}}: {{ehSources.ehviewer.preferredUrl}}
                    </div>
                    <div class="source-site-list">
                      <span v-for="site in ehSiteNames" :key="`ehviewer-${site}`">
                        {{siteLabel(site)}}
                        <el-tag size="small" :type="availabilityTagType(ehSources.ehviewer.availability?.sites?.[site]?.status)">
                          {{availabilityLabel(ehSources.ehviewer.availability?.sites?.[site])}}
                        </el-tag>
                      </span>
                    </div>
                  </div>
                </div>
              </el-descriptions-item>
              <el-descriptions-item :label="$t('m.category')+':'">
                <el-tag type="info" class="book-tag" @click="$emit('searchFromTag', `cat:${bookDetail.category}`)">{{bookDetail.category}}</el-tag>
              </el-descriptions-item>
              <el-descriptions-item v-for="(tagArr, key) in bookDetail.tags" :label="resolvedTranslation[key]?._name || key + ':'" :key="key">
                <el-popover
                  effect="dark"
                  trigger="hover"
                  :content="resolvedTranslation[key]?.[tag]?.intro || tag"
                  :disabled="!resolvedTranslation[key]?.[tag]?.intro"
                  placement="top-start"
                  :show-after="500"
                  width="300px"
                  v-for="tag in tagArr" :key="tag"
                >
                  <template #reference>
                    <el-tag
                      type="info"
                      class="book-tag"
                      @click="$emit('searchFromTag', tag, key)"
                    >{{resolvedTranslation[key]?.[tag]?.name || tag }}</el-tag>
                  </template>
                </el-popover>
              </el-descriptions-item>
            </el-descriptions>
          </div>
        </el-scrollbar>
      </el-col>
      <el-col :span="8" v-if="setting.showComment">
        <el-scrollbar class="book-comment-frame">
          <el-empty v-if="commentNotice" :description="commentNotice" :image-size="64" />
          <div class="book-comment" v-for="comment in comments" :key="comment.id">
            <div class="book-comment-postby">{{comment.author}}<span class="book-comment-score">{{comment.score}}</span></div>
            <p class="book-comment-content" @contextmenu="onMangaCommentContextMenu($event, comment)">{{comment.content}}</p>
          </div>
        </el-scrollbar>
      </el-col>
    </el-row>
  </el-dialog>
</template>

<script setup>
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessageBox } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import { CaretRight20Regular, CaretLeft20Regular } from '@vicons/fluent'
import { BookmarkTwotone } from '@vicons/material'
import { nanoid } from 'nanoid'
import he from 'he'
import * as linkify from 'linkifyjs'
import ContextMenu from '@imengyu/vue3-context-menu'
import { storeToRefs } from 'pinia'
import { useAppStore } from '../pinia.js'
import  { insertLocalReadRecord } from '../utils.js'

const appStore = useAppStore()
const {
  setting, bookDetail, resolvedTranslation,
  bookList, displayBookList, collectionList, openCollectionBookList,
  statusOption, categoryOption,
  auditLocked,
  pathSep,
} = storeToRefs(appStore)
const {
  printMessage,
  saveBook,
  returnFileNameWithExt,
  getDisplayTitle,
  resetMetadata,
  switchMark,
  copyTagClipboard,
  pasteTagClipboard,
} = appStore

const { t } = useI18n()

const emit = defineEmits([
  'openContentView',
  'openThumbnailView',
  'saveCollection',
  'handleRemoveBookDisplay',
  'openSearchDialog',
  'getBookInfo',
  'searchFromTag',
  'jumpMangeDetail',
  'addToHistory',
])

const dialogVisibleBookDetail = ref(false)
const ehSiteNames = ['ehentai', 'exhentai']
const emptyEhSource = () => ({ url: null, preferredUrl: null, availability: null })
const ehSources = ref({ current: emptyEhSource(), ehviewer: emptyEhSource() })
const availabilityLoading = ref(false)
const commentNotice = ref('')
let availabilityRequestId = 0

const isEhentaiUrl = url => /(?:e-hentai\.org|exhentai\.org)\/g\/\d+\/[0-9a-z]+/i.test(String(url || ''))
const showEhAvailability = () => isEhentaiUrl(bookDetail.value?.url) || Boolean(ehSources.value.ehviewer.url)

const sameEhIdentity = (first, second) => {
  const getIdentity = value => String(value || '').match(/\/g\/(\d+)\/([0-9a-z]+)/i)?.slice(1).map(part => part.toLowerCase())
  const firstIdentity = getIdentity(first)
  const secondIdentity = getIdentity(second)
  return Boolean(firstIdentity && secondIdentity && firstIdentity[0] === secondIdentity[0] && firstIdentity[1] === secondIdentity[1])
}

const siteLabel = site => site === 'ehentai' ? 'E-Hentai' : 'ExHentai'
const availabilityTagType = status => ({
  available: 'success',
  copyright: 'danger',
  'generic-unavailable': 'danger',
  'gallery-not-found': 'danger',
  'geo-blocked': 'warning',
  'auth-required': 'warning',
  'ip-banned': 'warning',
  'service-unavailable': 'warning',
  'network-error': 'info',
  unknown: 'info',
  unchecked: 'info'
})[status] || 'info'

const availabilityLabel = site => {
  const status = site?.status || 'unchecked'
  const detail = site?.claimant || site?.region
  const label = t(`audit.availability_${status}`)
  return detail ? `${label}: ${detail}` : label
}

const getPreferredAvailableUrl = availability => {
  if (!availability) return null
  return ehSiteNames.some(site => availability.sites?.[site]?.status === 'available')
    ? availability.preferredUrl
    : null
}

const refreshEhAvailability = async (book, force = false) => {
  const requestId = ++availabilityRequestId
  availabilityLoading.value = true
  try {
    const currentUrl = isEhentaiUrl(book?.url) ? book.url : null
    const ehviewer = await ipcRenderer.invoke('get-ehviewer-data', book?.filepath)
    const ehviewerUrl = ehviewer?.gid && ehviewer?.token
      ? `https://exhentai.org/g/${ehviewer.gid}/${ehviewer.token}/`
      : null
    const currentAvailability = currentUrl
      ? await ipcRenderer.invoke('ehentai:get-availability', { url: currentUrl, strategy: 'both', force })
      : null
    const ehviewerAvailability = ehviewerUrl
      ? sameEhIdentity(currentUrl, ehviewerUrl)
        ? currentAvailability
        : await ipcRenderer.invoke('ehentai:get-availability', { url: ehviewerUrl, strategy: 'both', force })
      : null
    if (requestId !== availabilityRequestId) return ehSources.value
    ehSources.value = {
      current: {
        url: currentUrl,
        preferredUrl: getPreferredAvailableUrl(currentAvailability),
        availability: currentAvailability
      },
      ehviewer: {
        url: ehviewerUrl,
        preferredUrl: getPreferredAvailableUrl(ehviewerAvailability),
        availability: ehviewerAvailability
      }
    }
    return ehSources.value
  } catch (error) {
    if (requestId === availabilityRequestId) {
      ehSources.value = {
        current: { url: isEhentaiUrl(book?.url) ? book.url : null, preferredUrl: null, availability: null },
        ehviewer: emptyEhSource()
      }
    }
    console.log(error)
    return ehSources.value
  } finally {
    if (requestId === availabilityRequestId) availabilityLoading.value = false
  }
}

const openBookDetail = (book, addToHistory = true) => {
  bookDetail.value = book
  dialogVisibleBookDetail.value = true
  comments.value = []
  commentNotice.value = ''
  ehSources.value = { current: emptyEhSource(), ehviewer: emptyEhSource() }
  if (setting.value.showComment && (isEhentaiUrl(book?.url) || isNhentaiUrl(book?.url))) getComments(book)
  else if (!isNhentaiUrl(book?.url)) refreshEhAvailability(book)
  if (addToHistory) emit('addToHistory', book.id)
}
const openUrl = (url) => {
  if (url) ipcRenderer.invoke('open-url', url)
}
const triggerHiddenBook = async (book) => {
  book.hiddenBook = !book.hiddenBook
  await saveBook(book)
}


const returnDirname = (filepath) => {
  return filepath.split(/[/\\]/).slice(0, -1).join(pathSep.value)
}

const showFile = (filepath) => {
  ipcRenderer.invoke('show-file', filepath)
}
const openLocalBook = (book) => {
  bookDetail.value = book
  if (setting.value.imageExplorer) {
    bookDetail.value.readCount += 1
    ipcRenderer.invoke('increment-read-count', bookDetail.value.id)
    ipcRenderer.invoke('open-local-book', bookDetail.value.filepath)
  } else {
    emit('openContentView', book)
  }
  insertLocalReadRecord(book.id)
}
const rescanBook = async (book) => {
  const bookInfo = await ipcRenderer.invoke('patch-local-metadata-by-book', _.cloneDeep(book))
  _.assign(book, bookInfo)
  await saveBook(book)
  printMessage('success', t('c.rescanSuccess'))
}
const deleteBook = async (book) => {
  await ipcRenderer.invoke('delete-local-book', book.filepath)
  .finally(() => {
    dialogVisibleBookDetail.value = false
    if (book.collectionHide) {
      _.forEach(collectionList.value, (collection) => {
        collection.list = _.filter(collection.list, hash_id => hash_id !== book.id && hash_id !== book.hash)
      })
      openCollectionBookList.value = _.filter(openCollectionBookList.value, bookOfCollection => {
        return bookOfCollection.id !== book.id && bookOfCollection.id !== book.hash
      })
      emit('saveCollection')
    } else {
      const findBookInBookList = _.findIndex(bookList.value, b => b.filepath === book.filepath)
      bookList.value.splice(findBookInBookList, 1)
      displayBookList.value = _.filter(displayBookList.value, b => b.filepath !== book.filepath)
      emit('handleRemoveBookDisplay')
    }
  })
}
const deleteLocalBook = (book) => {
  if (setting.value.skipDeleteConfirm) {
    deleteBook(book)
  } else {
    ElMessageBox.confirm(
      t('c.confirmDelete'),
      '',
      {}
    )
    .then(() => deleteBook(book))
  }
}

const comments = ref([])
const triggerShowComment = () => {
  if (setting.value.showComment) {
    setting.value.showComment = false
  } else {
    comments.value = []
    commentNotice.value = ''
    getComments(bookDetail.value)
    setting.value.showComment = true
  }
}
const isNhentaiUrl = (url) => {
  return String(url || '').includes('nhentai.net/g/')
}

const isNhentaiMissingApiKeyError = (error) => {
  return String(error?.message || '').includes('NHENTAI_API_KEY_MISSING')
}

const getNhentaiComments = async (book) => {
  try {
    const result = await ipcRenderer.invoke('nhentai-comments', {
      url: book.url,
      filepath: book.filepath,
      title: book.title || book.title_jpn,
      page: 1,
      perPage: 50
    })
    comments.value = result.map(comment => ({
      ...comment,
      foundLink: _.uniqBy(linkify.find(String(comment.content || '').replace(/[<"]/gi, ' '), 'url'), 'href')
    }))
  } catch (err) {
    comments.value = []
    if (isNhentaiMissingApiKeyError(err)) {
      printMessage('error', t('c.nhentaiMissingApiKey'))
    } else {
      console.log(err)
    }
  }
}

const getEhComments = async (url) => {
  if (url) {
    try {
      const page = await ipcRenderer.invoke('ehentai:get-page', { url })
      comments.value = []
      if (page?.status !== 'available') {
        commentNotice.value = page?.status === 'copyright'
          ? t('audit.commentsCopyright', { claimant: page.claimant || t('audit.unknownClaimant') })
          : t('audit.commentsUnavailable', { status: availabilityLabel(page) })
        return
      }
      if (!page.html) throw new Error('EMPTY_GALLERY_RESPONSE')
      const commentElements = new DOMParser().parseFromString(page.html, 'text/html').querySelectorAll('#cdiv>.c1')
      commentElements.forEach(e => {
        const author = e.querySelector('.c2 .c3')?.textContent || ''
        const scoreTail = e.querySelectorAll('.c2 .nosel')
        const score = scoreTail[scoreTail.length - 1]?.textContent || ''
        let content = e.querySelector('.c6')?.innerHTML || ''
        const foundLink = _.uniqBy(linkify.find(content.replace(/[<"]/gi, ' '), 'url'), 'href')
        content = content.replace(/<br>/gi, '\n')
        content = content.replace(/<.+?>/gi, '')
        content = he.decode(content)
        comments.value.push({
          author, score, content, id: nanoid(), foundLink
        })
      })
    } catch (err) {
      comments.value = []
      console.log(err)
    }
  } else {
    comments.value = []
  }
}

const availabilityNotice = availability => {
  const sites = Object.values(availability?.sites || {})
  const copyright = sites.find(site => site.status === 'copyright')
  if (copyright) return t('audit.commentsCopyright', { claimant: copyright.claimant || t('audit.unknownClaimant') })
  const geo = sites.find(site => site.status === 'geo-blocked')
  if (geo) return t('audit.commentsUnavailable', { status: availabilityLabel(geo) })
  const known = sites.find(site => site.status && site.status !== 'unchecked')
  return t('audit.commentsUnavailable', { status: availabilityLabel(known) })
}

const getComments = async (book) => {
  commentNotice.value = ''
  if (!book?.url) {
    comments.value = []
    return
  }
  if (isNhentaiUrl(book.url)) {
    await getNhentaiComments(book)
    return
  }
  if (isEhentaiUrl(book.url)) {
    const sources = await refreshEhAvailability(book)
    const current = sources.current
    if (!current.preferredUrl) {
      comments.value = []
      commentNotice.value = availabilityNotice(current.availability)
      return
    }
    await getEhComments(current.preferredUrl)
    return
  }
  await getEhComments(book.url)
}

const editingTag = ref(false)
const tagGroup = ref({})
const editTags = () => {
  editingTag.value = !editingTag.value
  if (editingTag.value) {
    if (!_.has(bookDetail.value, 'tags')) bookDetail.value.tags = {}
    const tempTagGroup = {}
    _.forEach(bookList.value.map(b => b.tags), (tagObject) => {
      _.forIn(tagObject, (tagArray, tagCat) => {
        if (_.isArray(tagArray)) {
          if (_.has(tempTagGroup, tagCat)) {
            tagArray.forEach(tag => tempTagGroup[tagCat].add(tag))
          } else {
            tempTagGroup[tagCat] = new Set(tagArray)
          }
        }
      })
    })
    const showTranslation = setting.value.showTranslation
    _.forIn(tempTagGroup, (tagSet, tagCat) => {
      tempTagGroup[tagCat] = [...tagSet].sort().map(tag => ({
        value: tag,
        label: `${showTranslation ? (resolvedTranslation.value[tagCat]?.[tag]?.name || tag ) + ' || ' : ''}${tag}`
      }))
    })
    tagGroup.value = tempTagGroup
  } else {
    saveBookTags(bookDetail.value)
  }
}
const saveBookTags = (book) => {
  const compactTags = {}
  _.forIn(book.tags, (tagarr, tagCat) => {
    if (!_.isEmpty(tagarr)) {
      compactTags[tagCat] = tagarr
    }
  })
  const tagSortKey = ['language', 'parody', 'character', 'group', 'artist', 'male', 'female', 'mixed', 'other', 'cosplayer']
  const sortedTags = {}
  tagSortKey.forEach(tagCat => {
    if (compactTags[tagCat]) {
      sortedTags[tagCat] = compactTags[tagCat]
    }
  })
  book.tags = Object.assign(sortedTags, compactTags)
  saveBook(book)
}
const addTagCat = () => {
  ElMessageBox.prompt(t('c.inputCategoryName'), t('m.addCategory'), {
    inputPattern: /^[\p{L}\d_]+$/u,
    inputErrorMessage: t('c.categoryNameError')
  })
  .then(({ value }) => {
    tagGroup.value[value] = []
  })
  .catch(() => {
    printMessage('info', t('c.canceled'))
  })
}


const onMangaTitleContextMenu = (e, book) => {
  e.preventDefault()
  ContextMenu.showContextMenu({
    x: e.x,
    y: e.y,
    items: [
      {
        label: t('c.copyTitleToClipboard'),
        onClick: () => {
          ipcRenderer.invoke('copy-text-to-clipboard', book.title_jpn || book.title)
        }
      },
      {
        label: t('c.copyLinkToClipboard'),
        onClick: () => {
          ipcRenderer.invoke('copy-text-to-clipboard', book.url)
        }
      },
      {
        label: t('c.copyTitleAndLinkToClipboard'),
        onClick: () => {
          ipcRenderer.invoke('copy-text-to-clipboard', `${book.title_jpn || book.title}\n${book.url}\n`)
        }
      },
    ]
  })
}

const onMangaCommentContextMenu = (e, comment) => {
  e.preventDefault()
  const foundLink = comment.foundLink
  if (!_.isEmpty(foundLink)) {
    const items = foundLink.map(l => ({
      label: `${t('c.redirect')} ${l.href}`,
      onClick: () => {
        ipcRenderer.invoke('open-url', l.href)
      }
    }))
    ContextMenu.showContextMenu({
      x: e.x,
      y: e.y,
      items
    })
  }
}

defineExpose({
  dialogVisibleBookDetail,
  editingTag,
  openBookDetail,
  openLocalBook,
  rescanBook,
  getComments,
  showFile,
  deleteLocalBook,
  triggerHiddenBook,
})

</script>

<style lang="stylus">
.el-dialog.is-fullscreen.dialog-detail
  .el-dialog__header
    .el-dialog__headerbtn
      margin: 8px 16px 0 0
      .el-icon
        width: 32px
        svg
          height: 32px
          width: 32px

.text-red
  color: red !important

.detail-book-title
  height: 44px
  overflow-y: hidden
  margin: 0 24px
.url-link
  cursor: pointer
.book-detail-card
  .book-detail-function, .book-detail-rate
    justify-content: center
    margin-bottom: 10px
  .book-detail-cover-frame
    position: relative
    width: 250px
    margin: 0 auto
    margin-bottom: 10px
    .book-detail-cover
      width: 250px
      height: 354px
      object-fit: cover
      border-radius: 4px
    .next-manga-pane, .prev-manga-pane
      position: absolute
      bottom: 80px
      cursor: pointer
      opacity: 0
      transition-delay: 0.5s
      background-color: rgba(0, 0, 0, 0.3)
      .el-icon
        font-size: 34px
        margin: 80px 0
        color: #FFFFFF
    .next-manga-pane
      right: 0
      border-radius: 4px 0 0 4px
    .prev-manga-pane
      left: 0
      border-radius: 0 4px 4px 0
    .next-manga-pane:hover, .prev-manga-pane:hover
      opacity: 1
      transition-delay: 0s
    .book-detail-star
      position: absolute
      cursor: pointer
      right: -6px
      top: -14px
  .edit-line
    margin: 4px 0
    .el-select, .el-select-v2
      width: 100%
  .el-descriptions__label
    display: inline-block
    text-align: right
    width: 80px
.book-tag-edit-popover
  .el-descriptions__cell
    padding-bottom: 0 !important
  .el-descriptions__label
    display: inline-block
    text-align: right
    width: 65px
.book-tag-frame
  height: calc(100vh - 100px)
  overflow-y: auto
  padding-right: 10px
  text-align: left
.source-availability
  position: relative
  width: 100%
  .source-availability-toolbar
    position: absolute
    right: 0
    top: -8px
  .source-availability-group
    padding-right: 32px
    margin-bottom: 8px
  .source-url
    overflow-wrap: anywhere
    color: var(--el-color-primary)
    margin-bottom: 4px
  .source-site-list
    display: flex
    flex-wrap: wrap
    gap: 8px 12px
    span
      display: inline-flex
      align-items: center
      gap: 4px
.book-tag
  margin: 4px 6px
  cursor: pointer
.tag-edit-buttons
  margin-top: 4px
.book-comment-frame
  text-align: left
  height: calc(100vh - 100px)
  overflow-y: auto
  padding-right: 10px
  .book-comment
    .book-comment-postby
      font-size: 12px
      background-color: var(--el-fill-color-dark)
      padding-left: 4px
      color: var(--el-text-color-regular)
    .book-comment-score
      float: right
      margin-right: 4px
    .book-comment-content
      font-size: 14px
      white-space: pre-wrap
      padding-left: 4px
      color: var(--el-text-color-regular)
</style>

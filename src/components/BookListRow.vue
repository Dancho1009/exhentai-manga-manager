<template>
  <div class="book-list-row" :class="{ 'book-list-row-with-actions': !book.isCollection, 'book-list-row-selectable': selectable && !book.isCollection, 'book-list-row-selected': selected }">
    <el-checkbox
      v-if="selectable && !book.isCollection"
      class="book-list-select"
      :model-value="selected"
      :aria-label="getDisplayTitle(book)"
      @click.stop="emit('toggleBookSelection', $event, book)"
    />
    <button
      class="book-list-cover-button"
      type="button"
      tabindex="-1"
      :aria-label="getDisplayTitle(book)"
      @click="handleCoverClick"
      @contextmenu="handleContextMenu"
      @mouseenter="showPreview"
      @mouseleave="emit('closeCoverPreview', $event.currentTarget)"
      @focus="showPreview"
      @blur="emit('closeCoverPreview', $event.currentTarget)"
    >
      <img v-if="book.coverPath && !coverFailed" class="book-list-cover" :src="book.coverPath" :alt="getDisplayTitle(book)" @error="handleCoverError" />
      <span v-else class="book-list-cover-placeholder" :aria-label="$t('m.coverUnavailable')"><el-icon><Picture /></el-icon></span>
    </button>
    <div class="book-list-name-area">
      <el-tag v-if="book.isCollection" size="small" type="warning" class="book-list-collection-tag">{{ $t('m.collection') }}</el-tag>
      <button class="book-list-name" type="button" tabindex="-1" :title="getDisplayTitle(book)" @click="handleTitleClick" @contextmenu="handleContextMenu">{{ getDisplayTitle(book) }}</button>
      <div v-if="!book.isCollection" class="book-list-meta">
        <el-tag class="book-list-status" size="small" effect="plain" :type="book.status === 'non-tag' ? 'info' : book.status === 'tagged' ? 'success' : 'warning'">{{ book.status }}</el-tag>
        <el-tag class="book-list-pages" size="small" :type="book.pageDiff ? 'danger' : 'info'" :title="book.pageDiff ? `${book.pageCount}|${book.filecount}P` : `${book.pageCount}P`">
          <template v-if="book.pageDiff">{{ book.pageCount }}|{{ book.filecount }}P</template>
          <template v-else>{{ book.pageCount }}P</template>
        </el-tag>
      </div>
    </div>
    <el-button-group v-if="!book.isCollection" class="book-list-read-actions" @keydown.enter.stop @keydown.space.stop>
      <el-tooltip :content="$t('m.externalViewer')" :trigger-keys="[]" placement="top">
        <el-button class="book-list-read-external" type="success" size="small" plain :icon="Monitor" :aria-label="$t('m.externalViewer')" @click.stop="handleRead('openLocalBook')"><span class="book-list-read-label">{{ $t('m.externalViewer') }}</span></el-button>
      </el-tooltip>
      <el-tooltip :content="$t('m.internalViewer')" :trigger-keys="[]" placement="top">
        <el-button class="book-list-read-internal" type="success" size="small" plain :icon="Reading" :aria-label="$t('m.internalViewer')" @click.stop="handleRead('viewManga')"><span class="book-list-read-label">{{ $t('m.internalViewer') }}</span></el-button>
      </el-tooltip>
    </el-button-group>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import { Monitor, Picture, Reading } from '@element-plus/icons-vue'
import { useAppStore } from '../pinia.js'

const props = defineProps({ book: Object, selected: Boolean, selectable: Boolean })
const emit = defineEmits(['openBookDetail', 'handleClickCover', 'onBookContextMenu', 'toggleBookSelection', 'openCollection', 'previewCover', 'closeCoverPreview', 'openLocalBook', 'viewManga'])
const { getDisplayTitle } = useAppStore()
const coverFailed = ref(false)
watch(() => props.book.coverPath, () => { coverFailed.value = false })

const showPreview = event => {
  if (props.book.coverPath && !coverFailed.value) emit('previewCover', props.book, event.currentTarget)
}
const handleCoverError = event => {
  coverFailed.value = true
  emit('closeCoverPreview', event.currentTarget.parentElement)
}
const handleCoverClick = event => {
  emit('closeCoverPreview')
  if (props.book.isCollection) emit('openCollection')
  else if (props.selectable && (event.ctrlKey || event.metaKey || event.shiftKey)) emit('toggleBookSelection', event, props.book)
  else emit('handleClickCover')
}
const handleTitleClick = event => {
  emit('closeCoverPreview')
  if (props.book.isCollection) emit('openCollection')
  else if (props.selectable && (event.ctrlKey || event.metaKey || event.shiftKey)) emit('toggleBookSelection', event, props.book)
  else emit('openBookDetail')
}
const handleContextMenu = event => {
  emit('closeCoverPreview')
  if (!props.book.isCollection) emit('onBookContextMenu', event, props.book)
}
const handleRead = eventName => {
  emit('closeCoverPreview')
  emit(eventName)
}
</script>

<style scoped lang="stylus">
.book-list-row
  display: grid
  grid-template-columns: 56px minmax(0, 1fr)
  align-items: center
  gap: 16px
  height: 96px
  width: 100%
  min-width: 0
  padding: 8px 16px
  box-sizing: border-box
  border-bottom: 1px solid var(--el-border-color-lighter)
  text-align: left
  color: var(--el-text-color-primary)
  &:hover
    background-color: var(--el-fill-color-light)
.book-list-row-with-actions
  grid-template-columns: 56px minmax(0, 1fr) auto
.book-list-row-selectable
  grid-template-columns: 22px 56px minmax(0, 1fr) auto
.book-list-row-selected
  background-color: var(--el-color-primary-light-9)
  box-shadow: inset 3px 0 0 var(--el-color-primary)
.book-list-select
  margin: 0
.book-list-cover-button
  width: 56px
  height: 80px
  padding: 0
  border: 0
  background: transparent
  cursor: pointer
  border-radius: 3px
  overflow: hidden
.book-list-cover
  display: block
  width: 100%
  height: 100%
  object-fit: contain
.book-list-cover-placeholder
  display: flex
  align-items: center
  justify-content: center
  width: 100%
  height: 100%
  background: var(--el-fill-color)
  color: var(--el-text-color-placeholder)
  font-size: 24px
.book-list-name-area
  min-width: 0
.book-list-name
  display: -webkit-box
  -webkit-box-orient: vertical
  -webkit-line-clamp: 2
  overflow: hidden
  overflow-wrap: anywhere
  width: 100%
  padding: 0
  border: 0
  background: transparent
  text-align: left
  font: inherit
  font-size: 15px
  line-height: 22px
  color: inherit
  cursor: pointer
  &:hover
    color: var(--el-color-primary)
.book-list-collection-tag
  margin-bottom: 4px
.book-list-meta
  display: flex
  align-items: center
  gap: 6px
  margin-top: 4px
  min-width: 0
  .book-list-status
    flex-shrink: 0
  .book-list-pages
    min-width: 0
    :deep(.el-tag__content)
      overflow: hidden
      text-overflow: ellipsis
      white-space: nowrap
.book-list-read-actions
  display: inline-flex
  flex-shrink: 0
  white-space: nowrap
@media (max-width: 900px)
  .book-list-read-actions .el-button
    width: 28px
    padding: 0
  .book-list-read-label
    display: none
  .book-list-read-actions :deep(.el-button > span)
    margin-left: 0
@media (max-width: 600px)
  .book-list-row
    gap: 10px
    padding: 8px
</style>

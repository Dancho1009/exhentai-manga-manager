<template>
  <el-popover
    :visible="visible"
    :virtual-ref="reference"
    virtual-triggering
    :trigger="[]"
    :enterable="false"
    :show-arrow="false"
    :persistent="false"
    placement="right"
    width="auto"
    :offset="12"
    :popper-options="popperOptions"
    popper-class="book-cover-preview"
    teleported
  >
    <img v-if="visible" class="book-cover-preview-image" :src="coverPath" :alt="title" @error="hide()" />
  </el-popover>
</template>

<script setup>
import { onBeforeUnmount, ref, shallowRef } from 'vue'

const visible = ref(false)
const reference = shallowRef(null)
const coverPath = ref('')
const title = ref('')
let timer
const popperOptions = {
  strategy: 'fixed',
  modifiers: [
    { name: 'flip', options: { fallbackPlacements: ['left', 'bottom', 'top'] } },
    { name: 'preventOverflow', options: { padding: 12 } }
  ]
}
const hide = target => {
  if (target && target !== reference.value) return
  clearTimeout(timer)
  visible.value = false
}
const show = (book, target) => {
  hide()
  reference.value = target
  if (!book.coverPath) return
  coverPath.value = book.coverPath
  title.value = book.title_jpn || book.title || ''
  timer = setTimeout(() => {
    if (target.isConnected) visible.value = true
  }, 200)
}
onBeforeUnmount(() => hide())
defineExpose({ show, hide })
</script>

<style lang="stylus">
.book-cover-preview.el-popover.el-popper
  min-width: 0
  padding: 8px
  pointer-events: none
  border-radius: 4px
  .book-cover-preview-image
    display: block
    width: 300px
    max-width: calc(100vw - 48px)
    height: 424px
    max-height: calc(100vh - 80px)
    object-fit: contain
</style>

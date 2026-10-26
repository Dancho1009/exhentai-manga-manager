<template>
  <article :class="['member-card', { 'will-quarantine': !retained, 'is-baseline': baseline }]" :data-book-id="book.id">
    <div class="member-selection">
      <span class="copy-number">{{ label('copyNumber', { number: number }) }}</span>
      <el-checkbox :model-value="retained" :disabled="selectionDisabled" @change="$emit('retain', $event)">{{ label('keepThis') }}</el-checkbox>
      <el-tag v-if="!retained" type="warning" size="small">{{ label('willQuarantine') }}</el-tag>
      <el-tag v-if="baseline" size="small" effect="plain">{{ label('baseline') }}</el-tag>
    </div>
    <div class="member-heading">
      <button class="cover-button" :aria-label="$t('audit.openBookDetailWindow')" @click="$emit('detail', book.id)">
        <el-image v-if="book.coverPath" :src="imageSource(book.coverPath)" fit="contain" lazy scroll-container=".dedupe-panel .comparison-scroll"><template #error><span>{{ label('noCover') }}</span></template></el-image>
        <span v-else>{{ label('noCover') }}</span>
      </button>
      <div class="member-title">
        <h3>{{ book.title }}</h3>
        <p class="member-facts">{{ label('localDeclared') }} {{ book.actualPageCount ?? label('unknown') }} / {{ book.declaredPageCount ?? label('unknown') }} · {{ book.type }} · {{ formatBytes(book.transferBytes ?? book.size) }}</p>
        <p class="file-name" :title="book.filepath">{{ filename }}</p>
        <el-tag size="small" :type="book.contentProof ? 'success' : 'info'">{{ book.contentProof ? label('contentChecked') : label('notChecked') }}</el-tag>
      </div>
    </div>
    <p class="folder-name" :title="book.filepath">{{ folder }}</p>
    <dl class="member-summary">
      <dt>{{ label('workOrdinal') }}</dt><dd data-field="work-ordinal" :class="{ difference: differs('chapter') || differs('volume') }">{{ workOrdinal }}</dd>
      <dt>{{ label('publication') }}</dt><dd data-field="publication" :class="{ difference: differs('publications') }">{{ book.semantic?.publications?.map(item => item.rawText).join(' / ') || label('notSpecified') }}</dd>
      <dt>{{ label('version') }}</dt><dd data-field="version" :class="{ difference: differs('versions') }">{{ book.semantic?.versions?.map(version => label('version_' + version)).join(' · ') || label('notSpecified') }}</dd>
      <dt>{{ $t('m.postTime') }}</dt><dd data-field="posted" :class="{ difference: other && formatPosted(book) !== formatPosted(other) }">{{ formatPosted(book) }}</dd>
      <dt>{{ $t('m.mtime') }}</dt><dd data-field="mtime" :class="{ difference: other && formatMtime(book) !== formatMtime(other) }">{{ formatMtime(book) }}</dd>
      <dt>{{ label('reading') }}</dt><dd>{{ book.readCount }} · {{ book.mark ? label('marked') : label('unmarked') }} · {{ book.hiddenBook ? label('hidden') : label('visible') }}</dd>
      <dt>{{ label('identity') }}</dt><dd :class="{ difference: book.sourceEvidence?.status !== 'known' || (other && book.sourceEvidence?.key !== other.sourceEvidence?.key) }">{{ label('identity_' + (book.sourceEvidence?.status || 'missing')) }}</dd>
    </dl>
    <div class="comparison-actions">
      <el-button size="small" :disabled="baseline" @click="$emit('baseline')">{{ label('setBaseline') }}</el-button>
      <el-button size="small" :disabled="baseline" @click="$emit('compare')">{{ label('compareBaseline') }}</el-button>
      <el-button v-if="canRetainOnly" size="small" :disabled="selectionDisabled" @click="$emit('retain-only')">{{ label('keepOnlyCopy') }}</el-button>
    </div>
    <div class="member-details">
      <p class="member-subtitle" v-if="book.title_jpn && book.title_jpn !== book.title">{{ book.title_jpn }}</p>
      <dl>
        <dt>{{ label('author') }}</dt><dd :class="{ difference: differs('artists') }">{{ book.semantic?.artists?.join('、') || label('unknown') }}</dd>
        <dt>{{ label('language') }}</dt><dd :class="{ difference: differs('languages') }">{{ book.semantic?.languages?.join('、') || label('unknown') }}</dd>
        <dt>{{ label('formatSize') }}</dt><dd>{{ book.type }} · {{ formatBytes(book.transferBytes ?? book.size) }} · {{ book.imageFormats?.join(', ') }}</dd>
        <dt>{{ label('localDeclared') }}</dt><dd :class="{ difference: other && book.actualPageCount !== other.actualPageCount }">{{ book.actualPageCount ?? label('unknown') }} / {{ book.declaredPageCount ?? label('unknown') }}</dd>
      </dl>
      <div class="sources">
        <div v-for="source in book.sourceEvidence?.sources || []" :key="source.source">
          <strong>{{ label('source_' + source.source) }}</strong>
          <button v-if="source.source !== 'ehviewer' && source.value" class="source-link" @click="$emit('url', source.value)">{{ source.value }}</button>
          <span v-else>{{ source.identity ? source.identity.provider + ' · ' + source.identity.id + ' / ' + (source.identity.token || '') : label('unknown') }}</span>
        </div>
      </div>
      <p class="path">{{ book.filepath }}</p>
      <p v-if="book.contentVerification?.method === 'archive-equivalence'" class="path">{{ label('representativeProof', { id: book.contentVerification.representativeBookId }) }}</p>
      <section v-if="book.uncoveredEntries?.length || book.ignoredEntries?.length" class="file-scope"><strong>{{ label('fileScope') }}</strong><pre>{{ [...(book.uncoveredEntries || []), ...(book.ignoredEntries || []).map(path => label('ignored') + ': ' + path)].join('\n') }}</pre></section>
    </div>
    <el-alert v-if="book.nestedBookIds?.length" type="info" :closable="false" :title="label('registeredChildren', { count: book.nestedBookIds.length })" />
    <el-alert v-if="book.uncoveredEntries?.length" type="warning" :closable="false" :title="label('uncovered', { count: book.uncoveredEntries.length })" />
    <div class="member-actions"><el-button size="small" @click="$emit('detail', book.id)">{{ $t('audit.openBookDetailWindow') }}</el-button><el-button size="small" @click="$emit('locate', book.filepath)">{{ label('locate') }}</el-button></div>
  </article>
</template>
<script setup>
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
const props = defineProps({
  book: { type: Object, required: true }, other: { type: Object, default: null }, number: Number,
  retained: Boolean, baseline: Boolean, selectionDisabled: Boolean, canRetainOnly: Boolean
})
defineEmits(['detail', 'locate', 'url', 'retain', 'baseline', 'compare', 'retain-only'])
const { t, locale } = useI18n()
const label = (key, values) => t('audit.dedupeReview.' + key, values || {})
const differs = field => props.other && JSON.stringify(props.book.semantic?.[field]) !== JSON.stringify(props.other.semantic?.[field])
const dateFormatter = computed(() => new Intl.DateTimeFormat(locale.value, {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
}))
const formatDateTime = value => {
  if (value === null || value === undefined || value === '' || value === 0 || value === '0') return label('unknown')
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? dateFormatter.value.format(date) : label('unknown')
}
const formatPosted = book => {
  const seconds = Number(book?.posted)
  return Number.isFinite(seconds) && seconds > 0 ? formatDateTime(seconds * 1000) : label('unknown')
}
const formatMtime = book => formatDateTime(book?.mtimeMs ?? book?.mtime)
const pathParts = computed(() => String(props.book.filepath || '').split(/[\\/]/))
const filename = computed(() => pathParts.value.at(-1))
const folder = computed(() => pathParts.value.slice(0, -1).join(' / '))
const workOrdinal = computed(() => {
  const semantic = props.book.semantic
  if (semantic?.ordinalConflict) return label('ordinalConflict')
  if (!semantic?.version && (semantic?.issue || semantic?.range)) return label('legacyOrdinal', { number: semantic.range?.join('–') || semantic.issue })
  return ['chapter', 'volume'].filter(kind => semantic?.[kind]).map(kind => {
    const ordinal = semantic[kind]
    return label(kind + 'Number', { number: ordinal.end === null ? ordinal.start : ordinal.start + '–' + ordinal.end })
  }).join(' · ') || label('notSpecified')
})
const imageSource = value => /^(data:|https?:|file:)/.test(value) ? value : 'file:///' + String(value).replace(/\\/g, '/')
const formatBytes = value => { const size = Number(value || 0); return size >= 1048576 ? (size / 1048576).toFixed(1) + ' MB' : (size / 1024).toFixed(1) + ' KB' }
</script>
<style scoped>
.member-card { padding: 12px; border: 1px solid var(--el-border-color); border-radius: 8px; min-width: 0; background: var(--el-bg-color); container-type: inline-size; }
.member-card.will-quarantine { border-color: var(--el-color-warning); }
.member-selection { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; font-size: 12px; }
.copy-number { color: var(--el-text-color-secondary); }
.member-selection .el-checkbox { margin: 0; height: 24px; }
.member-heading { display: grid; grid-template-columns: 104px minmax(0,1fr); gap: 12px; align-items: start; }
.cover-button { display: flex; align-items: center; justify-content: center; width: 100%; aspect-ratio: 500 / 707; border: 0; padding: 0; cursor: pointer; background: var(--el-fill-color); color: var(--el-text-color-secondary); border-radius: 4px; overflow: hidden; }
.cover-button .el-image { width: 100%; height: 100%; }
.cover-button:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
.member-title { min-width: 0; }
.member-title h3 { font-size: 13px; margin: 0; overflow-wrap: anywhere; line-height: 1.45; }
.member-title .el-tag { margin-top: 3px; }
.member-facts,.member-subtitle,.file-name,.folder-name { margin: 5px 0; font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }
.member-facts,.member-subtitle,.folder-name { color: var(--el-text-color-secondary); }
.folder-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
dl { display: grid; grid-template-columns: 92px minmax(0,1fr); gap: 7px 8px; font-size: 12px; margin: 12px 0; }
dt { color: var(--el-text-color-secondary); } dd { margin: 0; overflow-wrap: anywhere; }
.difference { color: var(--el-color-warning); font-weight: 600; }
.sources { display: grid; gap: 6px; font-size: 12px; }.sources strong { display: block; color: var(--el-text-color-secondary); font-weight: 400; }
.sources span,.source-link { overflow-wrap: anywhere; }
.source-link { border: 0; padding: 0; text-align: left; cursor: pointer; color: var(--el-color-primary); background: none; font: inherit; }
.path,pre { overflow-wrap: anywhere; white-space: pre-wrap; font-size: 11px; color: var(--el-text-color-secondary); }
.member-actions,.comparison-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; } .member-actions .el-button,.comparison-actions .el-button { margin: 0; }
.member-details,.file-scope { margin-top: 10px; font-size: 12px; }
@container (min-width: 480px) { .member-heading { grid-template-columns: 128px minmax(0,1fr); } }
@container (max-width: 285px) { .member-heading { grid-template-columns: 88px minmax(0,1fr); gap: 8px; } }
</style>

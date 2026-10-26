<template>
  <section class="ai-batch-list">
    <div class="batch-filters">
      <el-select v-model="filter" size="small" style="width:140px" :aria-label="t('aiTrace.filter')">
        <el-option v-for="value in ['all','active','failed','completed']" :key="value" :label="t(`aiTrace.${value}`)" :value="value" />
      </el-select>
      <el-input v-model="search" clearable size="small" :placeholder="t('aiTrace.search')" style="max-width:260px" />
      <small>{{ filtered.length }} {{ t('aiTrace.batches') }} · {{ activeCount }} {{ t('aiTrace.active') }}</small>
    </div>
    <el-table :data="pageRows" row-key="batchId" size="small" highlight-current-row :height="height" @row-click="row => emit('select', row)">
      <el-table-column type="expand" width="32"><template #default="{row}"><ul class="batch-members"><li v-for="member in row.members" :key="member.id">{{ member.title }} <small>{{ member.id }}</small></li></ul></template></el-table-column>
      <el-table-column :label="t('aiTrace.batch')" min-width="112"><template #default="{row}"><b>#{{ row.batchIndex }}/{{ row.batchTotal }}</b><br/><small>{{ t(`aiTrace.phase_${row.phase}`) }}<template v-if="row.recoveryOf"> · {{ t('aiTrace.recoveryBatch') }}</template></small><br v-if="row.recoverySizes?.length"/><small v-if="row.recoverySizes?.length">{{ t('aiTrace.splitInto') }} {{ row.recoverySizes.join(' + ') }}</small></template></el-table-column>
      <el-table-column :label="t('aiTrace.counts')" min-width="120"><template #default="{row}">{{ row.phase === 'normalizing' ? row.bookCount : row.pairCount }} / {{ row.returnedCount ?? '—' }} / {{ row.savedCount || 0 }}<br/><small v-if="row.recoverySavedCount !== undefined">{{ t('aiTrace.retrySaved') }} {{ row.recoverySavedCount }} · {{ t('aiTrace.unresolved') }} {{ row.unresolvedCount }}</small><small v-else>{{ row.phase === 'normalizing' ? t('aiTrace.books') : t('aiTrace.pairs') }} · {{ t('aiTrace.missing') }} {{ row.missingCount || 0 }}</small></template></el-table-column>
      <el-table-column :label="t('aiTrace.status')" min-width="110"><template #default="{row}"><el-tag disable-transitions size="small" :type="row.status === 'failed' ? 'danger' : ['completed','recovered'].includes(row.status) ? 'success' : 'info'">{{ t(`aiTrace.status_${row.status}`) }}</el-tag><br/><small>{{ duration(row) }}</small><br/><small class="batch-tps" :title="t('aiTrace.tpsHelp')">{{ t('aiTrace.tps') }} {{ row.status === 'cached' ? '—' : tpsText(row.attempts?.at(-1), t) }}</small></template></el-table-column>
      <el-table-column v-if="!compact" :label="t('aiTrace.received')" min-width="130"><template #default="{row}">{{ bytesText(row.attempts?.at(-1)?.streamBytes) }}<br/><small>{{ t('aiTrace.content') }} {{ bytesText(row.attempts?.at(-1)?.contentBytes) }}</small></template></el-table-column>
      <el-table-column v-if="!compact" :label="t('aiTrace.details')" width="100"><template #default="{row}"><el-button link type="primary" @click.stop="emit('select', row)">{{ t('aiTrace.view') }}</el-button></template></el-table-column>
    </el-table>
    <el-pagination v-model:current-page="page" small layout="prev, pager, next, total" :page-size="40" :total="filtered.length" />
  </section>
</template>
<script setup>
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { activeStatuses, bytesText, tpsText } from './aiTrace.mjs'
const props = defineProps({ batches: { type:Array, default:() => [] }, compact:Boolean, height:{type:[Number,String],default:310} })
const emit = defineEmits(['select'])
const { t } = useI18n()
const filter = ref('all'), search = ref(''), page = ref(1), now = ref(Date.now())
let timer
onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, 1000) })
onBeforeUnmount(() => clearInterval(timer))
const activeCount = computed(() => props.batches.filter(batch => activeStatuses.has(batch.status)).length)
const filtered = computed(() => props.batches.filter(batch => (filter.value === 'all' || (filter.value === 'active' ? activeStatuses.has(batch.status) : filter.value === 'completed' ? ['completed','recovered','cached'].includes(batch.status) : ['failed','partial','cancelled','interrupted'].includes(batch.status))) && (!search.value || `${batch.batchId} ${batch.members?.map(book => book.title).join(' ')}`.toLowerCase().includes(search.value.toLowerCase()))))
const pageRows = computed(() => filtered.value.slice((page.value - 1) * 40, page.value * 40))
watch([filter,search], () => { page.value = 1 })
const duration = row => row.startedAt ? `${Math.max(0, Math.floor(((Date.parse(row.completedAt) || now.value) - Date.parse(row.startedAt)) / 1000))}s` : '—'
</script>
<style scoped>
.batch-filters { display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:10px 0 }
.batch-members { margin:8px 16px;padding-left:16px;overflow-wrap:anywhere }
.batch-members small { opacity:.6 }
.el-pagination { margin-top:8px;justify-content:flex-end }
small { color:var(--el-text-color-secondary) }
</style>

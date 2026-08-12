<template>
  <el-collapse v-model="activePanels" class="log-pane" @click.stop>
    <el-collapse-item name="logs">
      <template #title>
        <span class="log-title"><el-icon><Tickets /></el-icon><span>{{ $t('audit.taskLog') }}</span><el-tag size="small" type="info" effect="plain">{{ logs.length }}</el-tag></span>
      </template>
      <div class="log-toolbar" @click.stop>
        <el-segmented v-model="filter" size="small" :options="filterOptions" />
      </div>
      <div class="log-content" @click.stop>
        <div v-for="(entry, index) in filteredLogs" :key="`${entry.at}-${index}`" class="log-line" :class="`level-${entry.level || 'info'}`">
          <span>{{ new Date(entry.at).toLocaleString() }}</span><strong>{{ taskLabel(entry.taskType) }}</strong><code>{{ entry.message }}</code>
        </div>
        <el-empty v-if="filteredLogs.length === 0" :description="$t('audit.noLogs')" :image-size="48" />
      </div>
    </el-collapse-item>
  </el-collapse>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Tickets } from '@element-plus/icons-vue'

const props = defineProps({ logs: { type: Array, default: () => [] } })
const { t } = useI18n()
const activePanels = ref([])
const filter = ref('all')
const filterOptions = computed(() => [
  { label: t('audit.allTasks'), value: 'all' },
  { label: t('audit.anomalyTab'), value: 'anomaly' },
  { label: t('audit.dedupTab'), value: 'dedupe' },
  { label: t('audit.executionTask'), value: 'execution' }
])
const filteredLogs = computed(() => filter.value === 'all' ? props.logs : props.logs.filter(entry => entry.taskType === filter.value))
const taskLabel = taskType => ({ anomaly: t('audit.anomalyTab'), dedupe: t('audit.dedupTab'), execution: t('audit.executionTask') })[taskType] || taskType
</script>

<style scoped>
.log-pane { flex: 0 0 auto; margin: 0 18px 12px; overflow: hidden; border: 1px solid var(--el-border-color); border-radius: 4px; background: var(--el-bg-color-overlay); position: relative; z-index: 4; }.log-pane :deep(.el-collapse-item__header) { min-height: 48px; padding: 0 16px; color: var(--el-text-color-primary); background: var(--el-fill-color-light); cursor: pointer; }.log-title { display: inline-flex; align-items: center; gap: 9px; font-weight: 600; }.log-toolbar { padding: 8px 14px; border-bottom: 1px solid var(--el-border-color); }.log-content { max-height: 220px; padding: 8px 14px; overflow: auto; background: var(--el-bg-color); }.log-line { display: grid; grid-template-columns: 170px 76px minmax(0, 1fr); gap: 10px; min-height: 28px; align-items: baseline; padding: 4px 8px; border-left: 3px solid var(--el-border-color); }.log-line span { color: var(--el-text-color-secondary); font-size: 12px; }.log-line strong { font-size: 12px; }.log-line code { overflow-wrap: anywhere; white-space: pre-wrap; }.level-info { border-color: var(--el-color-primary); }.level-warning { border-color: var(--el-color-warning); background: var(--el-color-warning-light-9); }.level-error { border-color: var(--el-color-danger); background: var(--el-color-danger-light-9); }
</style>

<template>
  <section class="task-stage-overview" :aria-label="$t('audit.taskStages')">
    <div class="stage-rail">
      <template v-for="(stage, index) in summary.stages" :key="stage.id">
        <div class="stage-item" :class="`is-${stage.state}`" :aria-current="stage.state === 'current' ? 'step' : undefined">
          <span class="stage-marker">
            <el-icon v-if="stage.state === 'completed'"><Check /></el-icon>
            <el-icon v-else-if="stage.state === 'failed'"><Close /></el-icon>
            <el-icon v-else-if="stage.state === 'paused'"><VideoPause /></el-icon>
            <span v-else>{{ index + 1 }}</span>
          </span>
          <span class="stage-label">{{ $t(stage.labelKey) }}</span>
        </div>
        <span v-if="index < summary.stages.length - 1" class="stage-connector" :class="{ complete: index < summary.completedCount }" />
      </template>
    </div>

    <div class="stage-facts">
      <span><small>{{ $t('audit.completedStages') }}</small><strong>{{ summary.completedCount }}/{{ summary.totalCount }}</strong></span>
      <span><small>{{ $t('audit.currentStage') }}</small><strong>{{ stageLabel(summary.currentStage) }}</strong></span>
      <span><small>{{ $t('audit.nextStage') }}</small><strong>{{ stageLabel(summary.nextStage) }}</strong></span>
      <span><small>{{ $t('audit.remainingStages') }}</small><strong>{{ $t('audit.remainingStageCount', { count: summary.remainingCount }) }}</strong></span>
    </div>
  </section>
</template>

<script setup>
import { Check, Close, VideoPause } from '@element-plus/icons-vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({
  summary: {
    type: Object,
    default: () => ({ stages: [], completedCount: 0, totalCount: 0, currentStage: null, nextStage: null, remainingCount: 0 })
  }
})
const { t } = useI18n()
const stageLabel = value => value?.labelKey ? t(value.labelKey) : t('audit.noNextStage')
</script>

<style scoped>
.task-stage-overview { margin-top: 10px; }
.stage-rail { display: flex; align-items: center; width: 100%; }
.stage-item { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 7px; min-width: 0; color: var(--el-text-color-secondary); }
.stage-marker { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; flex: 0 0 24px; box-sizing: border-box; border: 1px solid var(--el-border-color); border-radius: 50%; background: var(--el-bg-color); font-size: 12px; font-variant-numeric: tabular-nums; }
.stage-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.stage-connector { flex: 1 1 30px; min-width: 14px; height: 1px; margin: 0 10px; background: var(--el-border-color); }
.stage-connector.complete { background: var(--el-color-success); }
.is-completed { color: var(--el-color-success); }
.is-completed .stage-marker { border-color: var(--el-color-success); color: #fff; background: var(--el-color-success); }
.is-current { color: var(--el-color-primary); font-weight: 600; }
.is-current .stage-marker { border-color: var(--el-color-primary); color: #fff; background: var(--el-color-primary); }
.is-paused { color: var(--el-color-warning); font-weight: 600; }
.is-paused .stage-marker { border-color: var(--el-color-warning); color: #fff; background: var(--el-color-warning); }
.is-failed { color: var(--el-color-danger); font-weight: 600; }
.is-failed .stage-marker { border-color: var(--el-color-danger); color: #fff; background: var(--el-color-danger); }
.stage-facts { display: grid; grid-template-columns: repeat(4, minmax(0, auto)); justify-content: end; gap: 12px 30px; margin-top: 9px; }
.stage-facts > span { display: inline-flex; align-items: baseline; gap: 7px; min-width: 0; }
.stage-facts small { color: var(--el-text-color-secondary); font-size: 12px; }
.stage-facts strong { overflow: hidden; color: var(--el-text-color-regular); text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; }
@media (max-width: 900px) {
  .stage-rail { display: none; }
  .stage-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); justify-content: stretch; gap: 7px 18px; }
  .stage-facts > span { display: grid; grid-template-columns: auto minmax(0, 1fr); }
}
</style>


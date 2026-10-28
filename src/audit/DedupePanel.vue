<template>
  <section class="task-panel dedupe-panel" :data-report-id="report?.reportId">
    <div class="task-toolbar">
      <div class="scan-controls">
        <el-select v-model="scanMode" :disabled="busy" class="scan-mode" :aria-label="label('scanMode')">
          <el-option :label="label('daily')" value="daily" /><el-option :label="label('full')" value="full" /><el-option v-if="aiAvailable" :label="label('ai')" value="ai" />
        </el-select>
        <el-checkbox v-model="forceRecompute" :disabled="busy">{{ label('recompute') }}</el-checkbox>
        <el-button type="primary" :disabled="busy" @click="$emit('start', { scanMode, forceRecompute })">{{ scanMode === 'ai' ? label('startAi') : $t('audit.startDedupe') }}</el-button>
        <el-button @click="openHistory">{{ label('history') }}</el-button>
      </div>
      <span class="last-run">{{ lastRunText }}</span>
    </div>
    <el-alert v-if="running && report" type="info" :closable="false" :title="$t('audit.previousDedupeReportWhileRunning')" />
    <el-alert v-if="report?.legacy || report?.stale" type="warning" :closable="false" :title="$t(report.legacy ? 'audit.legacyReportReadOnly' : 'audit.staleReportReadOnly')" />
    <el-alert v-if="report?.outdatedRules" type="warning" :closable="false" :title="label('outdatedRules')" />
    <template v-if="report">
      <div class="summary-band">
        <span>{{ label('scope', { registered: report.summary.mangaRows, checked: report.summary.checkedItems ?? report.summary.mangaRows }) }}</span>
        <span>{{ label('groups', { count: report.groups.length }) }} · {{ label('suggested', { count: report.summary.eligibleDuplicateGroups }) }}</span>
        <button v-if="coverageGroupCount" class="text-button" @click="relationFilter = 'coverage'">{{ label('coverageQueueSection', { count: coverageGroupCount }) }}</button>
        <span v-if="report.summary.unregisteredItems">{{ label('unregistered', { count: report.summary.unregisteredItems }) }}</span>
        <button v-if="report.excludedItems?.length" class="text-button" @click="errorsVisible = !errorsVisible">{{ label('readErrors', { count: report.excludedItems.length }) }}</button>
      </div>
      <pre v-if="errorsVisible" class="errors">{{ report.excludedItems.map(item => item.filepath + '\n' + item.reason).join('\n\n') }}</pre>
      <div class="filters">
        <el-input v-model="search" clearable :placeholder="label('search')" />
        <el-select v-model="kindFilter" clearable :placeholder="$t('audit.type')"><el-option v-for="kind in kinds" :key="kind" :label="kindLabel(kind)" :value="kind" /></el-select>
        <el-select v-model="relationFilter" :aria-label="label('relationFilter')"><el-option :label="label('relation_all')" value="all" /><el-option :label="label('relation_coverage')" value="coverage" /><el-option :label="label('relation_contains')" value="contains" /><el-option :label="label('relation_overlap')" value="overlap" /></el-select>
        <el-select v-model="statusFilter" :aria-label="label('reviewState')"><el-option v-for="state in statusOptions" :key="state" :label="label('state_' + state)" :value="state" /></el-select>
        <el-checkbox v-model="needsEvidence">{{ label('needsEvidence') }}</el-checkbox>
        <el-button :disabled="locked || saving || !suggestible.length" @click="adoptVisible">{{ label('adoptVisible', { count: suggestible.length }) }}</el-button>
      </div>
      <div class="review-workspace">
        <aside class="queue">
          <div class="queue-heading">{{ label('queue') }} · {{ filteredGroups.length }}</div>
          <div ref="queueList" class="queue-list">
            <button v-for="group in pagedGroups" :key="group.id" :class="['queue-item', { selected: group.id === selectedId }]" @click="selectGroup(group.id)">
              <span class="queue-item-title">{{ group.items[0]?.title }}</span>
              <span>{{ label(group.reviewShape === 'direct-pair' ? 'directPair' : 'wholeBookGroup') }} · {{ group.items.length }} {{ label('members') }}</span>
              <span class="queue-state">{{ resolvedByOtherDecision(group) ? label('resolvedElsewhere') : draftIsDirty(group.id) ? label('draftUnsaved') : label('state_' + (decisions[group.id]?.disposition || 'pending')) }} · {{ label('verification_' + (group.verification?.status || 'unverified')) }}</span>
            </button>
            <el-empty v-if="!filteredGroups.length" :description="label('emptyQueue')" :image-size="55" />
          </div>
          <el-pagination v-model:current-page="queuePage" :page-size="queueSize" :total="filteredGroups.length" small layout="prev, pager, next" :pager-count="5" />
        </aside>
        <section v-if="selectedGroup" class="comparison-area">
          <div ref="comparisonScroll" class="comparison-scroll">
          <header class="comparison-heading">
            <div><strong>{{ kindLabel(selectedGroup.kind) }}</strong> · {{ label(selectedGroup.reviewShape === 'direct-pair' ? 'directPair' : 'wholeBookGroup') }}<span class="check-time">{{ selectedGroup.verification?.checkedAt ? new Date(selectedGroup.verification.checkedAt).toLocaleString() : '' }} · {{ label(selectedGroup.verification?.fromCache ? 'cached' : 'checkedThisRun') }}</span></div>
            <div class="group-navigation"><el-button size="small" :disabled="selectedIndex <= 0" @click="navigate(-1)">{{ label('previous') }}</el-button><span>{{ selectedIndex + 1 }}/{{ filteredGroups.length }}</span><el-button size="small" :disabled="selectedIndex < 0 || selectedIndex >= filteredGroups.length - 1" @click="navigate(1)">{{ label('next') }}</el-button></div>
          </header>
          <details class="group-reasons"><summary>{{ label('matchingReasons', { count: selectedGroup.reasons?.length || 0 }) }}</summary><div class="reason-chips"><el-tag v-for="reason in selectedGroup.reasons || []" :key="reason.code + reason.memberIds.join(',')" size="small" effect="plain">{{ label('reason_' + reason.code) }}</el-tag></div></details>
          <ai-analysis-panel task="dedupe" compact :report-id="report.reportId" :group-id="selectedGroup.id" :evidence-revision="selectedGroup.evidenceRevision" :busy="busy" :disabled="Boolean(report.stale || report.legacy || report.outdatedRules)" />
          <div v-if="view !== 'overview'" class="member-strip"><el-select v-model="leftId" :aria-label="label('baseline')"><el-option v-for="book in selectedGroup.items" :key="book.id" :value="book.id" :label="book.title" /></el-select><span>↔</span><el-select v-model="rightId" :aria-label="label('compared')"><el-option v-for="book in selectedGroup.items" :key="book.id" :value="book.id" :label="book.title" :disabled="book.id === leftId" /></el-select></div>
            <el-tabs v-model="view">
              <el-tab-pane :label="label('overview')" name="overview">
                <div class="member-summary-bar"><span>{{ label('keepSummary', { total: selectedGroup.items.length, kept: keepDraft.keepIds.length, removed: selectedGroup.items.length - keepDraft.keepIds.length }) }}</span><span v-if="draftIsDirty(selectedGroup.id)" class="draft-state">{{ label('draftUnsaved') }}</span><el-button size="small" :disabled="caseLocked" @click="keepAll">{{ label('keepAll') }}</el-button><el-button size="small" :disabled="caseLocked || !draftIsDirty(selectedGroup.id)" @click="resetDraft">{{ label('restoreSelection') }}</el-button></div>
                <p v-if="selectedGroup.reviewShape === 'direct-pair'" class="muted">{{ resolvedByOtherDecision(selectedGroup) ? label('resolvedElsewhere') : label('wholeBookIsolationHint') }}</p>
                <div class="member-grid" :style="{ '--member-columns': Math.min(3, selectedGroup.items.length), '--member-columns-medium': Math.min(2, selectedGroup.items.length) }"><dedupe-member-card v-for="(book, index) in selectedGroup.items" :key="book.id" :book="datedBook(book)" :number="index + 1" :other="book.id === leftId ? null : datedBook(leftBook)"
                  :retained="keepDraft.keepIds.includes(book.id)" :baseline="book.id === leftId" :selection-disabled="caseLocked || (keepDraft.keepIds.length === 1 && keepDraft.keepIds.includes(book.id))"
                  :can-retain-only="Boolean(selectedGroup.equivalenceClasses?.some(entry => entry.eligible && entry.memberIds.includes(book.id)))"
                  @retain="setRetained(book.id, $event)" @retain-only="keepOnly(book.id)" @baseline="setBaseline(book.id)" @compare="compareBook(book.id)"
                  @detail="openDetail" @locate="locate" @url="openUrl" /></div>
                <div v-if="selectedGroup.relations?.length" class="relations-list"><strong>{{ label('directRelations') }}</strong>
                  <button v-for="relation in selectedGroup.relations" :key="relation.leftId + ':' + relation.rightId" class="relation-row" @click="compareRelation(relation)">
                    <span>{{ memberTitle(relation.leftId) }} ↔ {{ memberTitle(relation.rightId) }}</span>
                    <small>{{ label('coverage_' + relation.declaredRelation) }} · {{ label('contentRelation_' + relation.contentRelation) }}</small>
                    <small v-if="relation.verified">{{ label('coveragePages', { matched: relation.matchedPages, left: relation.leftPages, right: relation.rightPages }) }} · {{ label('relationUnique', { left: relation.leftUniquePages, right: relation.rightUniquePages }) }}</small>
                    <small v-if="relation.metadataConflict">{{ label('coverageMetadataConflict') }}</small>
                  </button>
                </div>
                <div class="equivalence-list" v-if="selectedGroup.equivalenceClasses?.length"><div v-for="equivalence in selectedGroup.equivalenceClasses" :key="equivalence.id">
                  <strong>{{ kindLabel(equivalence.kind) }}</strong> · {{ equivalence.memberIds.map(id => memberTitle(id)).join(' ↔ ') }}
                  <p>{{ label('keeper') }}: {{ memberTitle(equivalence.suggestedKeepId) }} · {{ equivalence.keepReasons.map(reason => label('keeper_' + reason)).join('、') }}</p>
                </div></div>
              </el-tab-pane>
              <el-tab-pane :label="label('pages')" name="pages">
                <el-alert v-if="!evidence?.comparison?.verified" :closable="false" type="info" :title="label('verifyFirst')" />
                <template v-else>
                  <div class="page-summary">{{ label('pageFacts', { matched: evidence.comparison.matchedCount, left: evidence.comparison.leftPageCount, right: evidence.comparison.rightPageCount }) }} · {{ label('coverage', { left: (evidence.comparison.coverage.left * 100).toFixed(1), right: (evidence.comparison.coverage.right * 100).toFixed(1) }) }}</div>
                  <div class="page-controls"><el-select v-model="alignment" :aria-label="label('alignment')"><el-option :label="label('ordinal')" value="ordinal" /><el-option :label="label('hashAlignment')" value="hash" /></el-select><el-checkbox v-model="differencesOnly">{{ label('onlyDifferences') }}</el-checkbox><el-button size="small" :disabled="evidence.comparison.firstDifference === null" @click="firstDifference">{{ label('firstDifference') }}</el-button></div>
                  <div class="page-controls"><el-button size="small" :disabled="pagePosition <= 1" @click="pagePosition--">{{ label('previousPage') }}</el-button><el-input-number v-model="pagePosition" :min="1" :max="Math.max(1, pairs.length)" size="small" /><span>/ {{ pairs.length }}</span><el-button size="small" :disabled="pagePosition >= pairs.length" @click="pagePosition++">{{ label('nextPage') }}</el-button><el-tag v-if="currentPair" size="small" :type="currentPair.same ? 'success' : 'warning'">{{ label(currentPair.same ? 'sameBytes' : 'differentBytes') }}</el-tag></div>
                  <div class="page-pair" v-loading="previewLoading">
                    <div v-for="side in ['left', 'right']" :key="side" class="page-card"><strong>{{ side === 'left' ? leftBook.title : rightBook.title }}</strong>
                      <template v-if="currentPair && currentPair[side] !== null">
                        <p>{{ currentPair[side] + 1 }} · {{ evidence[side]?.images[currentPair[side]]?.path }}</p>
                        <el-image v-if="selectedPreview(side)?.url" :src="selectedPreview(side).url" :preview-src-list="previewUrls" :initial-index="side === 'left' ? 0 : Math.max(0, previewUrls.length - 1)" fit="contain" preview-teleported />
                        <el-empty v-else :description="selectedPreview(side)?.error || label('loadingPreview')" :image-size="40" />
                        <p v-if="selectedPreview(side)?.width">{{ selectedPreview(side).width }}×{{ selectedPreview(side).height }} · {{ selectedPreview(side).format }} · {{ formatBytes(selectedPreview(side).bytes) }}</p>
                      </template>
                      <el-empty v-else :description="label('pageMissing')" :image-size="40" />
                    </div>
                  </div>
                  <div class="unique-pages"><span>{{ label('onlyLeft') }}: <button v-for="entry in evidence.comparison.onlyLeft" :key="entry.index" class="text-button" @click="jumpUnique('left', entry.index)">{{ entry.index + 1 }}</button><span v-if="!evidence.comparison.onlyLeft.length">0</span></span><span>{{ label('onlyRight') }}: <button v-for="entry in evidence.comparison.onlyRight" :key="entry.index" class="text-button" @click="jumpUnique('right', entry.index)">{{ entry.index + 1 }}</button><span v-if="!evidence.comparison.onlyRight.length">0</span></span></div>
                </template>
              </el-tab-pane>
              <el-tab-pane :label="label('ancillary')" name="ancillary">
                <el-alert v-if="!evidence?.comparison?.verified" :closable="false" :title="label('verifyFirst')" />
                <template v-else><el-checkbox v-model="ancillaryDifferencesOnly">{{ label('onlyDifferences') }}</el-checkbox>
                  <el-table :data="ancillaryRows" class="ancillary-table"><el-table-column prop="path" :label="label('entry')" min-width="170" /><el-table-column :label="label('baseline')" min-width="100"><template #default="{ row }">{{ row.left ? formatBytes(row.left.size) : label('missing') }}</template></el-table-column><el-table-column :label="label('compared')" min-width="100"><template #default="{ row }">{{ row.right ? formatBytes(row.right.size) : label('missing') }}</template></el-table-column><el-table-column :label="label('difference')" width="100"><template #default="{ row }">{{ label('file_' + row.status) }}</template></el-table-column><el-table-column width="80"><template #default="{ row }"><el-button v-if="isText(row.path)" size="small" @click="openText(row.path)">{{ label('viewText') }}</el-button></template></el-table-column></el-table>
                  <div class="ehviewer-fields" v-if="ehviewerFields.length"><h4>.ehviewer</h4><p class="muted">{{ label('markerFields') }}</p><el-table :data="ehviewerFields"><el-table-column prop="key" :label="label('field')" min-width="130" /><el-table-column prop="left" :label="label('baseline')" min-width="130" /><el-table-column prop="right" :label="label('compared')" min-width="130" /></el-table></div>
                </template>
              </el-tab-pane>
            </el-tabs>
            <details class="technical"><summary>{{ label('technical') }}</summary><pre>{{ JSON.stringify({ group: selectedGroup, comparison: evidence?.comparison }, null, 2) }}</pre></details>
          </div>
          <section class="decision-editor">
            <div class="decision-heading"><strong>{{ label('decision') }}</strong><el-checkbox v-model="autoNext">{{ label('autoNext') }}</el-checkbox><el-button size="small" :disabled="busy || report.stale || report.legacy || report.outdatedRules" @click="$emit('start', { groupIds: [selectedGroup.id], reportId: report.reportId, scanMode: 'full', forceRecompute })">{{ label('verifyGroup') }}</el-button><el-button size="small" :disabled="caseLocked || !selectedGroup.eligible" @click="useSuggestion">{{ $t('audit.useSuggestion') }}</el-button></div>
            <details class="optional-reason"><summary>{{ label('optionalReason') }}</summary><el-input v-model="reason" :disabled="caseLocked" :placeholder="label('decisionReason')" /></details>
            <div class="decision-actions"><el-button type="primary" :loading="saving" :disabled="caseLocked || !canApprove" @click="saveDecision('duplicate')">{{ label('duplicate') }}</el-button><el-button :disabled="caseLocked" @click="saveDecision('different-version')">{{ label('differentVersion') }}</el-button>
              <span class="full-decision-actions"><el-button :disabled="caseLocked" @click="saveDecision('not-duplicate')">{{ label('notDuplicate') }}</el-button><el-button :disabled="caseLocked" @click="saveDecision('deferred')">{{ label('defer') }}</el-button><el-button :disabled="editingLocked || !decisions[selectedGroup.id]" @click="undoDecision">{{ label('undo') }}</el-button></span>
              <el-dropdown class="compact-decision-actions" trigger="click" :disabled="caseLocked" @command="command => command === 'undo' ? undoDecision() : saveDecision(command)"><el-button :disabled="caseLocked">{{ label('otherDecisions') }} ▾</el-button><template #dropdown><el-dropdown-menu><el-dropdown-item command="not-duplicate">{{ label('notDuplicate') }}</el-dropdown-item><el-dropdown-item command="deferred">{{ label('defer') }}</el-dropdown-item><el-dropdown-item command="undo" :disabled="!decisions[selectedGroup.id]">{{ label('undo') }}</el-dropdown-item></el-dropdown-menu></template></el-dropdown>
            </div>
          </section>
        </section>
        <el-empty v-else class="comparison-area" :description="label('chooseGroup')" />
      </div>
      <footer class="review-action-bar"><span>{{ label('pendingExecution', { groups: approvedGroups, files: pendingFiles.length }) }} · {{ reviewSaving ? $t('audit.reviewSaving') : reviewDirty ? $t('audit.reviewUnsaved') : $t('audit.reviewAutoSaved') }}</span><button v-if="dirtyGroups.length" class="text-button draft-state" @click="selectGroup(dirtyGroups[0].id)">{{ label('unsavedGroups', { count: dirtyGroups.length }) }}</button><el-button type="danger" :disabled="busy || editingLocked || reviewDirty || dirtyGroups.length > 0 || !pendingFiles.length" @click="$emit('execute')">{{ label('executionList') }}</el-button></footer>
    </template>
    <el-empty v-else :description="$t('audit.noDedupeReport')" />
    <el-dialog v-model="textVisible" :title="textPath" width="90%" class="text-comparison-dialog"><div class="text-pair" v-loading="textLoading"><pre v-for="side in ['left', 'right']" :key="side">{{ textResults.find(item => item.key === side)?.text || textResults.find(item => item.key === side)?.error || label('missing') }}</pre></div></el-dialog>
    <el-dialog v-model="historyVisible" :title="label('history')" width="90%"><el-empty v-if="!history.length" :description="label('noHistory')" /><div v-for="entry in history" :key="entry.executionId" class="history-entry"><strong>{{ entry.at ? new Date(entry.at).toLocaleString() : entry.executionId }} · {{ entry.movedCount }} {{ label('files') }} · {{ entry.recordOnlyCount || 0 }} {{ label('records') }}</strong><el-button size="small" @click="locate(entry.backupDir)">{{ label('openBackup') }}</el-button><div v-for="file in entry.files" :key="file.source"><p>{{ file.source }} → {{ file.target }}</p><el-button size="small" @click="locate(file.target)">{{ label('openQuarantine') }}</el-button></div></div></el-dialog>
  </section>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import DedupeMemberCard from './DedupeMemberCard.vue'
import AiAnalysisPanel from './AiAnalysisPanel.vue'
import { createKeepDraft, getDecisionFiles, isPendingDecision, keepDraftFingerprint, pagePairs, resolvedByOtherDecision as isResolvedElsewhere, retainOnlyEquivalent, scheduledRemovalOwners, suggestedDecision, toggleKeep } from './dedupeReview.mjs'

const props = defineProps({
  active: Boolean, report: { type: Object, default: null }, reviewReportId: { type: String, default: null },
  state: { type: Object, required: true }, busy: Boolean, reviewLocked: Boolean,
  selections: { type: Object, default: () => ({}) }, decisions: { type: Object, default: () => ({}) }, aiAvailable: Boolean,
  commitDecisions: { type: Function, required: true }, reviewSaving: Boolean, reviewDirty: Boolean
})
defineEmits(['start', 'execute'])
const { t, te } = useI18n()
const label = (key, values = {}) => t('audit.dedupeReview.' + key, values)
const kindLabel = kind => te('audit.type_' + kind) ? t('audit.type_' + kind) : label('kind_' + kind)
const scanMode = ref('daily'), forceRecompute = ref(false), search = ref(''), kindFilter = ref(''), relationFilter = ref('all'), statusFilter = ref('all'), needsEvidence = ref(false)
const selectedId = ref(null), leftId = ref(null), rightId = ref(null), queuePage = ref(1), queueSize = 30, queueList = ref(null)
const view = ref('overview'), evidence = ref(null), evidenceLoading = ref(false), pagePosition = ref(1), alignment = ref('ordinal'), differencesOnly = ref(false)
const previews = ref([]), previewLoading = ref(false), ancillaryDifferencesOnly = ref(true), errorsVisible = ref(false)
const drafts = ref({}), autoNext = ref(true), saving = ref(false), comparisonScroll = ref(null)
const memberDates = ref({})
const textVisible = ref(false), textLoading = ref(false), textPath = ref(''), textResults = ref([])
const historyVisible = ref(false), history = ref([])
let evidenceToken = 0, previewToken = 0, textToken = 0
const statusOptions = ['all', 'pending', 'duplicate', 'different-version', 'not-duplicate', 'deferred']
const running = computed(() => ['running', 'cancelling'].includes(props.state.status))
const locked = computed(() => props.reviewLocked || props.report?.executable === false)
const editingLocked = computed(() => locked.value || saving.value || props.reviewSaving)
const currentDraft = computed(() => drafts.value[selectedId.value])
const keepDraft = computed(() => currentDraft.value?.selection || { keepIds: [] })
const updateDraft = values => { if (currentDraft.value) drafts.value[selectedId.value] = { ...currentDraft.value, ...values } }
const reason = computed({ get: () => currentDraft.value?.reason || '', set: value => updateDraft({ reason: value }) })
const draftIsDirty = id => { const draft = drafts.value[id]; return Boolean(draft && draft.baseline !== keepDraftFingerprint(draft.selection, draft.reason)) }
const dirtyGroups = computed(() => (props.report?.groups || []).filter(group => drafts.value[group.id]?.selection.evidenceRevision === group.evidenceRevision && draftIsDirty(group.id)))
const lastRunText = computed(() => props.state.completedAt ? t('audit.lastCheckedAt', { time: new Date(props.state.completedAt).toLocaleString() }) : t('audit.neverChecked'))
const kinds = computed(() => [...new Set((props.report?.groups || []).map(group => group.kind))])
const coverageGroupCount = computed(() => (props.report?.groups || []).filter(group => group.relations?.some(pair => pair.category === 'coverage')).length)
const scheduledRemovalOwner = computed(() => scheduledRemovalOwners(props.report, props.decisions))
const resolvedByOtherDecision = group => isResolvedElsewhere(group, scheduledRemovalOwner.value)
const isReviewPending = group => isPendingDecision(props.decisions[group.id]) && !resolvedByOtherDecision(group)
const filteredGroups = computed(() => (props.report?.groups || []).filter(group => {
  const decision = props.decisions[group.id]
  const relations = group.relations || []
  return (!kindFilter.value || group.kind === kindFilter.value)
    && (relationFilter.value === 'all' || relationFilter.value === 'coverage' && relations.some(pair => pair.category === 'coverage') ||
      relationFilter.value === 'contains' && relations.some(pair => pair.category === 'coverage' && ['left_contains_right', 'right_contains_left'].includes(pair.declaredRelation)) ||
      relationFilter.value === 'overlap' && relations.some(pair => pair.category === 'coverage' && (pair.declaredRelation === 'overlap' || pair.contentRelation === 'overlap')))
    && (statusFilter.value === 'all' || (statusFilter.value === 'pending' ? isReviewPending(group) : decision?.disposition === statusFilter.value))
    && (!needsEvidence.value || group.verification?.status !== 'verified')
    && (!search.value.trim() || JSON.stringify([group.items.map(item => [item.title, item.title_jpn, item.filepath, item.sourceEvidence?.sources, item.semantic]), group.kind]).toLowerCase().includes(search.value.trim().toLowerCase()))
}))
const pagedGroups = computed(() => filteredGroups.value.slice((queuePage.value - 1) * queueSize, queuePage.value * queueSize))
const selectedGroup = computed(() => props.report?.groups?.find(group => group.id === selectedId.value))
const caseLocked = computed(() => editingLocked.value || resolvedByOtherDecision(selectedGroup.value))
const selectedIndex = computed(() => filteredGroups.value.findIndex(group => group.id === selectedId.value))
const leftBook = computed(() => selectedGroup.value?.items.find(item => item.id === leftId.value))
const rightBook = computed(() => selectedGroup.value?.items.find(item => item.id === rightId.value))
const datedBook = book => {
  if (!book) return null
  const dates = memberDates.value[book.id]
  return dates ? { ...book, posted: book.posted || dates.posted, mtime: book.mtime || dates.mtime } : book
}
const pendingFiles = computed(() => getDecisionFiles(props.report, props.decisions, props.selections))
const approvedGroups = computed(() => new Set(pendingFiles.value.map(item => item.groupId)).size)
const suggestible = computed(() => filteredGroups.value.filter(group => group.eligible && isReviewPending(group) && !draftIsDirty(group.id)))
const pairs = computed(() => pagePairs(evidence.value, alignment.value, differencesOnly.value))
const currentPair = computed(() => pairs.value[pagePosition.value - 1] || null)
const selectedPreview = side => currentPair.value?.[side] !== null ? previews.value.find(item => item.key === side + '-' + currentPair.value?.[side]) : null
const previewUrls = computed(() => ['left', 'right'].map(side => selectedPreview(side)?.url).filter(Boolean))
const ancillaryRows = computed(() => (evidence.value?.comparison?.ancillary || []).filter(item => !ancillaryDifferencesOnly.value || item.status !== 'same'))
const ehviewerFields = computed(() => {
  const a = evidence.value?.left?.ehviewer?.fields || {}, b = evidence.value?.right?.ehviewer?.fields || {}
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].map(key => ({ key, left: JSON.stringify(a[key] ?? null), right: JSON.stringify(b[key] ?? null) })).filter(item => !ancillaryDifferencesOnly.value || item.left !== item.right)
})
const canApprove = computed(() => !caseLocked.value && keepDraft.value.keepIds.length > 0 && keepDraft.value.keepIds.length < (selectedGroup.value?.items.length || 0))
const formatBytes = value => { let size = Number(value || 0), index = 0; const units = ['B', 'KB', 'MB', 'GB', 'TB']; while (size >= 1024 && index < units.length - 1) { size /= 1024; index++ } return size.toFixed(index ? 1 : 0) + ' ' + units[index] }
const memberTitle = id => selectedGroup.value?.items.find(item => item.id === id)?.title || id
const request = () => ({ reportId: props.report.reportId, groupId: selectedId.value, leftId: leftId.value, rightId: rightId.value })
const showError = error => ElMessage.error(String(error?.message || error))
const locate = async filepath => { try { await window.auditApi.showFile(filepath) } catch (error) { showError(error) } }
const openUrl = async url => { try { await window.auditApi.openUrl(url) } catch (error) { showError(error) } }
const openDetail = async bookId => { try { await window.auditApi.openBookDetail({ bookId, navigationIds: selectedGroup.value.items.map(item => item.id) }) } catch (error) { showError(error) } }
const centerSelectedGroup = async id => {
  await nextTick()
  if (selectedId.value !== id || !queueList.value) return
  const item = queueList.value.querySelector('.queue-item.selected')
  if (!item) return
  const listRect = queueList.value.getBoundingClientRect()
  const itemRect = item.getBoundingClientRect()
  queueList.value.scrollTop += itemRect.top - listRect.top - (queueList.value.clientHeight - itemRect.height) / 2
}
const selectGroup = (id, center = false) => {
  selectedId.value = id
  const index = filteredGroups.value.findIndex(group => group.id === id)
  if (index >= 0) queuePage.value = Math.floor(index / queueSize) + 1
  if (center) void centerSelectedGroup(id)
}
const navigate = offset => { const group = filteredGroups.value[selectedIndex.value + offset]; if (group) selectGroup(group.id, true) }
let focusPendingOnEntry = false
const focusFirstPendingOnEntry = () => {
  if (!focusPendingOnEntry || !props.active || !props.report?.reportId || props.reviewReportId !== props.report.reportId) return
  focusPendingOnEntry = false
  const firstPending = filteredGroups.value.find(isReviewPending)
  if (firstPending) selectGroup(firstPending.id, true)
}
const resetGroupDraft = group => {
  const decision = props.decisions[group.id], selection = createKeepDraft(group, decision)
  const reason = decision?.reason || ''
  drafts.value[group.id] = { selection, reason, baseline: keepDraftFingerprint(selection, reason) }
}
const resetDraft = () => { if (selectedGroup.value) resetGroupDraft(selectedGroup.value) }
const useSuggestion = () => { if (!caseLocked.value) updateDraft({ selection: createKeepDraft(selectedGroup.value, suggestedDecision(selectedGroup.value)) }) }
const keepAll = () => { if (!caseLocked.value) updateDraft({ selection: createKeepDraft(selectedGroup.value) }) }
const setRetained = (id, checked) => {
  if (caseLocked.value) return
  if (!checked && keepDraft.value.keepIds.length === 1) { ElMessage.info(label('oneKeeperRequired')); return }
  updateDraft({ selection: toggleKeep(selectedGroup.value, keepDraft.value, id, checked) })
}
const keepOnly = id => { if (!caseLocked.value) updateDraft({ selection: retainOnlyEquivalent(selectedGroup.value, keepDraft.value, id) }) }
const setBaseline = id => { leftId.value = id }
const compareBook = id => { rightId.value = id; view.value = 'pages' }
const compareRelation = relation => { leftId.value = relation.leftId; rightId.value = relation.rightId; view.value = 'pages' }
const loadEvidence = async () => {
  const token = ++evidenceToken
  evidence.value = null; previews.value = []; evidenceLoading.value = true; ++previewToken; ++textToken; textVisible.value = false
  await window.auditApi.cleanupDedupePreview?.()
  if (!selectedGroup.value || !leftId.value || !rightId.value || token !== evidenceToken) return
  try { const value = await window.auditApi.getDedupeComparison(request()); if (token === evidenceToken) evidence.value = value }
  catch (error) { if (token === evidenceToken) showError(error) }
  finally { if (token === evidenceToken) evidenceLoading.value = false }
}
const loadPreview = async () => {
  const token = ++previewToken
  if (view.value !== 'pages' || !currentPair.value) { previews.value = []; return }
  previewLoading.value = true
  const pair = currentPair.value
  try { const result = await window.auditApi.getDedupePreview({ ...request(), leftIndex: pair.left, rightIndex: pair.right }); if (token === previewToken) previews.value = result }
  catch (error) { if (token === previewToken && !String(error.message).includes('AUDIT_CANCELLED')) showError(error) }
  finally { if (token === previewToken) previewLoading.value = false }
}
const firstDifference = () => { alignment.value = 'ordinal'; nextTick(() => { const index = pairs.value.findIndex(pair => pair.left === evidence.value.comparison.firstDifference || pair.right === evidence.value.comparison.firstDifference); pagePosition.value = Math.max(1, index + 1) }) }
const jumpUnique = (side, index) => { alignment.value = 'hash'; nextTick(() => { pagePosition.value = Math.max(1, pairs.value.findIndex(pair => pair[side] === index) + 1) }) }
const isText = filepath => /(?:\.ehviewer|\.(txt|json|xml|ya?ml|ini|nfo|md))$/i.test(filepath)
const openText = async filepath => {
  const token = ++textToken; ++previewToken; textPath.value = filepath; textResults.value = []; textVisible.value = true; textLoading.value = true
  try { const result = await window.auditApi.getDedupePreview({ ...request(), textPath: filepath }); if (token === textToken) textResults.value = result }
  catch (error) { if (token === textToken && !String(error.message).includes('AUDIT_CANCELLED')) showError(error) }
  finally { if (token === textToken) textLoading.value = false }
}
const saveDecision = async disposition => {
  if (caseLocked.value || !selectedGroup.value) return
  const group = selectedGroup.value
  const previousOrder = [...filteredGroups.value]
  const position = previousOrder.findIndex(item => item.id === group.id)
  saving.value = true
  try {
    await props.commitDecisions({ [group.id]: { disposition, selectionMode: disposition === 'duplicate' ? 'checkbox' : undefined, evidenceRevision: group.evidenceRevision,
      keepIds: disposition === 'duplicate' ? keepDraft.value.keepIds : group.items.map(item => item.id),
      reason: reason.value } })
    resetGroupDraft(group)
    ElMessage.success(t('audit.reviewSaved'))
    if (autoNext.value && selectedId.value === group.id) {
      const next = [...previousOrder.slice(position + 1), ...previousOrder.slice(0, position)].find(isReviewPending)
      if (next) selectGroup(next.id, true)
    }
  } catch (error) { showError(error) }
  finally { saving.value = false }
}
const undoDecision = async () => { const group = selectedGroup.value; saving.value = true; try { await props.commitDecisions({ [group.id]: null }); resetGroupDraft(group) } catch (error) { showError(error) } finally { saving.value = false } }
const adoptVisible = async () => {
  saving.value = true
  try { const groups = [...suggestible.value]; await props.commitDecisions(Object.fromEntries(groups.map(group => [group.id, suggestedDecision(group)]))); groups.forEach(resetGroupDraft); ElMessage.success(t('audit.reviewSaved')) }
  catch (error) { showError(error) } finally { saving.value = false }
}
const openHistory = async () => { try { history.value = await window.auditApi.getDedupeHistory(); historyVisible.value = true } catch (error) { showError(error) } }

watch(() => props.report, (report, previous) => {
  if (report?.reportId === previous?.reportId) return
  memberDates.value = {}
  if (report?.options?.scope === 'groups' && previous) {
    const previousIndex = previous.groups.findIndex(group => group.id === selectedId.value)
    const memberIds = new Set(previous.groups[previousIndex]?.items.map(item => item.id) || [])
    const group = filteredGroups.value.find(group => group.id === selectedId.value)
      || filteredGroups.value.find(group => group.items.some(item => memberIds.has(item.id)))
      || filteredGroups.value[Math.min(Math.max(0, previousIndex), filteredGroups.value.length - 1)]
    selectGroup(group?.id || null)
  } else {
    selectedId.value = report?.groups?.[0]?.id || null
    queuePage.value = 1
  }
}, { immediate: true })
watch(() => props.active, active => {
  focusPendingOnEntry = active
  if (active) focusFirstPendingOnEntry()
}, { immediate: true, flush: 'post' })
watch([() => props.report?.reportId, () => props.reviewReportId, filteredGroups], focusFirstPendingOnEntry, { flush: 'post' })
let dateRequestToken = 0
watch([selectedGroup, () => props.report?.reportId], async ([group]) => {
  const token = ++dateRequestToken
  const missing = (group?.items || []).filter(book => (!Number(book.posted) || (!book.mtime && book.mtimeMs == null)) && !memberDates.value[book.id])
  if (!missing.length || !window.auditApi.getBookPreview) return
  const results = await Promise.allSettled(missing.map(book => window.auditApi.getBookPreview(book.id)))
  if (token !== dateRequestToken) return
  const dates = { ...memberDates.value }
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') dates[missing[index].id] = { posted: result.value?.posted ?? null, mtime: result.value?.mtime ?? null }
  })
  memberDates.value = dates
  const failure = results.find(result => result.status === 'rejected')
  if (failure) showError(failure.reason)
}, { immediate: true })
watch(selectedGroup, group => {
  if (group) {
    const previous = drafts.value[group.id]
    if (!previous || previous.selection.evidenceRevision !== group.evidenceRevision) {
      if (previous && draftIsDirty(group.id)) ElMessage.info(label('draftEvidenceChanged'))
      resetGroupDraft(group)
    }
  }
  view.value = 'overview'; pagePosition.value = 1
  nextTick(() => { if (comparisonScroll.value) comparisonScroll.value.scrollTop = 0 })
  leftId.value = group?.suggestedKeepId || group?.items[0]?.id || null
  rightId.value = group?.items.find(item => item.id !== leftId.value)?.id || null
}, { immediate: true })
watch([leftId, rightId, view, () => props.report?.reportId], () => {
  if (leftId.value === rightId.value) rightId.value = selectedGroup.value?.items.find(item => item.id !== leftId.value)?.id || null
  pagePosition.value = 1
  nextTick(() => { if (comparisonScroll.value) comparisonScroll.value.scrollTop = 0 })
  if (view.value !== 'overview') void loadEvidence().catch(showError)
  else { ++evidenceToken; ++previewToken; ++textToken; evidence.value = null; previews.value = []; void window.auditApi.cleanupDedupePreview?.() }
})
watch([view, currentPair], () => { void loadPreview() })
watch([alignment, differencesOnly], () => { pagePosition.value = 1 })
watch(() => filteredGroups.value.length, total => { queuePage.value = Math.min(queuePage.value, Math.max(1, Math.ceil(total / queueSize))) })
onBeforeUnmount(() => { ++evidenceToken; ++previewToken; ++textToken; void window.auditApi.cleanupDedupePreview?.() })
</script>

<style scoped>
.task-panel { min-height: 0; height: 100%; display: flex; flex-direction: column; color: var(--el-text-color-primary); }.task-toolbar,.scan-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }.task-toolbar { justify-content: space-between; padding: 8px 0; flex: 0 0 auto; }.scan-mode { width: 180px; }.last-run,.muted,.check-time { color: var(--el-text-color-secondary); font-size: 12px; }.summary-band { display: flex; flex-wrap: wrap; gap: 16px; padding: 8px 12px; background: var(--el-fill-color-light); font-size: 12px; border-radius: 4px; }.filters { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 0; }.filters .el-input { flex: 1 1 190px; }.filters .el-select { width: 145px; }.review-workspace { display: grid; grid-template-columns: 250px minmax(0,1fr); gap: 12px; flex: 1; min-height: 360px; overflow: hidden; }.queue { min-height: 0; display: flex; flex-direction: column; border: 1px solid var(--el-border-color); border-radius: 6px; }.queue-heading { padding: 12px; font-size: 13px; font-weight: 600; border-bottom: 1px solid var(--el-border-color); }.queue-list { overflow-y: auto; flex: 1; min-height: 0; }.queue-item { width: 100%; display: flex; flex-direction: column; gap: 7px; padding: 12px; text-align: left; color: inherit; background: none; border: 0; border-bottom: 1px solid var(--el-border-color-light); cursor: pointer; font-size: 12px; }.queue-item.selected { background: var(--el-color-primary-light-9); border-left: 3px solid var(--el-color-primary); padding-left: 9px; }.queue-item-title { font-weight: 600; overflow-wrap: anywhere; }.queue-state { color: var(--el-text-color-secondary); }.queue .el-pagination { padding: 8px; justify-content: center; }.comparison-area { min-height: 0; min-width: 0; display: flex; flex-direction: column; }.comparison-heading { display: flex; gap: 8px; justify-content: space-between; align-items: flex-start; }.comparison-heading strong { font-size: 17px; }.check-time { display: block; margin-top: 5px; }.group-navigation { display: flex; align-items: center; gap: 7px; white-space: nowrap; }.group-navigation .el-button { margin: 0; }.reason-chips { display: flex; flex-wrap: wrap; gap: 5px; margin: 8px 0; }.member-strip { display: flex; align-items: center; gap: 8px; padding-bottom: 8px; }.member-strip .el-select { width: calc(50% - 18px); }.comparison-scroll { overflow-y: auto; min-height: 110px; flex: 1; padding-right: 3px; }.page-pair,.text-pair { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap: 10px; }.equivalence-list { margin-top: 12px; padding: 12px; border-radius: 5px; background: var(--el-fill-color-light); font-size: 12px; overflow-wrap: anywhere; }.equivalence-list p { margin: 6px 0; }.page-controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 10px 0; }.page-controls .el-select { width: 220px; }.page-summary { font-size: 12px; color: var(--el-text-color-secondary); }.page-card { min-width: 0; padding: 10px; border: 1px solid var(--el-border-color); border-radius: 6px; font-size: 12px; overflow-wrap: anywhere; }.page-card strong { display: block; }.page-card .el-image { width: 100%; height: 270px; background: var(--el-fill-color-light); }.page-card p { margin: 7px 0; }.unique-pages { display: flex; gap: 20px; padding: 10px 0; font-size: 12px; flex-wrap: wrap; }.text-button { font: inherit; cursor: pointer; border: 0; padding: 0 4px; color: var(--el-color-primary); background: none; }.technical { margin: 12px 0; font-size: 12px; }.technical pre,.errors { max-height: 240px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; padding: 12px; background: var(--el-fill-color-light); }.errors { flex: 0 0 auto; max-height: 120px; font-size: 12px; }.decision-editor { border-top: 1px solid var(--el-border-color); padding: 10px 0 0; flex: 0 0 auto; }.decision-heading { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }.decision-heading .el-button { margin: 0; }.differences-confirmed { height: auto; white-space: normal; margin-top: 6px; font-size: 12px; }.differences-confirmed :deep(.el-checkbox__label) { white-space: normal; }.decision-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }.decision-actions .el-button { margin: 0; }.review-action-bar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; padding: 10px 12px; margin-top: 10px; border: 1px solid var(--el-border-color); border-radius: 5px; font-size: 12px; }.text-pair pre { min-width: 0; max-height: 60vh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--el-fill-color-light); padding: 12px; }.history-entry { border-bottom: 1px solid var(--el-border-color); padding: 12px 0; }.history-entry p { overflow-wrap: anywhere; font-size: 12px; }
.comparison-area { container-type: inline-size; overflow: hidden; }
.review-workspace { min-height: 0; }
.comparison-scroll { min-height: 0; padding-bottom: 4px; }
.member-grid { display: grid; grid-template-columns: repeat(var(--member-columns), minmax(0,1fr)); gap: 10px; align-items: start; }
.member-summary-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; font-size: 12px; }
.member-summary-bar .el-button { margin: 0; }
.draft-state { color: var(--el-color-warning); font-size: 12px; }
.group-reasons { font-size: 12px; margin: 6px 0; }
.group-reasons summary { cursor: pointer; color: var(--el-text-color-secondary); }
.relations-list { display: flex; flex-direction: column; gap: 5px; margin-top: 12px; padding: 10px; background: var(--el-fill-color-light); border-radius: 5px; font-size: 12px; }
.relation-row { display: flex; flex-direction: column; gap: 3px; width: 100%; padding: 7px; text-align: left; color: inherit; background: var(--el-bg-color); border: 1px solid var(--el-border-color-light); border-radius: 4px; cursor: pointer; overflow-wrap: anywhere; }
.relation-row:hover { border-color: var(--el-color-primary); }
.relation-row small { color: var(--el-text-color-secondary); }
.decision-heading .el-checkbox { height: 24px; margin-right: 0; }
.decision-editor > .el-input { margin-top: 6px; }
.decision-editor { max-height: 45%; overflow-y: auto; }
.optional-reason { font-size: 12px; margin-top: 5px; }
.optional-reason summary { cursor: pointer; color: var(--el-text-color-secondary); }
.optional-reason .el-input { margin-top: 5px; }
.full-decision-actions { display: contents; }
.compact-decision-actions { display: none; }
@container (max-width: 960px) { .member-grid { grid-template-columns: repeat(var(--member-columns-medium), minmax(0,1fr)); } }
@container (max-width: 620px) { .member-grid { grid-template-columns: minmax(0,1fr); } }
@container (max-width: 700px) {
  .full-decision-actions { display: none; }
  .compact-decision-actions { display: inline-flex; }
}
@media (max-height: 680px) {
  .task-toolbar { padding: 4px 0; }
  .summary-band { padding: 4px 10px; }
  .filters { padding: 4px 0; }
  .check-time { display: none; }
  .group-reasons { margin: 3px 0; }
  .comparison-scroll :deep(.el-tabs__header) { margin-bottom: 6px; }
  .decision-editor { padding-top: 6px; }
  .decision-actions { margin-top: 4px; }
  .review-action-bar { padding: 6px 10px; margin-top: 6px; }
  .full-decision-actions { display: none; }
  .compact-decision-actions { display: inline-flex; }
}
@media (max-width: 1100px) { .review-workspace { grid-template-columns: 205px minmax(0,1fr); }.comparison-heading { flex-wrap: wrap; }.page-card .el-image { height: 210px; } }
@media (max-width: 850px) {
  .review-workspace { grid-template-columns: 155px minmax(0,1fr); gap: 8px; min-height: 160px; }
  .comparison-scroll { overflow-y: auto; }
  .comparison-area { min-height: 0; display: flex; }
  .page-pair { grid-template-columns: minmax(0,1fr) minmax(0,1fr); }
  .check-time,.last-run { display: none; }
  .summary-band { padding: 6px 10px; }
  .comparison-heading strong { font-size: 15px; }
  .reason-chips { margin: 5px 0; }
  .task-toolbar { padding: 5px 0; }
  .filters { flex-wrap: nowrap; overflow-x: auto; padding: 6px 0; flex: 0 0 auto; }
  .filters .el-input { flex: 0 0 190px; }
  .filters .el-select { width: 120px; flex: 0 0 120px; }
  .filters .el-checkbox,.filters .el-button { flex-shrink: 0; }
  .comparison-scroll :deep(.el-tabs__header) { margin-bottom: 6px; }
  .review-action-bar { padding: 7px 10px; }
  .decision-actions .el-button { flex: 1 1 auto; }
  .text-pair { grid-template-columns: 1fr; }
}
</style>

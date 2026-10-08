<template>
  <section class="task-panel">
    <div class="task-toolbar">
      <div class="task-toolbar-main">
        <el-button type="primary" :icon="VideoPlay" :disabled="busy" @click="start">{{ $t('audit.startAnomaly') }}</el-button>
        <el-button
          type="success"
          plain
          :icon="Select"
          :disabled="busy || !batchSafeCount || manualActionCount || report?.executable === false"
          @click="$emit('prepare-safe')"
        >
          {{ $t('audit.applySafeActions', { count: batchSafeCount }) }}
        </el-button>
      </div>
      <span class="last-run">{{ lastRunText }}</span>
    </div>

    <el-alert v-if="running && report" type="info" :closable="false" :title="$t('audit.previousAnomalyReportWhileRunning')" show-icon />
    <el-alert v-if="report?.legacy" type="warning" :closable="false" :title="$t('audit.legacyReportReadOnly')" show-icon />
    <el-alert v-if="report?.stale" type="warning" :closable="false" :title="$t('audit.staleReportReadOnly')" show-icon />

    <div v-if="report" class="summary-band">
      <div><strong>{{ report.summary.libraryItems }}</strong><span>{{ $t('audit.libraryItems') }}</span></div>
      <div><strong>{{ report.summary.mangaRows }}</strong><span>{{ $t('audit.databaseRows') }}</span></div>
      <div><strong>{{ report.summary.anomalies }}</strong><span>{{ $t('audit.anomalies') }}</span></div>
      <div><strong>{{ anomalyBookCount }}</strong><span>{{ $t('audit.anomalyBooks') }}</span></div>
      <div class="summary-safe"><strong>{{ batchSafeCount }}</strong><span>{{ $t('audit.batchSafeActions') }}</span></div>
      <div class="summary-manual"><strong>{{ manualReviewCount }}</strong><span>{{ $t('audit.manualReview') }}</span></div>
      <div><strong>{{ reportOnlyCount }}</strong><span>{{ $t('audit.reportOnly') }}</span></div>
      <div v-if="report.options?.onlinePolicy !== 'none'"><strong>{{ report.summary.onlineIdentities || 0 }}</strong><span>{{ $t('audit.onlineIdentities') }}</span></div>
      <div v-if="report.options?.onlinePolicy !== 'none'"><strong>{{ report.summary.onlineAvailable || 0 }}</strong><span>{{ $t('audit.onlineAvailable') }}</span></div>
      <div v-if="report.options?.onlinePolicy !== 'none'"><strong>{{ report.summary.onlineCopyright || 0 }}</strong><span>{{ $t('audit.onlineCopyright') }}</span></div>
      <div v-if="report.summary.versionChainMatches"><strong>{{ report.summary.versionChainMatches }}</strong><span>{{ $t('audit.versionChainMatches') }}</span></div>
    </div>

    <template v-if="report">
      <div class="filter-row">
        <el-input v-model="searchInput" :prefix-icon="Search" clearable :placeholder="$t('audit.filterPlaceholder')" />
        <el-select v-model="severityFilter" clearable :placeholder="$t('audit.severity')">
          <el-option v-for="severity in severities" :key="severity" :label="$t(`audit.${severity}`)" :value="severity" />
        </el-select>
        <el-select v-model="typeFilter" clearable filterable :placeholder="$t('audit.type')">
          <el-option v-for="type in anomalyTypes" :key="type" :label="auditTypeLabel(type)" :value="type" />
        </el-select>
      </div>
      <div class="filter-meta-row">
        <el-select v-model="policyFilter" clearable :placeholder="$t('audit.workflowStatus')">
          <el-option :label="$t('audit.batchSafeActions')" value="batch-safe" />
          <el-option :label="$t('audit.manualReview')" value="manual" />
          <el-option :label="$t('audit.reportOnly')" value="report-only" />
        </el-select>
        <div class="filter-counts" aria-live="polite">
        <span>{{ $t('audit.filteredBookCount', { scope: filterScopeLabel, count: filteredBookGroups.length }) }}</span>
          <strong v-if="manualActionCount">{{ $t('audit.manualActionsSelected', { count: manualActionCount }) }}</strong>
        </div>
      </div>
      <div v-if="pageRecoveryBookGroupCount" class="page-recovery-batch-bar">
        <div class="page-recovery-batch-actions">
          <el-button
            type="warning"
            plain
            :icon="Download"
            :loading="pageRecoveryBatchLoading"
            :disabled="busy || pageRecoveryBatchLoading || pageRecoveryBatchApplyLoading || !pageRecoverySelectedGroups.length"
            @click="batchFetchPageRecovery"
          >
            {{ pageRecoveryBatchLoading ? $t('audit.pageRecoveryBatchFetching', { current: pageRecoveryBatchCompleted, total: pageRecoveryBatchTotal }) : $t('audit.pageRecoveryBatchFetch', { count: pageRecoverySelectedGroups.length }) }}
          </el-button>
          <el-button
            type="success"
            plain
            :icon="Upload"
            :loading="pageRecoveryBatchApplyLoading"
            :disabled="busy || pageRecoveryBatchLoading || pageRecoveryBatchApplyLoading || !pageRecoveryBatchReadyGroups.length"
            @click="batchApplyPageRecovery"
          >
            {{ pageRecoveryBatchApplyLoading ? $t('audit.pageRecoveryBatchApplying') : $t('audit.pageRecoveryBatchApply', { count: pageRecoveryBatchReadyGroups.length }) }}
          </el-button>
          <el-button v-if="pageRecoverySelectedGroupIds.length" text :disabled="pageRecoveryBatchLoading || pageRecoveryBatchApplyLoading" @click="clearPageRecoverySelection">
            {{ $t('audit.pageRecoveryBatchClear') }}
          </el-button>
        </div>
        <span>{{ $t('audit.pageRecoveryBatchSummary', { count: pageRecoverySelectedGroups.length }) }}</span>
      </div>
      <div class="audit-table-region">
        <el-empty v-if="!pagedBookGroups.length" class="filtered-empty" :description="$t('audit.noAnomalyInFilter')" />
        <el-table ref="pageRecoveryTable" v-else :data="pagedBookGroups" height="100%" row-key="id" @select="handlePageRecoverySelect" @select-all="handlePageRecoverySelectAll" @row-click="handleAuditRowClick">
          <el-table-column type="selection" width="48" reserve-selection :selectable="isPageRecoverySelectable" />
          <el-table-column :label="$t('audit.workflowStatus')" width="118">
            <template #default="scope"><el-tag :type="policyTagType(scope.row.groupPolicy)" effect="plain">{{ policyLabel(scope.row.groupPolicy) }}</el-tag></template>
          </el-table-column>
          <el-table-column :label="$t('audit.severity')" width="94">
            <template #default="scope"><el-tag :type="severityTag(scope.row.severity)" effect="plain">{{ $t(`audit.${scope.row.severity}`) }}</el-tag></template>
          </el-table-column>
          <el-table-column :label="$t('audit.type')" min-width="220" show-overflow-tooltip>
            <template #default="scope">{{ scope.row.typeSummary }}</template>
          </el-table-column>
          <el-table-column :label="$t('audit.reason')" min-width="280" show-overflow-tooltip>
            <template #default="scope">{{ scope.row.reasonSummary }}</template>
          </el-table-column>
          <el-table-column prop="filepath" :label="$t('audit.filepath')" min-width="420" show-overflow-tooltip />
          <el-table-column :label="$t('audit.anomalyCount')" width="84" align="center">
            <template #default="scope">{{ scope.row.anomalyCount }}</template>
          </el-table-column>
          <el-table-column v-if="pageRecoveryBookGroupCount" :label="$t('audit.pageRecoveryBatchStatus')" width="120" align="center">
            <template #default="scope">
              <el-tooltip v-if="pageRecoveryBatchResults[scope.row.id]?.error" :content="pageRecoveryBatchResults[scope.row.id].error" placement="top">
                <el-tag :type="pageRecoveryBatchStatusType(scope.row)" effect="plain">{{ pageRecoveryBatchStatusLabel(scope.row) }}</el-tag>
              </el-tooltip>
              <el-tag v-else-if="pageRecoveryBatchResults[scope.row.id]" :type="pageRecoveryBatchStatusType(scope.row)" effect="plain">{{ pageRecoveryBatchStatusLabel(scope.row) }}</el-tag>
              <span v-else>-</span>
            </template>
          </el-table-column>
          <el-table-column width="54" align="center">
            <template #default="scope"><el-tooltip :content="$t('audit.locate')"><el-button link :icon="FolderOpened" @click.stop="locate(scope.row.filepath)" /></el-tooltip></template>
          </el-table-column>
        </el-table>
      </div>
      <el-pagination
        v-if="filteredBookGroups.length"
        v-model:current-page="page"
        v-model:page-size="pageSize"
        class="table-pagination"
        :page-sizes="pageSizes"
        :total="filteredBookGroups.length"
        layout="total, sizes, prev, pager, next, jumper"
      />
      <div class="review-action-bar">
        <div class="review-action-summary">
          <strong>{{ $t('audit.workflowSummary', { safe: batchSafeCount, manual: manualReviewCount, reportOnly: reportOnlyCount }) }}</strong>
          <span v-if="manualActionCount">{{ $t('audit.manualActionsReady', { count: manualActionCount }) }}</span>
        </div>
        <div class="review-action-buttons">
          <el-button type="danger" :icon="Select" :disabled="reviewLocked || !manualActionCount || report.executable === false" @click="$emit('execute')">{{ $t('audit.executeManualActions', { count: manualActionCount }) }}</el-button>
        </div>
      </div>
    </template>
    <el-empty v-else :description="$t('audit.noAnomalyReport')" />

    <el-drawer v-model="drawer" :title="auditTypeLabel(selectedAnomaly?.type)" size="46%" class="audit-anomaly-drawer">
      <template v-if="selectedAnomaly">
        <div class="anomaly-navigation" aria-live="polite">
          <el-button-group>
            <el-tooltip :content="$t('audit.previousAnomaly')">
              <el-button :icon="ArrowLeft" :disabled="!previousAnomaly || previewLoading" @click="navigateAnomaly(-1)">{{ $t('audit.previousAnomaly') }}</el-button>
            </el-tooltip>
            <el-tooltip :content="$t('audit.nextAnomaly')">
              <el-button :icon="ArrowRight" :disabled="!nextAnomaly || previewLoading" @click="navigateAnomaly(1)">{{ $t('audit.nextAnomaly') }}</el-button>
            </el-tooltip>
          </el-button-group>
          <span v-if="selectedAnomalyPosition" class="anomaly-navigation-count">
            {{ $t('audit.anomalyPosition', selectedAnomalyPosition) }}
          </span>
        </div>
        <div class="anomaly-detail-grid" :class="{ 'has-book-preview': selectedAnomaly.bookId }">
          <aside v-if="selectedAnomaly.bookId" class="anomaly-book-preview">
            <el-tooltip :content="$t('audit.openBookDetailWindow')" placement="bottom">
              <button type="button" class="anomaly-cover-button" :aria-label="$t('audit.openBookDetailWindow')" :disabled="detailOpening" @click="openBookDetail">
                <el-skeleton v-if="previewLoading" animated><template #template><el-skeleton-item variant="image" class="anomaly-cover" /></template></el-skeleton>
                <el-image v-else-if="bookPreview?.coverPath" class="anomaly-cover" :src="bookPreview.coverPath" fit="cover">
                  <template #error><div class="anomaly-cover-placeholder"><el-icon><Picture /></el-icon><span>{{ $t('audit.coverUnavailable') }}</span></div></template>
                </el-image>
                <div v-else class="anomaly-cover anomaly-cover-placeholder"><el-icon><Picture /></el-icon><span>{{ $t('audit.coverUnavailable') }}</span></div>
              </button>
            </el-tooltip>
            <p v-if="bookTitle" :title="bookTitle">{{ bookTitle }}</p>
          </aside>
          <div class="anomaly-description">
            <el-descriptions :column="1" border>
              <el-descriptions-item :label="$t('audit.severity')">{{ $t(`audit.${selectedAnomaly.severity}`) }}</el-descriptions-item>
              <el-descriptions-item :label="$t('audit.reason')">{{ selectedAnomaly.reason }}</el-descriptions-item>
              <el-descriptions-item :label="$t('audit.filepath')">{{ selectedAnomaly.filepath || '-' }}</el-descriptions-item>
              <el-descriptions-item :label="$t('audit.recommendation')">{{ recommendationLabel(selectedAnomaly.recommendedAction) }}</el-descriptions-item>
              <el-descriptions-item v-if="currentEvidenceUrl" :label="$t('audit.currentUrl')">
                <el-link type="primary" :underline="false" @click="openExternalUrl(currentEvidenceUrl)"><span>{{ currentEvidenceUrl }}</span><el-icon><TopRight /></el-icon></el-link>
              </el-descriptions-item>
              <el-descriptions-item v-if="ehviewerEvidenceUrl && ehviewerEvidenceUrl !== currentEvidenceUrl" :label="$t('audit.ehviewerUrl')">
                <el-link type="primary" :underline="false" @click="openExternalUrl(ehviewerEvidenceUrl)"><span>{{ ehviewerEvidenceUrl }}</span><el-icon><TopRight /></el-icon></el-link>
              </el-descriptions-item>
              <el-descriptions-item v-if="currentAvailability" :label="$t('audit.currentAvailability')"><availability-list :value="currentAvailability" /></el-descriptions-item>
              <el-descriptions-item v-if="ehviewerAvailability && ehviewerEvidenceUrl !== currentEvidenceUrl" :label="$t('audit.ehviewerAvailability')"><availability-list :value="ehviewerAvailability" /></el-descriptions-item>
              <el-descriptions-item v-if="pageSourceEvidence" :label="$t('audit.sourcePageCounts')">
                <div class="page-count-evidence">
                  <div class="page-count-row page-count-header">
                    <span>{{ $t('audit.source') }}</span><span>{{ $t('audit.pages') }}</span><span>{{ $t('audit.status') }}</span>
                  </div>
                  <div class="page-count-row">
                    <span>{{ $t('audit.localPages') }}</span><strong>{{ selectedAnomaly.evidence?.localPages ?? '-' }}</strong><span>-</span>
                  </div>
                  <div class="page-count-row">
                    <span>{{ $t('audit.currentUrl') }}</span><strong>{{ formatPageCount(pageSourceEvidence.currentUrl) }}</strong><el-tag size="small" effect="plain">{{ formatPageStatus(pageSourceEvidence.currentUrl) }}</el-tag>
                  </div>
                  <div class="page-count-row">
                    <span>{{ $t('audit.ehviewerUrl') }}</span><strong>{{ formatPageCount(pageSourceEvidence.ehviewerUrl) }}</strong><el-tag size="small" effect="plain">{{ formatPageStatus(pageSourceEvidence.ehviewerUrl) }}</el-tag>
                  </div>
                </div>
              </el-descriptions-item>
            </el-descriptions>
          </div>
        </div>
        <section v-if="selectedAnomaly.siblings?.length > 1" class="book-anomaly-summary" aria-labelledby="book-anomaly-summary-title">
          <strong id="book-anomaly-summary-title">{{ $t('audit.bookOtherAnomalies', { count: selectedAnomaly.siblings.length }) }}</strong>
          <div v-for="item in selectedAnomaly.siblings" :key="item.id" class="book-anomaly-item">
            <el-tag :type="policyTagType(item.actionPolicy)" effect="plain">{{ policyLabel(item.actionPolicy) }}</el-tag>
            <span>{{ auditTypeLabel(item.type) }}：{{ item.reason }}</span>
          </div>
        </section>
        <section v-if="manualSourceSelectionSupported" class="manual-source-selection" aria-labelledby="manual-source-selection-title">
          <div class="manual-source-heading">
            <div>
              <strong id="manual-source-selection-title">{{ $t('audit.manualSourceSelectionTitle') }}</strong>
              <span>{{ $t('audit.manualSourceSelectionDescription') }}</span>
            </div>
            <el-tag :type="selectedAnomaly.action ? 'success' : 'warning'" effect="plain">
              {{ selectedAnomaly.action ? $t('audit.approvableRepair') : $t('audit.reportOnly') }}
            </el-tag>
          </div>
          <el-radio-group :model-value="manualSourceForSelected" :disabled="reviewLocked || manualActionLoading" @change="selectManualSource">
            <el-radio-button v-if="manualCandidateUrls.current" value="current">{{ $t('audit.useCurrentSource') }}</el-radio-button>
            <el-radio-button v-if="manualCandidateUrls.ehviewer" value="ehviewer">{{ $t('audit.useEhviewerSource') }}</el-radio-button>
          </el-radio-group>
          <el-checkbox v-model="autoOpenNextAfterSelection" class="auto-next-selection" :disabled="reviewLocked || manualActionLoading">
            {{ $t('audit.autoOpenNextAfterSourceSelection') }}
          </el-checkbox>
          <el-alert v-if="selectedAnomaly.action" class="manual-source-alert" type="success" :closable="false" :title="$t('audit.manualSourceSelected')" show-icon />
        </section>
        <section v-if="selectedAnomaly.type === 'ehviewer-invalid'" class="ehviewer-recovery-preview" aria-labelledby="ehviewer-recovery-title">
          <div class="ehviewer-recovery-heading">
            <div>
              <strong id="ehviewer-recovery-title">{{ $t('audit.ehviewerRecoveryPreviewTitle') }}</strong>
              <span>{{ $t('audit.ehviewerRecoveryPreviewDescription') }}</span>
            </div>
            <el-tag :type="selectedAnomaly.action?.type === 'repair-ehviewer' ? 'success' : 'warning'" effect="plain">
              {{ selectedAnomaly.action?.type === 'repair-ehviewer' ? $t('audit.approvableRepair') : $t('audit.previewOnly') }}
            </el-tag>
          </div>
          <el-skeleton v-if="previewLoading" :rows="3" animated />
          <template v-else-if="ehviewerRecoveryPreview">
            <dl class="ehviewer-recovery-meta">
              <div>
                <dt>{{ $t('audit.ehviewerRecoverySourceUrl') }}</dt>
                <dd><el-link type="primary" :underline="false" @click="openExternalUrl(ehviewerRecoveryPreview.sourceUrl)">{{ ehviewerRecoveryPreview.sourceUrl }}<el-icon><TopRight /></el-icon></el-link></dd>
              </div>
              <div>
                <dt>{{ $t('audit.ehviewerRecoveryFormat') }}</dt>
                <dd>{{ ehviewerRecoveryPreview.format }}</dd>
              </div>
            </dl>
            <pre class="ehviewer-recovery-content">{{ ehviewerRecoveryPreview.content }}</pre>
            <el-alert
              v-if="selectedAnomaly.action?.type === 'repair-ehviewer'"
              class="ehviewer-recovery-alert"
              type="success"
              :closable="false"
              :title="$t('audit.ehviewerRecoveryApprovable')"
              show-icon
            />
          </template>
          <el-alert v-else type="warning" :closable="false" :title="$t('audit.ehviewerRecoveryUnavailable')" show-icon />
        </section>
        <section v-if="pageRecoverySupported" class="page-recovery-panel" aria-labelledby="page-recovery-title">
          <div class="page-recovery-heading">
            <div>
              <strong id="page-recovery-title">{{ $t('audit.pageRecoveryTitle') }}</strong>
              <span>{{ $t('audit.pageRecoveryDescription') }}</span>
            </div>
            <div class="page-recovery-heading-meta">
              <span class="page-recovery-page-count">{{ $t('audit.pages') }}: {{ pageRecoveryPageCountText }}</span>
              <el-tag type="warning" effect="plain">{{ pageRecoveryMissingPages.length }} {{ $t('audit.pages') }}</el-tag>
            </div>
          </div>
          <div class="page-recovery-controls">
            <span class="page-recovery-label">{{ $t('audit.pageRecoverySource') }}</span>
            <el-radio-group v-model="pageRecoverySource" :disabled="pageRecoveryLoading || pageRecoveryApplying">
              <el-radio-button v-if="pageRecoverySourceUrls.current" value="current">{{ $t('audit.currentUrl') }}</el-radio-button>
              <el-radio-button v-if="pageRecoverySourceUrls.ehviewer" value="ehviewer">{{ $t('audit.ehviewerUrl') }}</el-radio-button>
              <el-radio-button v-if="pageRecoverySourceUrls.nhentai" value="nhentai">{{ $t('audit.nhentaiRecoverySource') }}</el-radio-button>
              <el-radio-button v-if="pageRecoverySourceUrls.jmcomic" value="jmcomic">{{ $t('audit.jmcomicRecoverySource') }}</el-radio-button>
            </el-radio-group>
          </div>
          <div class="page-recovery-nhentai-source">
            <el-button
              plain
              :icon="Search"
              :disabled="pageRecoveryLoading || pageRecoveryApplying"
              @click="openNhentaiRecoverySearch"
            >
              {{ $t('audit.searchNhentaiRecoverySource') }}
            </el-button>
            <el-link v-if="pageRecoverySourceUrls.nhentai" type="primary" :underline="false" @click="openExternalUrl(pageRecoverySourceUrls.nhentai)">
              {{ pageRecoverySourceUrls.nhentai }}
            </el-link>
            <span v-if="pageRecoveryNhentaiPageCount" class="page-recovery-source-page-count">
              {{ $t('audit.pages') }}: {{ pageRecoveryNhentaiPageCount }}
            </span>
            <span v-else-if="pageRecoveryNhentaiPageCountLoading" class="page-recovery-source-page-count">
              {{ $t('audit.pages') }}: ...
            </span>
          </div>
          <div class="page-recovery-nhentai-source">
            <el-button
              plain
              :icon="Search"
              :disabled="pageRecoveryLoading || pageRecoveryApplying"
              @click="openJmComicRecoverySearch"
            >
              {{ $t('audit.searchJmComicRecoverySource') }}
            </el-button>
            <el-link v-if="pageRecoverySourceUrls.jmcomic" type="primary" :underline="false" @click="openExternalUrl(pageRecoverySourceUrls.jmcomic)">
              {{ pageRecoverySourceUrls.jmcomic }}
            </el-link>
            <span v-if="pageRecoveryJmComicPageCount" class="page-recovery-source-page-count">
              {{ $t('audit.pages') }}: {{ pageRecoveryJmComicPageCount }}
            </span>
            <span v-else-if="pageRecoveryJmComicPageCountLoading" class="page-recovery-source-page-count">
              {{ $t('audit.pages') }}: ...
            </span>
          </div>
          <div class="page-recovery-offset">
            <el-tooltip :content="$t('audit.pageRecoverySourceOffsetHint')" placement="top">
              <label for="page-recovery-offset" class="page-recovery-label">{{ $t('audit.pageRecoverySourceOffset') }}</label>
            </el-tooltip>
            <el-input-number
              id="page-recovery-offset"
              v-model="pageRecoverySourceOffset"
              :aria-label="$t('audit.pageRecoverySourceOffset')"
              :min="-1000"
              :max="1000"
              :step="1"
              :precision="0"
              :disabled="pageRecoveryLoading || pageRecoveryApplying"
            />
            <div class="page-recovery-offset-mapping">
              <span v-for="pageNumber in pageRecoverySelectedPages.slice(0, 3)" :key="pageNumber">
                {{ $t('audit.pageRecoveryPageMapping', { localPage: pageNumber, sourcePage: pageNumber + (pageRecoverySourceOffset || 0) }) }}
              </span>
            </div>
          </div>
          <div class="page-recovery-pages">
            <span class="page-recovery-label">{{ $t('audit.pageRecoveryMissingPages') }}</span>
            <el-checkbox-group v-model="pageRecoverySelectedPages" :disabled="pageRecoveryLoading || pageRecoveryApplying">
              <el-checkbox v-for="pageNumber in pageRecoveryMissingPages" :key="pageNumber" :label="pageNumber">
                {{ pageNumber }}
                <small v-if="pageRecoveryLeadingPages.includes(pageNumber)" class="page-recovery-inferred">{{ $t('audit.pageRecoveryInferredLeading') }}</small>
                <small v-else-if="pageRecoveryTrailingPages.includes(pageNumber)" class="page-recovery-inferred">{{ $t('audit.pageRecoveryInferredTrailing') }}</small>
              </el-checkbox>
            </el-checkbox-group>
          </div>
          <el-alert v-if="pageRecoverySession?.error" type="error" :closable="false" :title="pageRecoveryErrorMessage(pageRecoverySession.error)" show-icon />
          <el-alert v-if="pageRecoverySession?.unconfirmedBoundaryPages?.length || pageRecoverySession?.unconfirmedLeadingPages?.length" type="warning" :closable="false" :title="$t('audit.pageRecoveryLeadingSkipped', { pages: (pageRecoverySession.unconfirmedBoundaryPages || pageRecoverySession.unconfirmedLeadingPages).join(', ') })" show-icon />
          <el-alert v-if="pageRecoverySession && !pageRecoverySession.writeBackSupported" type="warning" :closable="false" :title="$t('audit.pageRecoveryMappingUncertain')" show-icon />
          <el-alert v-else-if="pageRecoverySession?.mappingConfidence === 'anchored'" type="info" :closable="false" :title="$t('audit.pageRecoveryMappingAnchored')" show-icon />
          <el-button type="primary" :loading="pageRecoveryLoading" :disabled="!pageRecoverySelectedPages.length || pageRecoveryApplying" @click="fetchPageRecovery">
            {{ pageRecoveryLoading ? $t('audit.pageRecoveryFetching') : $t('audit.pageRecoveryFetch') }}
          </el-button>
          <div v-if="pageRecoverySession?.candidates?.length" class="page-recovery-candidates">
            <el-alert v-if="!pageRecoverySessionMatchesSource" type="warning" :closable="false" :title="$t('audit.pageRecoverySourceChanged')" show-icon />
            <div class="page-recovery-candidate-heading">
              <strong>{{ $t('audit.pageRecoveryPreview') }}</strong>
              <el-checkbox v-model="pageRecoverySelectAllCandidates" :disabled="pageRecoveryApplying || pageRecoveryLoading || !pageRecoverySessionMatchesSource">{{ $t('audit.pageRecoverySelectAll') }}</el-checkbox>
            </div>
            <el-checkbox-group v-model="pageRecoverySelectedCandidates" :disabled="pageRecoveryApplying || pageRecoveryLoading || !pageRecoverySessionMatchesSource">
            <div v-for="candidate in pageRecoverySession.candidates" :key="candidate.id" class="page-recovery-candidate">
              <el-checkbox :label="candidate.id" class="page-recovery-candidate-select">
                <span>{{ pageRecoveryCandidatePageLabel(candidate) }} · {{ candidate.targetPath }}</span>
              </el-checkbox>
              <div class="page-recovery-comparison">
                <div class="page-recovery-comparison-heading">
                  <strong>{{ $t('audit.pageRecoveryComparison') }}</strong>
                  <span>{{ $t('audit.pageRecoveryComparisonHint') }}</span>
                </div>
                <div class="page-recovery-comparison-strip">
                  <div class="page-recovery-context" :class="{ 'is-fetched-neighbor': candidate.localContext?.previous?.status === 'fetched' }">
                    <el-image v-if="candidate.localContext?.previous?.previewDataUrl" :src="candidate.localContext.previous.previewDataUrl" fit="contain" class="page-recovery-context-image" :preview-src-list="pageRecoveryPreviewList(candidate)" :initial-index="pageRecoveryPreviewIndex(candidate, 'previous')" />
                    <div v-else class="page-recovery-context-placeholder">{{ candidate.localContext?.previous?.status === 'unreadable' ? $t('audit.pageRecoveryContextUnreadable') : candidate.localContext?.previous?.status === 'boundary' ? $t('audit.pageRecoveryContextBoundary') : $t('audit.pageRecoveryContextMissing', { page: candidate.localContext?.previous?.pageNumber }) }}</div>
                    <strong>{{ candidate.localContext?.previous?.status === 'fetched' ? $t('audit.pageRecoveryFetchedNeighbor', { page: candidate.localContext.previous.pageNumber }) : $t('audit.pageRecoveryLocalPrevious', { page: candidate.localContext?.previous?.pageNumber || candidate.pageNumber - 1 }) }}</strong>
                    <span>{{ candidate.localContext?.previous?.path || '-' }}</span>
                  </div>
                  <div class="page-recovery-context is-target">
                    <el-image :src="candidate.previewDataUrl" fit="contain" class="page-recovery-context-image" :preview-src-list="pageRecoveryPreviewList(candidate)" :initial-index="pageRecoveryPreviewIndex(candidate, 'current')" />
                    <strong>{{ pageRecoveryCandidatePageLabel(candidate) }}</strong>
                    <span>{{ candidate.targetPath }}</span>
                  </div>
                  <div class="page-recovery-context" :class="{ 'is-fetched-neighbor': candidate.localContext?.next?.status === 'fetched' }">
                    <el-image v-if="candidate.localContext?.next?.previewDataUrl" :src="candidate.localContext.next.previewDataUrl" fit="contain" class="page-recovery-context-image" :preview-src-list="pageRecoveryPreviewList(candidate)" :initial-index="pageRecoveryPreviewIndex(candidate, 'next')" />
                    <div v-else class="page-recovery-context-placeholder">{{ candidate.localContext?.next?.status === 'unreadable' ? $t('audit.pageRecoveryContextUnreadable') : candidate.localContext?.next?.status === 'boundary' ? $t('audit.pageRecoveryContextBoundary') : $t('audit.pageRecoveryContextMissing', { page: candidate.localContext?.next?.pageNumber }) }}</div>
                    <strong>{{ candidate.localContext?.next?.status === 'fetched' ? $t('audit.pageRecoveryFetchedNeighbor', { page: candidate.localContext.next.pageNumber }) : $t('audit.pageRecoveryLocalNext', { page: candidate.localContext?.next?.pageNumber || candidate.pageNumber + 1 }) }}</strong>
                    <span>{{ candidate.localContext?.next?.path || '-' }}</span>
                  </div>
                </div>
              </div>
            </div>
            </el-checkbox-group>
            <el-alert v-if="pageRecoverySession.status === 'awaiting-confirmation'" type="info" :closable="false" :title="$t('audit.pageRecoveryAwaitingConfirmation')" show-icon />
            <div class="page-recovery-actions">
              <el-button type="success" :loading="pageRecoveryApplying" :disabled="pageRecoveryLoading || !pageRecoverySessionMatchesSource || pageRecoverySession.status !== 'awaiting-confirmation' || !pageRecoverySelectedCandidates.length" @click="applyPageRecovery">{{ pageRecoverySession.writeBackSupported ? $t('audit.pageRecoveryApply') : $t('audit.pageRecoveryApplyManual') }}</el-button>
              <el-button :disabled="pageRecoveryApplying" @click="cleanupPageRecovery">{{ $t('audit.pageRecoveryCleanup') }}</el-button>
            </div>
          </div>
        </section>
        <pre class="evidence-block">{{ JSON.stringify(selectedAnomaly.evidence || {}, null, 2) }}</pre>
      </template>
    </el-drawer>
    <el-dialog
      v-model="pageRecoveryNhentaiSearchVisible"
      width="60vw"
      :title="$t('audit.nhentaiRecoverySearchTitle')"
      destroy-on-close
      append-to-body
      class="audit-nhentai-search-dialog"
    >
      <el-form :inline="true" class="audit-nhentai-search-form">
        <el-form-item>
          <el-input
            v-model="pageRecoveryNhentaiQuery"
            class="audit-nhentai-search-input"
            :disabled="pageRecoveryNhentaiSearchLoading"
            :placeholder="$t('audit.nhentaiRecoveryQueryPlaceholder')"
            @keyup.enter="searchNhentaiRecovery"
          >
            <template #append>
              <el-select v-model="pageRecoveryNhentaiSearchType" class="audit-nhentai-search-type" disabled>
                <el-option label="nhentai(id/keyword)" value="nhentai" />
              </el-select>
            </template>
          </el-input>
        </el-form-item>
        <el-form-item>
          <el-button
            type="primary"
            plain
            :icon="Search"
            :loading="pageRecoveryNhentaiSearchLoading"
            @click="searchNhentaiRecovery"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" plain :icon="Link" @click="openNhentaiSearchUrl" />
        </el-form-item>
      </el-form>
      <div v-loading="pageRecoveryNhentaiSearchLoading" class="audit-nhentai-search-results">
        <div v-if="pageRecoveryNhentaiCandidates.length">
          <p class="audit-nhentai-search-hint">{{ $t('audit.nhentaiRecoveryCandidates') }}</p>
          <button
            v-for="candidate in pageRecoveryNhentaiCandidates"
            :key="candidate.id"
            type="button"
            class="audit-nhentai-search-result"
            :class="{ 'is-selected': String(candidate.id) === String(pageRecoveryNhentaiSelectedId) }"
            @click="selectNhentaiRecoveryCandidate(candidate)"
          >
            <span>{{ candidate.title || candidate.url }}</span>
            <small>
              #{{ candidate.id }}
              · {{ $t('audit.pages') }}: {{ candidate.pageCountLoading ? '...' : (candidate.pageCount || '-') }}
            </small>
          </button>
        </div>
        <el-empty v-else :description="$t('m.noResults')" :image-size="100" />
      </div>
    </el-dialog>
    <el-dialog
      v-model="pageRecoveryJmComicSearchVisible"
      width="60vw"
      :title="$t('audit.jmcomicRecoverySearchTitle')"
      destroy-on-close
      append-to-body
      class="audit-nhentai-search-dialog"
    >
      <el-form :inline="true" class="audit-nhentai-search-form">
        <el-form-item>
          <el-input
            v-model="pageRecoveryJmComicQuery"
            class="audit-nhentai-search-input"
            :disabled="pageRecoveryJmComicSearchLoading"
            :placeholder="$t('audit.jmcomicRecoveryQueryPlaceholder')"
            @keyup.enter="searchJmComicRecovery"
          >
            <template #append>
              <el-select v-model="pageRecoveryJmComicSearchType" class="audit-nhentai-search-type" disabled>
                <el-option label="禁漫天堂(id/keyword)" value="jmcomic" />
              </el-select>
            </template>
          </el-input>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" plain :icon="Search" :loading="pageRecoveryJmComicSearchLoading" @click="searchJmComicRecovery" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" plain :icon="Link" @click="openJmComicSearchUrl" />
        </el-form-item>
      </el-form>
      <div v-loading="pageRecoveryJmComicSearchLoading" class="audit-nhentai-search-results">
        <div v-if="pageRecoveryJmComicCandidates.length">
          <p class="audit-nhentai-search-hint">{{ $t('audit.jmcomicRecoveryCandidates') }}</p>
          <button
            v-for="candidate in pageRecoveryJmComicCandidates"
            :key="candidate.id"
            type="button"
            class="audit-nhentai-search-result"
            :class="{ 'is-selected': String(candidate.id) === String(pageRecoveryJmComicSelectedId) }"
            @click="selectJmComicRecoveryCandidate(candidate)"
          >
            <span>{{ candidate.title || candidate.url }}</span>
            <small>#{{ candidate.id }} · {{ $t('audit.pages') }}: {{ candidate.pageCountLoading ? '...' : (candidate.pageCount || '-') }}</small>
          </button>
        </div>
        <el-empty v-else :description="$t('m.noResults')" :image-size="100" />
      </div>
    </el-dialog>
  </section>
</template>

<script setup>
import { computed, defineComponent, h, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElIcon, ElMessage, ElMessageBox, ElTag } from 'element-plus'
import { ArrowLeft, ArrowRight, Download, FolderOpened, Link, Picture, Search, Select, TopRight, Upload, VideoPlay } from '@element-plus/icons-vue'
import { buildEhviewerRecoveryPreview } from './ehviewerRecoveryPreview.mjs'
import { getAnomalyNavigation } from './anomalyNavigation.mjs'
import { mergePageRecoveryPageSelection, togglePageRecoverySelection } from './pageRecoverySelection.mjs'

const props = defineProps({
  report: { type: Object, default: null },
  state: { type: Object, required: true },
  busy: Boolean,
  reviewLocked: Boolean,
  actionIds: { type: Array, default: () => [] },
  manualActions: { type: Object, default: () => ({}) },
  reviewSaving: Boolean,
  reviewDirty: Boolean
})
const emit = defineEmits(['start', 'prepare-safe', 'update:actionIds', 'update:manual-actions', 'execute', 'recovery-completed'])
const { t, te } = useI18n()
const searchInput = ref('')
const search = ref('')
const severityFilter = ref('')
const typeFilter = ref('')
const policyFilter = ref('')
const page = ref(1)
const pageSize = ref(50)
const pageSizes = [50, 100, 200, 500]
const severities = ['critical', 'high', 'medium', 'low']
const drawer = ref(false)
const selectedAnomaly = ref(null)
const bookPreview = ref(null)
const previewLoading = ref(false)
const detailOpening = ref(false)
const manualActionLoading = ref(false)
const autoOpenNextAfterSelection = ref(false)
const pageRecoverySession = ref(null)
const pageRecoveryLoading = ref(false)
const pageRecoveryApplying = ref(false)
const pageRecoverySource = ref('current')
const pageRecoverySourceOffset = ref(0)
const pageRecoveryNhentaiQuery = ref('')
const pageRecoveryNhentaiCandidates = ref([])
const pageRecoveryNhentaiSelectedId = ref('')
const pageRecoveryNhentaiSearchLoading = ref(false)
const pageRecoveryNhentaiSearchVisible = ref(false)
const pageRecoveryNhentaiSearchType = ref('nhentai')
const pageRecoveryNhentaiPageCountLoading = ref(false)
const pageRecoveryJmComicQuery = ref('')
const pageRecoveryJmComicCandidates = ref([])
const pageRecoveryJmComicSelectedId = ref('')
const pageRecoveryJmComicSearchLoading = ref(false)
const pageRecoveryJmComicSearchVisible = ref(false)
const pageRecoveryJmComicSearchType = ref('jmcomic')
const pageRecoveryJmComicPageCountLoading = ref(false)
const pageRecoverySelectedPages = ref([])
const pageRecoverySelectedCandidates = ref([])
const pageRecoverySelectedGroupIds = ref([])
const pageRecoveryBatchResults = ref({})
const pageRecoveryBatchLoading = ref(false)
const pageRecoveryBatchApplyLoading = ref(false)
const pageRecoveryBatchCompleted = ref(0)
const pageRecoveryBatchTotal = ref(0)
const pendingRecoveryNavigation = ref(null)
const pageRecoveryTable = ref(null)
let searchTimer
let previewRequest = 0

const running = computed(() => ['running', 'cancelling'].includes(props.state.status))
const lastRunText = computed(() => props.state.completedAt ? t('audit.lastCheckedAt', { time: new Date(props.state.completedAt).toLocaleString() }) : t('audit.neverChecked'))
const anomalyBookCount = computed(() => props.report?.summary?.anomalyBooks ?? new Set((props.report?.anomalies || []).filter(item => item.bookId).map(item => String(item.bookId))).size)
const anomalyAction = item => props.manualActions?.[item?.id]?.type ? props.manualActions[item.id] : item?.action || null
const fallbackPolicy = item => {
  if (item?.action) return 'batch-safe'
  if (['no-action', 'candidate-availability-uncertain', 'current-availability-uncertain', 'no-confirmed-available-candidate'].includes(item?.recommendedAction)) return 'report-only'
  return ['manual-review'].includes(item?.recommendedAction) || ['ehviewer-url-conflict', 'ehviewer-url-conflict-online', 'filename-url-id-conflict', 'unverified-page-mismatch'].includes(item?.type)
    ? 'manual'
    : 'report-only'
}
const effectiveAnomalies = computed(() => (props.report?.anomalies || []).map(item => ({
  ...item,
  action: anomalyAction(item),
  actionPolicy: item.actionPolicy || fallbackPolicy(item)
})))
const batchSafeCount = computed(() => props.report?.summary?.batchSafeAnomalies ?? effectiveAnomalies.value.filter(item => item.actionPolicy === 'batch-safe').length)
const manualReviewCount = computed(() => props.report?.summary?.manualReviewAnomalies ?? effectiveAnomalies.value.filter(item => item.actionPolicy === 'manual').length)
const reportOnlyCount = computed(() => props.report?.summary?.reportOnlyAnomalies ?? effectiveAnomalies.value.filter(item => item.actionPolicy === 'report-only').length)
const manualActionCount = computed(() => effectiveAnomalies.value.filter(item => Object.prototype.hasOwnProperty.call(props.manualActions || {}, item.id) && item.actionPolicy === 'manual').length)
const anomalyTypes = computed(() => [...new Set(effectiveAnomalies.value.map(item => item.type))].sort())
const searchIndex = computed(() => new Map(effectiveAnomalies.value.map(item => [item.id, normalizeSearchText(`${item.type} ${auditTypeLabel(item.type)} ${item.reason} ${item.filepath}`)])))
const filteredAnomalies = computed(() => effectiveAnomalies.value.filter(item =>
  (!severityFilter.value || item.severity === severityFilter.value) &&
  (!typeFilter.value || item.type === typeFilter.value) &&
  (!policyFilter.value || item.actionPolicy === policyFilter.value) &&
  (!search.value || (searchIndex.value.get(item.id) || '').includes(search.value))))
const policyPriority = { 'batch-safe': 0, manual: 1, 'report-only': 2 }
const groupPolicy = items => {
  const policies = [...new Set(items.map(item => item.actionPolicy))]
  if (policies.length === 1) return policies[0]
  return policies.sort((left, right) => (policyPriority[left] ?? 9) - (policyPriority[right] ?? 9))[0] === 'batch-safe'
    ? 'mixed'
    : 'manual'
}
const filteredBookGroups = computed(() => {
  const groups = new Map()
  for (const item of filteredAnomalies.value) {
    const key = String(item.bookId || item.filepath || item.id)
    const group = groups.get(key) || []
    group.push(item)
    groups.set(key, group)
  }
  return [...groups.entries()].map(([key, items]) => {
    const primary = [...items].sort((left, right) => ({ critical: 0, high: 1, medium: 2, low: 3 }[left.severity] ?? 9) - ({ critical: 0, high: 1, medium: 2, low: 3 }[right.severity] ?? 9))[0]
    const typeLabels = [...new Set(items.map(item => auditTypeLabel(item.type)))]
    return {
      id: `book:${key}`,
      primary,
      bookId: primary.bookId,
      filepath: primary.filepath,
      anomalies: items,
      groupPolicy: groupPolicy(items),
      typeSummary: typeLabels.length > 2 ? `${typeLabels.slice(0, 2).join('、')} +${typeLabels.length - 2}` : typeLabels.join('、'),
      reasonSummary: items.length > 1 ? `${items.length} 项异常：${primary.reason}` : primary.reason,
      anomalyCount: items.length
    }
  })
})
const pagedBookGroups = computed(() => filteredBookGroups.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))
const getPageRecoveryAnomaly = group => group?.anomalies?.find(item => item.type === 'archive-image-sequence-gap' && item.bookId) || null
const pageRecoveryBookGroupCount = computed(() => filteredBookGroups.value.filter(group => getPageRecoveryAnomaly(group)).length)
const pageRecoverySelectedGroups = computed(() => filteredBookGroups.value.filter(group => pageRecoverySelectedGroupIds.value.includes(group.id) && getPageRecoveryAnomaly(group)))
const pageRecoveryBatchReadyGroups = computed(() => pageRecoverySelectedGroups.value.filter(group => {
  const result = pageRecoveryBatchResults.value[group.id]
  return result?.status === 'awaiting-confirmation' && result.batchWriteBackSupported !== false
}))
const isPageRecoverySelectable = row => !pageRecoveryBatchLoading.value && !pageRecoveryBatchApplyLoading.value && Boolean(getPageRecoveryAnomaly(row))
const pageRecoveryBatchStatusLabel = group => {
  const status = pageRecoveryBatchResults.value[group.id]?.status
  if (status === 'awaiting-confirmation') return t('audit.pageRecoveryBatchReady')
  if (status === 'completed') return t('audit.pageRecoveryBatchCompleted')
  if (status === 'skipped') return t('audit.pageRecoveryBatchSkipped')
  if (status === 'failed') return t('audit.pageRecoveryBatchFailed')
  return '-'
}
const pageRecoveryBatchStatusType = group => {
  const status = pageRecoveryBatchResults.value[group.id]?.status
  return status === 'failed' ? 'danger' : status === 'awaiting-confirmation' ? 'info' : status === 'skipped' ? 'warning' : 'success'
}
const getPageRecoveryGroupId = anomaly => `book:${String(anomaly?.bookId || anomaly?.filepath || anomaly?.id || '')}`
let pageRecoveryCacheLoadToken = 0
const restorePageRecoveryCacheStatuses = async reportId => {
  const token = ++pageRecoveryCacheLoadToken
  const anomalies = (props.report?.anomalies || []).filter(item => item.type === 'archive-image-sequence-gap' && item.bookId)
  if (!reportId || !anomalies.length || typeof window.auditApi.pageRecovery.listLatest !== 'function') return
  try {
    const summaries = await window.auditApi.pageRecovery.listLatest({
      reportId,
      anomalyIds: anomalies.map(item => item.id)
    })
    if (token !== pageRecoveryCacheLoadToken) return
    const anomalyById = new Map(anomalies.map(item => [String(item.id), item]))
    const restored = { ...pageRecoveryBatchResults.value }
    for (const summary of summaries || []) {
      const anomaly = anomalyById.get(String(summary.anomalyId))
      if (!anomaly) continue
      restored[getPageRecoveryGroupId(anomaly)] = {
        status: summary.status === 'failed' ? 'failed' : 'awaiting-confirmation',
        error: summary.error || null,
        recoveryId: summary.recoveryId,
        candidateCount: summary.candidateCount,
        selectedPages: summary.selectedPages,
        batchWriteBackSupported: summary.batchWriteBackSupported,
        batchWriteBackReason: summary.batchWriteBackReason
      }
    }
    pageRecoveryBatchResults.value = restored
  } catch (error) {
    console.debug('Restore page recovery cache statuses failed', error)
  }
}
const filterScopeLabel = computed(() => typeFilter.value ? auditTypeLabel(typeFilter.value) : policyFilter.value ? policyLabel(policyFilter.value) : search.value || severityFilter.value ? t('audit.currentFilter') : t('audit.allAnomalies'))
const filteredBookIds = computed(() => [...new Set(filteredAnomalies.value.map(item => item.bookId).filter(Boolean).map(String))])
const currentEvidenceUrl = computed(() => selectedAnomaly.value?.evidence?.currentUrl || selectedAnomaly.value?.evidence?.url || '')
const ehviewerEvidenceUrl = computed(() => {
  if (selectedAnomaly.value?.evidence?.ehviewerUrl) return String(selectedAnomaly.value.evidence.ehviewerUrl)
  const value = selectedAnomaly.value?.evidence?.ehviewer
  return value?.gid && value?.token ? `https://exhentai.org/g/${value.gid}/${value.token}/` : ''
})
const currentAvailability = computed(() => selectedAnomaly.value?.evidence?.currentAvailability || null)
const ehviewerAvailability = computed(() => selectedAnomaly.value?.evidence?.ehviewerAvailability || null)
const pageSourceEvidence = computed(() => selectedAnomaly.value?.evidence?.pageSources || null)
const pageRecoveryAnomaly = computed(() => selectedAnomaly.value?.type === 'archive-image-sequence-gap'
  ? selectedAnomaly.value
  : getPageRecoveryAnomaly({ anomalies: selectedAnomaly.value?.siblings || [] }))
const getPageRecoverySourceUrls = (anomaly, fallbackUrl = null) => {
  const evidence = anomaly?.evidence || {}
  const ehviewer = evidence.ehviewerUrl || (evidence.ehviewer?.gid && evidence.ehviewer?.token ? `https://exhentai.org/g/${evidence.ehviewer.gid}/${evidence.ehviewer.token}/` : '')
  return { current: String(evidence.currentUrl || evidence.url || fallbackUrl || '').trim() || null, ehviewer: String(ehviewer || '').trim() || null, nhentai: String(evidence.nhentaiUrl || '').trim() || null }
}
const pageRecoverySelectedNhentaiCandidate = computed(() => pageRecoveryNhentaiCandidates.value.find(item => String(item.id) === String(pageRecoveryNhentaiSelectedId.value)) || null)
const pageRecoveryNhentaiPageCount = computed(() => {
  const values = [
    pageRecoverySelectedNhentaiCandidate.value?.pageCount,
    pageRecoverySession.value?.source?.type === 'nhentai' ? pageRecoverySession.value?.online?.pageCount : null
  ]
  const value = values
    .map(item => Number(item))
    .find(item => Number.isSafeInteger(item) && item > 0)
  return value === undefined ? null : value
})
const pageRecoveryNhentaiUrl = computed(() => {
  if (pageRecoverySelectedNhentaiCandidate.value?.url) return pageRecoverySelectedNhentaiCandidate.value.url
  const configured = getPageRecoverySourceUrls(pageRecoveryAnomaly.value, bookPreview.value?.url).nhentai
  if (configured) return configured
  const candidates = [pageRecoveryAnomaly.value?.evidence?.currentUrl, pageRecoveryAnomaly.value?.evidence?.url, bookPreview.value?.url]
  return candidates.find(value => /nhentai\.net\/g\/\d+/i.test(String(value || ''))) || null
})
const pageRecoveryNhentaiSearchUrl = computed(() => `https://nhentai.net/search/?q=${encodeURIComponent(pageRecoveryNhentaiQuery.value.trim() || bookTitle.value || '')}`)
const pageRecoverySelectedJmComicCandidate = computed(() => pageRecoveryJmComicCandidates.value.find(item => String(item.id) === String(pageRecoveryJmComicSelectedId.value)) || null)
const pageRecoveryJmComicPageCount = computed(() => {
  const values = [
    pageRecoverySelectedJmComicCandidate.value?.pageCount,
    pageRecoverySession.value?.source?.type === 'jmcomic' ? pageRecoverySession.value?.online?.pageCount : null
  ]
  const value = values.map(item => Number(item)).find(item => Number.isSafeInteger(item) && item > 0)
  return value === undefined ? null : value
})
const pageRecoveryJmComicUrl = computed(() => {
  if (pageRecoverySelectedJmComicCandidate.value?.url) return pageRecoverySelectedJmComicCandidate.value.url
  const evidence = pageRecoveryAnomaly.value?.evidence || {}
  const candidates = [evidence.jmcomicUrl, evidence.currentUrl, evidence.url, bookPreview.value?.url]
  return candidates.find(value => /\/(?:album|photo)\/\d+/i.test(String(value || '')) && /(?:18comic|jmcomic|jm365|jm[-.]?comic)/i.test(String(value || ''))) || null
})
const pageRecoverySourceUrls = computed(() => ({
  ...getPageRecoverySourceUrls(pageRecoveryAnomaly.value, bookPreview.value?.url),
  nhentai: pageRecoveryNhentaiUrl.value,
  jmcomic: pageRecoveryJmComicUrl.value
}))
const pageRecoverySessionMatchesSource = computed(() => Boolean(pageRecoverySession.value) &&
  Number(pageRecoverySession.value.sourceOffset ?? 0) === Number(pageRecoverySourceOffset.value ?? 0) &&
  pageRecoverySession.value.source?.url === pageRecoverySourceUrls.value[pageRecoverySource.value])
const pageRecoveryCandidatePageLabel = candidate => t('audit.pageRecoveryPageMapping', {
  localPage: candidate.pageNumber,
  sourcePage: candidate.sourcePageNumber ?? candidate.pageNumber + Number(pageRecoverySession.value?.sourceOffset || 0)
})
const pageRecoveryErrorMessage = error => {
  const message = String(error?.message || error || '')
  if (message.includes('PAGE_RECOVERY_SOURCE_OFFSET_INVALID')) return t('audit.pageRecoverySourceOffsetInvalid')
  const sourcePageError = message.match(/PAGE_RECOVERY_SOURCE_PAGE_(?:INVALID|UNAVAILABLE):(\d+):(-?\d+)$/)
  if (sourcePageError) return t('audit.pageRecoverySourcePageUnavailable', { localPage: sourcePageError[1], sourcePage: sourcePageError[2] })
  const unavailable = message.match(/^PAGE_RECOVERY_PAGE_UNAVAILABLE:([^:]+):(\d+)$/)
  if (unavailable) {
    return t('audit.pageRecoveryPageUnavailable', {
      pages: unavailable[1].replace(/,/g, ', '),
      available: unavailable[2]
    })
  }
  if (message === 'PAGE_RECOVERY_PAGE_MANIFEST_INCOMPLETE') return t('audit.pageRecoveryPageManifestIncomplete')
  if (message === 'PAGE_RECOVERY_BOUNDARY_PAGE_UNCONFIRMED') return t('audit.pageRecoveryBoundaryUnconfirmed')
  if (message === 'PAGE_RECOVERY_BATCH_TRAILING_UNCONFIRMED') return t('audit.pageRecoveryBatchTrailingNeedsReview')
  if (message === 'PAGE_RECOVERY_BATCH_MAPPING_UNCERTAIN') return t('audit.pageRecoveryMappingUncertain')
  if (message === 'PAGE_RECOVERY_REPORT_INVALID' || message === 'PAGE_RECOVERY_REVIEW_MISMATCH') return t('audit.pageRecoveryReportStale')
  if (message === 'NHENTAI_API_KEY_MISSING') return t('c.nhentaiMissingApiKey')
  if (message === 'NHENTAI_GALLERY_ID_MISSING' || message === 'NHENTAI_PAGE_MANIFEST_INCOMPLETE') return t('audit.nhentaiRecoveryManifestIncomplete')
  if (message === 'JMCOMIC_ALBUM_ID_MISSING' || message === 'JMCOMIC_PAGE_MANIFEST_INCOMPLETE') return t('audit.jmcomicRecoveryManifestIncomplete')
  if (message === 'JMCOMIC_BROWSER_CHALLENGE') return t('audit.jmcomicRecoveryBrowserChallenge')
  return message
}
const pageRecoveryPreviewEntries = candidate => [
  { role: 'previous', src: candidate?.localContext?.previous?.previewDataUrl },
  { role: 'current', src: candidate?.previewDataUrl },
  { role: 'next', src: candidate?.localContext?.next?.previewDataUrl }
].filter(item => item.src)
const pageRecoveryPreviewList = candidate => pageRecoveryPreviewEntries(candidate).map(item => item.src)
const pageRecoveryPreviewIndex = (candidate, role) => {
  const entries = pageRecoveryPreviewEntries(candidate)
  const index = entries.findIndex(item => item.role === role)
  return index >= 0 ? index : 0
}
const getPageRecoveryInferredPages = evidence => {
  const pages = []
  for (const group of evidence?.imageSequence?.gaps || []) {
    const leadingCount = Number.isSafeInteger(group.first) && group.first > 1 ? group.first - 1 : 0
    if (leadingCount <= 0 || leadingCount > 200) continue
    for (let page = 1; page <= leadingCount; page += 1) pages.push(page)
  }
  return [...new Set(pages)]
}
const getPageRecoveryMissingPages = evidence => [...new Set([
  ...(evidence?.imageSequence?.gaps || []).flatMap(group => group.missingNumbers || []),
  ...getPageRecoveryInferredPages(evidence),
  ...(evidence?.pendingPageRecovery?.remainingMissingPages || [])
])].sort((a, b) => a - b)
const pageRecoveryMissingPages = computed(() => {
  const cachedPages = pageRecoverySession.value?.availablePages
  return Array.isArray(cachedPages) && cachedPages.length
    ? cachedPages
    : getPageRecoveryMissingPages(pageRecoveryAnomaly.value?.evidence)
})
const pageRecoveryLeadingPages = computed(() => [
  ...new Set([
    ...getPageRecoveryInferredPages(pageRecoveryAnomaly.value?.evidence),
    ...(pageRecoverySession.value?.leadingPages || [])
  ])
])
const pageRecoveryTrailingPages = computed(() => pageRecoverySession.value?.trailingPages || [])
const pageRecoverySupported = computed(() => Boolean(pageRecoveryAnomaly.value?.bookId) && pageRecoveryMissingPages.value.length > 0)
const pageRecoveryLocalPageCount = computed(() => {
  const value = pageRecoverySession.value?.local?.pageCount ?? pageRecoveryAnomaly.value?.evidence?.pageCount
  return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null
})
const pageRecoverySourcePageCount = computed(() => {
  const values = [
    pageRecoverySource.value === 'nhentai' ? pageRecoveryNhentaiPageCount.value : null,
    pageRecoverySource.value === 'jmcomic' ? pageRecoveryJmComicPageCount.value : null,
    bookPreview.value?.filecount,
    pageRecoveryAnomaly.value?.evidence?.remotePages,
    pageRecoveryAnomaly.value?.evidence?.pageSources?.currentUrl?.pages
  ]
  const value = values
    .map(item => Number(item))
    .find(item => Number.isSafeInteger(item) && item > 0)
  return value === undefined ? null : value
})
const pageRecoveryPageCountText = computed(() => `${pageRecoveryLocalPageCount.value ?? '-'} | ${pageRecoverySourcePageCount.value ?? '-'}`)
const manualCandidateUrls = computed(() => ({
  current: String(selectedAnomaly.value?.evidence?.currentUrl || selectedAnomaly.value?.evidence?.url || '').trim() || null,
  ehviewer: ehviewerEvidenceUrl.value || null
}))
const manualSourceSelectionSupported = computed(() => ['unverified-page-mismatch', 'ehviewer-url-conflict-online', 'filename-url-id-conflict'].includes(selectedAnomaly.value?.type) &&
  Boolean(manualCandidateUrls.value.current || manualCandidateUrls.value.ehviewer))
const manualSourceForSelected = computed(() => selectedAnomaly.value?.action?.source || '')
const anomalyNavigation = computed(() => getAnomalyNavigation(filteredAnomalies.value, selectedAnomaly.value?.id))
const selectedAnomalyPosition = computed(() => anomalyNavigation.value.position)
const previousAnomaly = computed(() => anomalyNavigation.value.previous)
const nextAnomaly = computed(() => anomalyNavigation.value.next)
const bookTitle = computed(() => bookPreview.value?.title_jpn || bookPreview.value?.title || '')
const ehviewerRecoveryPreview = computed(() => buildEhviewerRecoveryPreview({
  url: bookPreview.value?.url || currentEvidenceUrl.value,
  title: bookTitle.value
}))
const availabilityLabel = value => {
  if (!value) return t('audit.availability_unchecked')
  const key = `audit.availability_${value.status}`
  const label = te(key) ? t(key) : value.status
  return value.claimant ? `${label}: ${value.claimant}` : value.region ? `${label}: ${value.region}` : label
}
const availabilityTagType = status => ({ available: 'success', copyright: 'danger', 'generic-unavailable': 'danger', 'gallery-not-found': 'danger', 'geo-blocked': 'warning', 'auth-required': 'warning', 'ip-banned': 'warning', 'service-unavailable': 'warning', 'network-error': 'info', unchecked: 'info', unknown: 'info' })[status] || 'info'
const AvailabilityList = defineComponent({
  props: { value: Object },
  setup(componentProps) {
    return () => h('span', { class: 'availability-list' }, ['ehentai', 'exhentai'].map(site => h('span', { class: 'availability-item' }, [
      h('strong', site === 'exhentai' ? 'ExHentai' : 'E-Hentai'),
      h(ElTag, { type: availabilityTagType(componentProps.value?.sites?.[site]?.status), effect: 'plain' }, () => availabilityLabel(componentProps.value?.sites?.[site]))
    ])))
  }
})

const normalizeSearchText = value => String(value || '').trim().toLocaleLowerCase()
const auditTypeLabel = value => { const key = `audit.type_${value}`; return value && te(key) ? t(key) : value || '' }
const recommendationLabel = value => {
  const key = `audit.recommendation_${value}`
  return value && te(key) ? t(key) : value || ''
}
const policyLabel = value => {
  const key = `audit.policy_${value}`
  return value && te(key) ? t(key) : value || ''
}
const policyTagType = value => ({ 'batch-safe': 'success', manual: 'warning', 'report-only': 'info', mixed: 'warning' })[value] || 'info'
const severityTag = severity => ({ critical: 'danger', high: 'danger', medium: 'warning', low: 'info' })[severity] || 'info'
const start = () => emit('start', { workflow: 'standard', onlinePolicy: 'conflicts', forceLocal: false, forceOnline: false })
const formatPageCount = source => source?.pages === null || source?.pages === undefined ? '-' : `${source.pages}P`
const formatPageStatus = source => {
  if (!source?.status) return '-'
  const key = `audit.availability_${source.status}`
  return te(key) ? t(key) : source.status
}
const locate = filepath => filepath && window.auditApi.showFile(filepath)
const openExternalUrl = url => url && window.auditApi.openUrl(url)
const getGroupAnomalies = row => {
  const key = String(row?.bookId || row?.filepath || row?.id)
  return filteredBookGroups.value.find(group => group.id === `book:${key}`)?.anomalies || [row]
}
const handlePageRecoverySelect = (selection, row) => {
  pageRecoverySelectedGroupIds.value = togglePageRecoverySelection(
    pageRecoverySelectedGroupIds.value,
    row.id,
    selection.some(item => item.id === row.id)
  )
}
const handlePageRecoverySelectAll = selection => {
  const visibleIds = pagedBookGroups.value
    .filter(isPageRecoverySelectable)
    .map(group => group.id)
  pageRecoverySelectedGroupIds.value = mergePageRecoveryPageSelection(
    pageRecoverySelectedGroupIds.value,
    visibleIds,
    selection.map(group => group.id)
  )
}
const handleAuditRowClick = (row, _column, event) => {
  if (event?.target?.closest('.el-checkbox, .el-table-column--selection')) return
  openAnomaly(row.primary, row.anomalies)
}
const clearPageRecoverySelection = () => {
  pageRecoverySelectedGroupIds.value = []
  pageRecoveryTable.value?.clearSelection()
}
const syncPageRecoveryTableSelection = async () => {
  await nextTick()
  const table = pageRecoveryTable.value
  if (!table) return
  const selectedIds = new Set(pageRecoverySelectedGroupIds.value)
  for (const group of pagedBookGroups.value) {
    table.toggleRowSelection(group, selectedIds.has(group.id))
  }
}
const getPageRecoverySiteStatus = (url, availability) => {
  if (!url || !availability?.sites) return null
  try {
    const site = new URL(url).hostname.toLowerCase().includes('exhentai') ? 'exhentai' : 'ehentai'
    return availability.sites[site]?.status || null
  } catch {
    return null
  }
}
const pageRecoverySourceOrder = anomaly => {
  const urls = getPageRecoverySourceUrls(anomaly)
  const currentStatus = getPageRecoverySiteStatus(urls.current, anomaly?.evidence?.currentAvailability)
  const unavailable = new Set(['copyright', 'generic-unavailable', 'gallery-not-found', 'geo-blocked', 'auth-required', 'ip-banned'])
  if (urls.current && (!currentStatus || !unavailable.has(currentStatus))) return ['current', 'ehviewer'].filter(source => urls[source])
  if (urls.ehviewer) return ['ehviewer', 'current'].filter(source => urls[source])
  return urls.current ? ['current'] : []
}
const fetchPageRecoveryBatchItem = async group => {
  const anomaly = getPageRecoveryAnomaly(group)
  if (!anomaly) throw new Error('PAGE_RECOVERY_ANOMALY_INVALID')
  const pageNumbers = getPageRecoveryMissingPages(anomaly.evidence)
  if (!pageNumbers.length) throw new Error('PAGE_RECOVERY_PAGE_SELECTION_EMPTY')
  const cached = await window.auditApi.pageRecovery.getLatest({
    reportId: props.report?.reportId,
    anomalyId: anomaly.id
  })
  const cachedPages = new Set(cached?.candidates?.filter(item => item.status === 'downloaded').map(item => item.pageNumber) || cached?.candidatePages || [])
  const boundaryPages = [
    ...(cached?.leadingPages || []),
    ...(cached?.trailingPages || [])
  ]
  const requiredPages = [...new Set([...pageNumbers, ...boundaryPages])]
  if (cached?.status === 'awaiting-confirmation' && requiredPages.length > 0 && requiredPages.every(page => cachedPages.has(page))) {
    return { status: 'awaiting-confirmation', session: cached }
  }
  const sources = pageRecoverySourceOrder(anomaly)
  if (!sources.length) throw new Error('PAGE_RECOVERY_SOURCE_MISSING')
  let lastError = null
  for (const source of sources) {
    try {
      const session = await window.auditApi.pageRecovery.fetch({
        reportId: props.report?.reportId,
        anomalyId: anomaly.id,
        source,
        pageNumbers,
        includeBoundaryPages: true
      })
      return { status: session.status, session }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('PAGE_RECOVERY_SOURCE_UNAVAILABLE')
}
const batchFetchPageRecovery = async () => {
  if (pageRecoveryBatchLoading.value || !pageRecoverySelectedGroups.value.length) return
  const groups = [...pageRecoverySelectedGroups.value]
  pageRecoveryBatchLoading.value = true
  pageRecoveryBatchCompleted.value = 0
  pageRecoveryBatchTotal.value = groups.length
  const results = { ...pageRecoveryBatchResults.value }
  let readyCount = 0
  let failedCount = 0
  for (const group of groups) {
    try {
      const result = await fetchPageRecoveryBatchItem(group)
      results[group.id] = {
        status: result.status,
        error: result.session?.error || null,
        batchWriteBackSupported: result.session?.batchWriteBackSupported
      }
      readyCount += 1
    } catch (error) {
      results[group.id] = { status: 'failed', error: pageRecoveryErrorMessage(error) }
      failedCount += 1
    }
    pageRecoveryBatchCompleted.value += 1
    pageRecoveryBatchResults.value = { ...results }
  }
  pageRecoveryBatchLoading.value = false
  if (failedCount) ElMessage.warning(t('audit.pageRecoveryBatchFinishedWithErrors', { ready: readyCount, failed: failedCount }))
  else ElMessage.success(t('audit.pageRecoveryBatchFinished', { count: readyCount }))
}
const batchApplyPageRecovery = async () => {
  if (pageRecoveryBatchApplyLoading.value || !pageRecoveryBatchReadyGroups.value.length) return
  const groups = [...pageRecoveryBatchReadyGroups.value]
  try {
    await ElMessageBox.confirm(
      t('audit.pageRecoveryBatchConfirm', { count: groups.length }),
      t('audit.pageRecoveryTitle'),
      { type: 'warning', confirmButtonText: t('audit.pageRecoveryBatchApplyConfirm') }
    )
  } catch {
    return
  }
  pageRecoveryBatchApplyLoading.value = true
  try {
    const result = await window.auditApi.pageRecovery.applyBatch({
      reportId: props.report?.reportId,
      anomalyIds: groups.map(group => getPageRecoveryAnomaly(group).id)
    })
    const resultByAnomalyId = new Map((result.results || []).map(item => [String(item.anomalyId), item]))
    const nextResults = { ...pageRecoveryBatchResults.value }
    for (const group of groups) {
      const item = resultByAnomalyId.get(String(getPageRecoveryAnomaly(group).id))
      if (!item) continue
      nextResults[group.id] = {
        status: item.status === 'completed' ? 'completed' : item.status === 'awaiting-confirmation' ? 'awaiting-confirmation' : item.status === 'failed' ? 'failed' : 'skipped',
        error: item.reason ? pageRecoveryErrorMessage(item.reason) : null,
        recoveryId: item.recoveryId || null,
        batchWriteBackSupported: item.status === 'awaiting-confirmation' ? false : undefined,
        remainingMissingPages: item.remainingMissingPages || []
      }
    }
    pageRecoveryBatchResults.value = nextResults
    if (result.failedCount || result.skippedCount || result.awaitingCount) {
      ElMessage.warning(t('audit.pageRecoveryBatchApplyFinishedWithErrors', {
        completed: result.completedCount || 0,
        awaiting: result.awaitingCount || 0,
        skipped: result.skippedCount || 0,
        failed: result.failedCount || 0
      }))
    } else {
      ElMessage.success(t('audit.pageRecoveryBatchApplyFinished', { count: result.completedCount || 0 }))
    }
    if (result.appliedCount) emit('recovery-completed')
  } catch (error) {
    ElMessage.error(pageRecoveryErrorMessage(error))
  } finally {
    pageRecoveryBatchApplyLoading.value = false
  }
}
const searchNhentaiRecovery = async () => {
  if (pageRecoveryNhentaiSearchLoading.value) return
  const requestId = ++nhentaiSearchRequest
  pageRecoveryNhentaiSearchLoading.value = true
  try {
    const query = pageRecoveryNhentaiQuery.value.trim() || bookTitle.value || selectedAnomaly.value?.reason || ''
    const results = await window.auditApi.pageRecovery.searchNhentai({
      title: query,
      filepath: selectedAnomaly.value?.filepath || ''
    })
    if (requestId !== nhentaiSearchRequest) return
    const candidates = (Array.isArray(results) ? results : []).map(candidate => ({
      ...candidate,
      pageCountLoading: !hasNhentaiPageCount(candidate.pageCount)
    }))
    pageRecoveryNhentaiCandidates.value = candidates
    pageRecoveryNhentaiSelectedId.value = ''
    pageRecoverySource.value = 'current'
    if (!candidates.length) {
      ElMessage.warning(t('audit.nhentaiRecoveryNoResults'))
      return
    }
    void loadNhentaiSearchPageCounts(candidates, requestId)
  } catch (error) {
    ElMessage.error(pageRecoveryErrorMessage(error))
  } finally {
    pageRecoveryNhentaiSearchLoading.value = false
  }
}
const openNhentaiRecoverySearch = () => {
  if (pageRecoveryLoading.value || pageRecoveryApplying.value) return
  if (!pageRecoveryNhentaiQuery.value.trim()) pageRecoveryNhentaiQuery.value = bookTitle.value || selectedAnomaly.value?.reason || ''
  pageRecoveryNhentaiCandidates.value = []
  pageRecoveryNhentaiSelectedId.value = ''
  pageRecoveryNhentaiSearchVisible.value = true
  void searchNhentaiRecovery()
}
const openNhentaiSearchUrl = () => openExternalUrl(pageRecoveryNhentaiSearchUrl.value)
const selectNhentaiRecoveryCandidate = async candidate => {
  if (!candidate?.id) return
  pageRecoveryNhentaiSelectedId.value = String(candidate.id)
  pageRecoverySource.value = 'nhentai'
  pageRecoveryNhentaiSearchVisible.value = false
  if (Number.isSafeInteger(Number(candidate.pageCount)) && Number(candidate.pageCount) > 0) return
  pageRecoveryNhentaiPageCountLoading.value = true
  try {
    const result = await window.auditApi.pageRecovery.getNhentaiPageCount({ id: candidate.id })
    const index = pageRecoveryNhentaiCandidates.value.findIndex(item => String(item.id) === String(candidate.id))
    if (index >= 0) {
      pageRecoveryNhentaiCandidates.value[index] = {
        ...pageRecoveryNhentaiCandidates.value[index],
        pageCount: result?.pageCount || null,
        pageCountLoading: false
      }
    }
  } catch (error) {
    ElMessage.error(pageRecoveryErrorMessage(error))
  } finally {
    pageRecoveryNhentaiPageCountLoading.value = false
  }
}
let nhentaiSearchRequest = 0
const hasNhentaiPageCount = value => Number.isSafeInteger(Number(value)) && Number(value) > 0
const loadNhentaiSearchPageCounts = async (candidates, requestId) => {
  for (const candidate of candidates) {
    if (requestId !== nhentaiSearchRequest) return
    if (hasNhentaiPageCount(candidate.pageCount)) continue
    let pageCount = null
    try {
      const result = await window.auditApi.pageRecovery.getNhentaiPageCount({ id: candidate.id })
      pageCount = result?.pageCount || null
    } catch (error) {
      console.debug('Load nHentai search result page count failed', error)
    }
    if (requestId !== nhentaiSearchRequest) return
    const index = pageRecoveryNhentaiCandidates.value.findIndex(item => String(item.id) === String(candidate.id))
    if (index < 0) continue
    const next = [...pageRecoveryNhentaiCandidates.value]
    next[index] = { ...next[index], pageCount, pageCountLoading: false }
    pageRecoveryNhentaiCandidates.value = next
  }
}
const searchJmComicRecovery = async () => {
  if (pageRecoveryJmComicSearchLoading.value) return
  const requestId = ++jmComicSearchRequest
  pageRecoveryJmComicSearchLoading.value = true
  try {
    const query = pageRecoveryJmComicQuery.value.trim() || bookTitle.value || selectedAnomaly.value?.reason || ''
    const results = await window.auditApi.pageRecovery.searchJmComic({
      title: query,
      filepath: selectedAnomaly.value?.filepath || ''
    })
    if (requestId !== jmComicSearchRequest) return
    const candidates = (Array.isArray(results) ? results : []).map(candidate => ({
      ...candidate,
      pageCountLoading: !hasJmComicPageCount(candidate.pageCount)
    }))
    pageRecoveryJmComicCandidates.value = candidates
    pageRecoveryJmComicSelectedId.value = ''
    if (!candidates.length) {
      ElMessage.warning(t('audit.jmcomicRecoveryNoResults'))
      return
    }
    void loadJmComicSearchPageCounts(candidates, requestId)
  } catch (error) {
    ElMessage.error(pageRecoveryErrorMessage(error))
  } finally {
    pageRecoveryJmComicSearchLoading.value = false
  }
}
const openJmComicRecoverySearch = () => {
  if (pageRecoveryLoading.value || pageRecoveryApplying.value) return
  if (!pageRecoveryJmComicQuery.value.trim()) pageRecoveryJmComicQuery.value = bookTitle.value || selectedAnomaly.value?.reason || ''
  pageRecoveryJmComicCandidates.value = []
  pageRecoveryJmComicSelectedId.value = ''
  pageRecoveryJmComicSearchVisible.value = true
  void searchJmComicRecovery()
}
const openJmComicSearchUrl = () => openExternalUrl(`https://18comic.vip/search/photos?search_query=${encodeURIComponent(pageRecoveryJmComicQuery.value.trim() || bookTitle.value || '')}`)
const selectJmComicRecoveryCandidate = async candidate => {
  if (!candidate?.id) return
  pageRecoveryJmComicSelectedId.value = String(candidate.id)
  pageRecoverySource.value = 'jmcomic'
  pageRecoveryJmComicSearchVisible.value = false
  if (hasJmComicPageCount(candidate.pageCount)) return
  pageRecoveryJmComicPageCountLoading.value = true
  try {
    const result = await window.auditApi.pageRecovery.getJmComicPageCount({ id: candidate.id, url: candidate.url })
    const index = pageRecoveryJmComicCandidates.value.findIndex(item => String(item.id) === String(candidate.id))
    if (index >= 0) {
      const next = [...pageRecoveryJmComicCandidates.value]
      next[index] = { ...next[index], title: result?.title || next[index].title, url: result?.url || next[index].url, pageCount: result?.pageCount || null, pageCountLoading: false }
      pageRecoveryJmComicCandidates.value = next
    }
  } catch (error) {
    ElMessage.error(pageRecoveryErrorMessage(error))
  } finally {
    pageRecoveryJmComicPageCountLoading.value = false
  }
}
let jmComicSearchRequest = 0
const hasJmComicPageCount = value => Number.isSafeInteger(Number(value)) && Number(value) > 0
const loadJmComicSearchPageCounts = async (candidates, requestId) => {
  for (const candidate of candidates) {
    if (requestId !== jmComicSearchRequest) return
    if (hasJmComicPageCount(candidate.pageCount)) continue
    let pageCount = null
    let title = candidate.title
    let url = candidate.url
    try {
      const result = await window.auditApi.pageRecovery.getJmComicPageCount({ id: candidate.id, url: candidate.url })
      pageCount = result?.pageCount || null
      title = result?.title || title
      url = result?.url || url
    } catch (error) {
      console.debug('Load JMComic search result page count failed', error)
    }
    if (requestId !== jmComicSearchRequest) return
    const index = pageRecoveryJmComicCandidates.value.findIndex(item => String(item.id) === String(candidate.id))
    if (index < 0) continue
    const next = [...pageRecoveryJmComicCandidates.value]
    next[index] = { ...next[index], title, url, pageCount, pageCountLoading: false }
    pageRecoveryJmComicCandidates.value = next
  }
}
const openAnomaly = async (row, siblings = null) => {
  const requestId = ++previewRequest
  selectedAnomaly.value = { ...row, siblings: siblings?.length ? siblings : getGroupAnomalies(row) }
  bookPreview.value = null
  pageRecoverySession.value = null
  pageRecoverySourceOffset.value = 0
  pageRecoverySelectedCandidates.value = []
  pageRecoveryNhentaiQuery.value = ''
  pageRecoveryNhentaiCandidates.value = []
  pageRecoveryNhentaiSelectedId.value = ''
  pageRecoveryNhentaiSearchVisible.value = false
  nhentaiSearchRequest += 1
  pageRecoveryNhentaiPageCountLoading.value = false
  pageRecoveryJmComicQuery.value = ''
  pageRecoveryJmComicCandidates.value = []
  pageRecoveryJmComicSelectedId.value = ''
  pageRecoveryJmComicSearchVisible.value = false
  jmComicSearchRequest += 1
  pageRecoveryJmComicPageCountLoading.value = false
  const recoveryRow = row.type === 'archive-image-sequence-gap' ? row : (siblings || []).find(item => item.type === 'archive-image-sequence-gap')
  pageRecoverySelectedPages.value = [...pageRecoveryMissingPages.value]
  pageRecoverySource.value = 'current'
  drawer.value = true
  if (!row.bookId) return
  const recoveryPromise = recoveryRow?.id
    ? window.auditApi.pageRecovery.getLatest({
        reportId: props.report?.reportId,
        anomalyId: recoveryRow.id
      }).then(value => ({ value })).catch(error => ({ error }))
    : Promise.resolve({ value: null })
  previewLoading.value = true
  try {
    const preview = await window.auditApi.getBookPreview(row.bookId)
    if (requestId === previewRequest) {
      bookPreview.value = preview
      pageRecoveryNhentaiQuery.value = preview?.searchTitle || preview?.title_jpn || preview?.title || ''
      pageRecoveryJmComicQuery.value = pageRecoveryNhentaiQuery.value
    }
  } finally {
    if (requestId === previewRequest) previewLoading.value = false
  }
  if (!recoveryRow?.id) return
  try {
    const recoveryResult = await recoveryPromise
    if (recoveryResult.error) throw recoveryResult.error
    const cachedSession = recoveryResult.value
    if (requestId !== previewRequest || !cachedSession) return
    pageRecoverySession.value = cachedSession
    pageRecoverySelectedCandidates.value = []
    pageRecoverySelectedPages.value = [...(cachedSession.availablePages || pageRecoveryMissingPages.value)]
    const cachedSource = String(cachedSession.source?.url || '')
    if (cachedSession.source?.type === 'nhentai' || /nhentai\.net\/g\/\d+/i.test(cachedSource)) {
      pageRecoverySource.value = 'nhentai'
      if (cachedSession.source?.galleryId) {
        pageRecoveryNhentaiCandidates.value = [{
          id: String(cachedSession.source.galleryId),
          url: cachedSource,
          title: '',
          pageCount: cachedSession.online?.pageCount || null
        }]
        pageRecoveryNhentaiSelectedId.value = String(cachedSession.source.galleryId)
      }
    } else if (cachedSession.source?.type === 'jmcomic' || /\/(?:album|photo)\/\d+/i.test(cachedSource) && /(?:18comic|jmcomic|jm365|jm[-.]?comic)/i.test(cachedSource)) {
      pageRecoverySource.value = 'jmcomic'
      if (cachedSession.source?.galleryId) {
        pageRecoveryJmComicCandidates.value = [{
          id: String(cachedSession.source.galleryId),
          url: cachedSource,
          title: '',
          pageCount: cachedSession.online?.pageCount || null
        }]
        pageRecoveryJmComicSelectedId.value = String(cachedSession.source.galleryId)
      }
    } else if (cachedSource && cachedSource === pageRecoverySourceUrls.value.ehviewer) pageRecoverySource.value = 'ehviewer'
    else if (cachedSource && cachedSource === pageRecoverySourceUrls.value.current) pageRecoverySource.value = 'current'
    pageRecoverySourceOffset.value = Number(cachedSession.sourceOffset ?? 0)
  } catch (error) {
    console.debug('Restore page recovery session failed', error)
  }
}
const fetchPageRecovery = async () => {
  if (!selectedAnomaly.value || !pageRecoverySelectedPages.value.length || pageRecoveryLoading.value) return
  if (pageRecoverySource.value === 'nhentai' && !pageRecoverySourceUrls.value.nhentai) {
    ElMessage.warning(t('audit.nhentaiRecoverySelectCandidate'))
    return
  }
  if (pageRecoverySource.value === 'jmcomic' && !pageRecoverySourceUrls.value.jmcomic) {
    ElMessage.warning(t('audit.jmcomicRecoverySelectCandidate'))
    return
  }
  pageRecoveryLoading.value = true
  try {
    const session = await window.auditApi.pageRecovery.fetch({
      reportId: props.report?.reportId,
      anomalyId: pageRecoveryAnomaly.value.id,
      source: pageRecoverySource.value,
      nhentaiId: pageRecoverySource.value === 'nhentai' ? pageRecoveryNhentaiSelectedId.value : null,
      sourceUrl: pageRecoverySource.value === 'jmcomic' ? pageRecoverySourceUrls.value.jmcomic : (pageRecoverySource.value === 'nhentai' ? pageRecoverySourceUrls.value.nhentai : null),
      jmcomicId: pageRecoverySource.value === 'jmcomic' ? pageRecoveryJmComicSelectedId.value : null,
      sourceOffset: pageRecoverySourceOffset.value ?? 0,
      pageNumbers: [...pageRecoverySelectedPages.value]
    })
    pageRecoverySession.value = session
    pageRecoverySelectedCandidates.value = []
    ElMessage.success(t('audit.pageRecoveryAwaitingConfirmation'))
  } catch (error) {
    ElMessage.error(pageRecoveryErrorMessage(error))
  } finally {
    pageRecoveryLoading.value = false
  }
}
const pageRecoverySelectAllCandidates = computed({
  get: () => Boolean(pageRecoverySession.value?.candidates?.length) && pageRecoverySelectedCandidates.value.length === pageRecoverySession.value.candidates.length,
  set: value => { pageRecoverySelectedCandidates.value = value ? (pageRecoverySession.value?.candidates || []).map(item => item.id) : [] }
})
const applyPageRecovery = async () => {
  if (!pageRecoverySessionMatchesSource.value || !pageRecoverySelectedCandidates.value.length || pageRecoveryApplying.value || pageRecoveryLoading.value) return
  try {
    const confirmMessage = pageRecoverySession.value.writeBackSupported
      ? t('audit.pageRecoveryConfirm')
      : t('audit.pageRecoveryConfirmUncertain')
    await ElMessageBox.confirm(confirmMessage, t('audit.pageRecoveryTitle'), { type: 'warning' })
  } catch {
    return
  }
  pageRecoveryApplying.value = true
  try {
    const result = await window.auditApi.pageRecovery.apply({
      reportId: props.report?.reportId,
      anomalyId: pageRecoveryAnomaly.value.id,
      recoveryId: pageRecoverySession.value.recoveryId,
      candidateIds: [...pageRecoverySelectedCandidates.value],
      confirmPageMapping: true
    })
    pageRecoverySession.value = result.session
    ElMessage[result.resolved ? 'success' : 'warning'](t(result.resolved ? 'audit.pageRecoverySuccess' : 'audit.pageRecoveryPartialSuccess'))
    const recoveryAnomalyId = pageRecoveryAnomaly.value?.id
    if (result.resolved && String(selectedAnomaly.value?.id || '') === String(recoveryAnomalyId || '')) {
      pendingRecoveryNavigation.value = {
        reportId: props.report?.reportId || null,
        index: anomalyNavigation.value.index
      }
    }
    emit('recovery-completed')
  } catch (error) {
    ElMessage.error(pageRecoveryErrorMessage(error))
  } finally {
    pageRecoveryApplying.value = false
  }
}
const cleanupPageRecovery = async () => {
  if (!pageRecoverySession.value) return
  try {
    await window.auditApi.pageRecovery.cleanup(pageRecoverySession.value.recoveryId)
    pageRecoverySession.value = null
    pageRecoverySelectedCandidates.value = []
    ElMessage.success(t('audit.pageRecoveryCleanup'))
  } catch (error) {
    ElMessage.error(pageRecoveryErrorMessage(error))
  }
}
const navigateAnomaly = step => {
  const target = step < 0 ? previousAnomaly.value : nextAnomaly.value
  if (target) void openAnomaly(target, getGroupAnomalies(target))
}
watch(
  () => [props.report?.reportId, props.report?.staleAt, props.report?.anomalies?.length],
  () => {
    const pending = pendingRecoveryNavigation.value
    if (!pending || String(pending.reportId || '') !== String(props.report?.reportId || '')) return
    pendingRecoveryNavigation.value = null
    const target = filteredAnomalies.value[pending.index] || filteredAnomalies.value[pending.index - 1]
    if (target) void openAnomaly(target, getGroupAnomalies(target))
    else drawer.value = false
  }
)
watch(() => props.report?.reportId, () => {
  pageRecoverySelectedGroupIds.value = []
  pageRecoveryBatchResults.value = {}
  pageRecoveryTable.value?.clearSelection()
  void restorePageRecoveryCacheStatuses(props.report?.reportId)
  void syncPageRecoveryTableSelection()
}, { immediate: true })
const selectManualSource = async source => {
  if (!selectedAnomaly.value || !manualSourceSelectionSupported.value || manualActionLoading.value) return
  manualActionLoading.value = true
  try {
    const action = await window.auditApi.buildManualSourceAction({
      reportId: props.report?.reportId,
      anomalyId: selectedAnomaly.value.id,
      source
    })
    const manualActions = { ...props.manualActions, [selectedAnomaly.value.id]: action }
    emit('update:manual-actions', manualActions)
    emit('update:actionIds', [...new Set([...props.actionIds, selectedAnomaly.value.id])])
    selectedAnomaly.value = { ...selectedAnomaly.value, action }
    ElMessage.success(t('audit.manualSourceSelected'))
    if (autoOpenNextAfterSelection.value && nextAnomaly.value) await openAnomaly(nextAnomaly.value)
  } catch (error) {
    ElMessage.error(String(error?.message || error))
  } finally {
    manualActionLoading.value = false
  }
}
const openBookDetail = async () => {
  if (!selectedAnomaly.value?.bookId || detailOpening.value) return
  detailOpening.value = true
  try {
    await window.auditApi.openBookDetail({ bookId: String(selectedAnomaly.value.bookId), navigationIds: filteredBookIds.value })
  } catch (error) {
    ElMessage.error(t('audit.openBookDetailFailed'))
  } finally {
    detailOpening.value = false
  }
}

watch(() => pageRecoverySourceUrls.value[pageRecoverySource.value], () => {
  pageRecoverySourceOffset.value = 0
  pageRecoverySelectedCandidates.value = []
}, { flush: 'sync' })
watch(pageRecoverySourceOffset, () => { pageRecoverySelectedCandidates.value = [] }, { flush: 'sync' })
watch(searchInput, value => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { search.value = normalizeSearchText(value); page.value = 1 }, 140) })
watch([severityFilter, typeFilter, policyFilter], () => { page.value = 1 })
watch([() => filteredBookGroups.value.length, pageSize], ([total, size]) => { page.value = Math.min(page.value, Math.max(1, Math.ceil(total / size))) })
watch([page, pageSize, filteredBookGroups], () => { void syncPageRecoveryTableSelection() }, { flush: 'post' })
</script>

<style scoped>
.task-panel { min-height: 0; height: 100%; display: flex; flex-direction: column; }
.task-toolbar { flex: 0 0 auto; min-height: 48px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 8px 0; }
.task-toolbar-main, .filter-row, .filter-meta-row, .filter-counts { display: flex; align-items: center; gap: 12px; }
.online-policy { width: 190px; }
.last-run { flex: 0 0 auto; color: var(--el-text-color-secondary); font-size: 12px; }
.summary-band { flex: 0 0 auto; display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); border: 1px solid var(--el-border-color); border-radius: 4px; margin: 8px 0 12px; }
.summary-band div { padding: 9px 14px; border-right: 1px solid var(--el-border-color); }
.summary-band strong, .summary-band span { display: block; }
.summary-band strong { font-size: 18px; }.summary-band span { margin-top: 3px; color: var(--el-text-color-secondary); font-size: 12px; }
.filter-row { flex: 0 0 auto; display: grid; grid-template-columns: minmax(280px, 1fr) 180px 240px; margin-bottom: 8px; }
.filter-meta-row { flex: 0 0 auto; min-height: 30px; justify-content: space-between; }
.filter-counts { color: var(--el-text-color-secondary); font-size: 12px; }.filter-counts strong { color: var(--el-color-primary); }
.page-recovery-batch-bar { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 42px; margin: 8px 0; padding: 6px 10px; border: 1px solid var(--el-border-color); border-radius: 4px; background: var(--el-fill-color-lighter); color: var(--el-text-color-secondary); font-size: 12px; }.page-recovery-batch-actions { display: flex; align-items: center; gap: 8px; }
.batch-source-row { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; min-height: 38px; margin-bottom: 8px; padding: 6px 10px; border: 1px solid var(--el-border-color); border-radius: 4px; background: var(--el-fill-color-lighter); }.batch-source-label { color: var(--el-text-color-secondary); font-size: 12px; }.batch-source-select { width: 230px; }
.audit-table-region { flex: 1 1 auto; min-height: 220px; }.filtered-empty { height: 100%; display: flex; align-items: center; justify-content: center; }.table-pagination { flex: 0 0 auto; justify-content: flex-end; padding-top: 8px; }
.review-action-bar { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 18px; min-height: 58px; margin-top: 8px; padding: 8px 12px; border: 1px solid var(--el-border-color); border-radius: 4px; background: var(--el-fill-color-lighter); }.review-action-summary { min-width: 0; }.review-action-summary strong, .review-action-summary span { display: block; }.review-action-summary span { margin-top: 3px; color: var(--el-text-color-secondary); font-size: 12px; }.review-action-buttons { display: flex; flex: 0 0 auto; gap: 8px; }
.anomaly-checkbox { display: inline-flex; align-items: center; justify-content: center; }
.anomaly-detail-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; align-items: start; }.anomaly-detail-grid.has-book-preview { grid-template-columns: 150px minmax(0, 1fr); }
.anomaly-description, .anomaly-book-preview { min-width: 0; }.anomaly-cover-button { display: block; width: 150px; padding: 0; border: 0; border-radius: 4px; color: inherit; background: transparent; cursor: pointer; }.anomaly-cover-button:disabled { cursor: wait; }.anomaly-cover-button:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }.anomaly-cover-button:not(:disabled):hover .anomaly-cover { border-color: var(--el-color-primary); box-shadow: 0 0 0 1px var(--el-color-primary-light-5); }
.anomaly-cover { box-sizing: border-box; display: block; width: 150px; aspect-ratio: 500 / 707; overflow: hidden; background: var(--el-fill-color-light); border: 1px solid var(--el-border-color); border-radius: 4px; }.anomaly-cover-placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: var(--el-text-color-secondary); font-size: 12px; text-align: center; }.anomaly-cover-placeholder .el-icon { font-size: 28px; }.anomaly-book-preview p { display: -webkit-box; margin: 8px 0 0; overflow: hidden; color: var(--el-text-color-regular); font-size: 12px; line-height: 1.5; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
.ehviewer-recovery-preview { margin-top: 20px; padding: 16px 0; border-top: 1px solid var(--el-border-color); border-bottom: 1px solid var(--el-border-color); }.ehviewer-recovery-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }.ehviewer-recovery-heading strong, .ehviewer-recovery-heading span { display: block; }.ehviewer-recovery-heading span { margin-top: 5px; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.5; }.ehviewer-recovery-meta { display: grid; grid-template-columns: minmax(0, 1fr) 120px; margin: 0 0 12px; border: 1px solid var(--el-border-color); }.ehviewer-recovery-meta > div { min-width: 0; padding: 10px 12px; }.ehviewer-recovery-meta > div + div { border-left: 1px solid var(--el-border-color); }.ehviewer-recovery-meta dt { color: var(--el-text-color-secondary); font-size: 12px; }.ehviewer-recovery-meta dd { min-width: 0; margin: 5px 0 0; overflow-wrap: anywhere; }.ehviewer-recovery-meta .el-link { max-width: 100%; vertical-align: top; }.ehviewer-recovery-content { min-height: 92px; margin: 0; padding: 14px; overflow: auto; color: var(--el-text-color-primary); font-family: Consolas, 'Courier New', monospace; line-height: 1.55; white-space: pre-wrap; word-break: break-all; background: var(--el-fill-color-light); border: 1px solid var(--el-border-color); }
.ehviewer-recovery-alert { margin-top: 12px; }
.page-recovery-offset { display: grid; grid-template-columns: 72px 150px minmax(0, 1fr); align-items: start; gap: 12px; margin: 14px 0; }
.page-recovery-offset .el-input-number { width: 150px; }
.page-recovery-offset-mapping { min-width: 0; display: flex; flex-wrap: wrap; gap: 4px 14px; padding-top: 6px; color: var(--el-text-color-secondary); font-size: 12px; overflow-wrap: anywhere; }
.page-recovery-candidate-select { height: auto; min-height: 32px; max-width: 100%; align-items: flex-start; }
.page-recovery-candidate-select :deep(.el-checkbox__label) { min-width: 0; white-space: normal; overflow-wrap: anywhere; line-height: 1.5; }
.page-recovery-candidate-select :deep(.el-checkbox__input) { flex: 0 0 auto; margin-top: 3px; }
.page-recovery-comparison { font-size: 12px; line-height: 1.5; }
@media (max-width: 900px) {
  :global(.audit-anomaly-drawer) { width: min(94vw, 620px) !important; }
  .page-recovery-offset { grid-template-columns: 72px minmax(0, 1fr); }
  .page-recovery-offset .el-input-number { max-width: 100%; }
  .page-recovery-offset-mapping { grid-column: 2; }
}
@media (max-width: 540px) {
  .page-recovery-offset { grid-template-columns: minmax(0, 1fr); }
  .page-recovery-offset-mapping { grid-column: 1; }
}
 .page-recovery-panel { margin: 20px 0 0; padding: 16px 0; border-top: 1px solid var(--el-border-color); border-bottom: 1px solid var(--el-border-color); }.page-recovery-heading, .page-recovery-candidate-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }.page-recovery-heading strong, .page-recovery-heading span { display: block; }.page-recovery-heading span { margin-top: 5px; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.5; }.page-recovery-heading-meta { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }.page-recovery-page-count { margin-top: 0 !important; color: var(--el-text-color-secondary); font-size: 12px; white-space: nowrap; }.page-recovery-controls, .page-recovery-pages { display: flex; align-items: flex-start; gap: 12px; margin: 14px 0; }.page-recovery-label { flex: 0 0 72px; padding-top: 6px; color: var(--el-text-color-secondary); font-size: 12px; }.page-recovery-pages .el-checkbox-group { display: flex; flex-wrap: wrap; gap: 4px 12px; }.page-recovery-inferred { margin-left: 4px; color: var(--el-color-warning); font-size: 11px; }.page-recovery-nhentai-source { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: -4px 0 14px 84px; }.page-recovery-nhentai-source .el-link { max-width: 100%; overflow-wrap: anywhere; }.page-recovery-source-page-count { color: var(--el-text-color-secondary); font-size: 12px; white-space: nowrap; }.page-recovery-candidates { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--el-border-color); }.page-recovery-candidate-heading { align-items: center; margin-bottom: 10px; }.page-recovery-candidate { padding: 10px 0 14px; border-bottom: 1px solid var(--el-border-color-lighter); }.page-recovery-candidate-select { display: flex; margin-bottom: 10px; }.page-recovery-candidate-select .el-checkbox__label { min-width: 0; overflow-wrap: anywhere; }.page-recovery-comparison { min-width: 0; }.page-recovery-comparison-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 8px; }.page-recovery-comparison-heading span { color: var(--el-text-color-secondary); font-size: 12px; }.page-recovery-comparison-strip { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }.page-recovery-context { min-width: 0; padding: 8px; border: 1px solid var(--el-border-color); border-radius: 4px; background: var(--el-fill-color-lighter); }.page-recovery-context.is-target { border-color: var(--el-color-success); box-shadow: inset 0 0 0 1px var(--el-color-success-light-5); }.page-recovery-context-image, .page-recovery-context-placeholder { display: block; width: 100%; aspect-ratio: 240 / 340; min-height: 120px; border: 1px solid var(--el-border-color); background: var(--el-fill-color-light); }.page-recovery-context-placeholder { box-sizing: border-box; display: flex; align-items: center; justify-content: center; padding: 12px; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.5; text-align: center; }.page-recovery-context strong, .page-recovery-context span { display: block; min-width: 0; overflow-wrap: anywhere; }.page-recovery-context strong { margin-top: 8px; font-size: 12px; }.page-recovery-context span { margin-top: 4px; color: var(--el-text-color-secondary); font-size: 11px; line-height: 1.4; }.page-recovery-actions { display: flex; gap: 8px; margin-top: 14px; }
 .manual-source-selection { margin: 20px 0 0; padding: 16px 0; border-top: 1px solid var(--el-border-color); border-bottom: 1px solid var(--el-border-color); }.manual-source-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }.manual-source-heading strong, .manual-source-heading span { display: block; }.manual-source-heading span { margin-top: 5px; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.5; }.auto-next-selection { display: flex; margin-top: 12px; }.manual-source-alert { margin-top: 12px; }
 .page-recovery-context.is-fetched-neighbor { border-color: var(--el-color-primary); box-shadow: inset 0 0 0 1px var(--el-color-primary-light-5); }
.book-anomaly-summary { margin: 20px 0 0; padding: 16px 0; border-top: 1px solid var(--el-border-color); border-bottom: 1px solid var(--el-border-color); }.book-anomaly-summary > strong { display: block; margin-bottom: 10px; }.book-anomaly-item { display: flex; align-items: flex-start; gap: 8px; padding: 7px 0; color: var(--el-text-color-regular); font-size: 12px; line-height: 1.5; }.book-anomaly-item + .book-anomaly-item { border-top: 1px solid var(--el-border-color-lighter); }.book-anomaly-item span { min-width: 0; overflow-wrap: anywhere; }
.anomaly-navigation { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: -4px 0 16px; }.anomaly-navigation-count { color: var(--el-text-color-secondary); font-size: 12px; white-space: nowrap; }.page-count-evidence { display: grid; gap: 4px; width: 100%; font-size: 12px; }.page-count-row { display: grid; grid-template-columns: minmax(0, 1fr) 72px minmax(88px, auto); align-items: center; gap: 10px; min-height: 28px; }.page-count-row > :first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.page-count-row strong { color: var(--el-text-color-primary); }.page-count-header { color: var(--el-text-color-secondary); border-bottom: 1px solid var(--el-border-color); }.page-count-header span:nth-child(2), .page-count-row strong { text-align: right; }
.availability-list { display: flex; flex-direction: column; gap: 8px; }.availability-item { display: inline-flex; align-items: center; gap: 8px; margin-right: 12px; }.evidence-block { padding: 14px; overflow: auto; white-space: pre-wrap; word-break: break-all; background: var(--el-fill-color-light); border: 1px solid var(--el-border-color); }
 @media (max-width: 900px) { .task-toolbar, .task-toolbar-main, .review-action-bar { align-items: flex-start; flex-wrap: wrap; }.filter-row { grid-template-columns: 1fr; }.anomaly-detail-grid.has-book-preview, .ehviewer-recovery-meta { grid-template-columns: minmax(0, 1fr); }.ehviewer-recovery-meta > div + div { border-top: 1px solid var(--el-border-color); border-left: 0; }.page-recovery-comparison-strip { grid-template-columns: 1fr; }.page-recovery-comparison-heading { align-items: flex-start; flex-direction: column; gap: 4px; } }
 .page-recovery-nhentai-query { flex: 1 1 320px; max-width: 520px; }.page-recovery-nhentai-results { display: flex; flex-direction: column; gap: 6px; margin: -4px 0 14px 84px; }.page-recovery-nhentai-results > strong { color: var(--el-text-color-secondary); font-size: 12px; }.page-recovery-nhentai-candidate { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; padding: 8px 10px; color: var(--el-text-color-primary); text-align: left; background: var(--el-fill-color-lighter); border: 1px solid var(--el-border-color); border-radius: 4px; cursor: pointer; }.page-recovery-nhentai-candidate span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.page-recovery-nhentai-candidate small { flex: 0 0 auto; color: var(--el-text-color-secondary); }.page-recovery-nhentai-candidate:hover, .page-recovery-nhentai-candidate.is-selected { border-color: var(--el-color-primary); color: var(--el-color-primary); }.page-recovery-nhentai-candidate:disabled { cursor: wait; opacity: .7; }
 @media (max-width: 900px) { .page-recovery-nhentai-source, .page-recovery-nhentai-results { margin-left: 0; }.page-recovery-nhentai-query { max-width: none; } }
 .audit-nhentai-search-dialog .el-form { display: flex; align-items: center; flex-wrap: nowrap; gap: 4px; }.audit-nhentai-search-dialog .el-form-item { margin-right: 0; }.audit-nhentai-search-input { width: min(52vw, 620px); }.audit-nhentai-search-type { width: 170px; }.audit-nhentai-search-results { min-height: 120px; }.audit-nhentai-search-hint { margin: 8px 0 12px; color: var(--el-text-color-secondary); font-size: 12px; }.audit-nhentai-search-result { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; margin: 0; padding: 8px 0; color: var(--el-text-color-primary); text-align: left; background: transparent; border: 0; border-bottom: 1px solid var(--el-border-color-lighter); cursor: pointer; }.audit-nhentai-search-result span { min-width: 0; overflow-wrap: anywhere; }.audit-nhentai-search-result small { flex: 0 0 auto; color: var(--el-text-color-secondary); }.audit-nhentai-search-result:hover, .audit-nhentai-search-result.is-selected { color: var(--el-color-primary); }.audit-nhentai-search-result:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
 @media (max-width: 900px) { .audit-nhentai-search-dialog .el-form { align-items: stretch; flex-wrap: wrap; }.audit-nhentai-search-input { width: 100%; }.audit-nhentai-search-type { width: 140px; } }
</style>

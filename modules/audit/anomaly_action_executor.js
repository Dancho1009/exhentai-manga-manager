const path = require('path')
const { normalizeAnomalyReview } = require('./review_validator.js')
const {
  backupExecutionState,
  ensureExpectedFile,
  snapshotMetadataRows,
  restoreMetadataRows,
  createExecutionContext
} = require('./execution_common.js')
const { sanitizeEhviewerTitle, prepareEhviewerRepair } = require('./ehviewer_repair.js')
const { invalidateAuditCacheEntries } = require('./cache.js')

const selectModelFields = (model, value) => Object.fromEntries(
  Object.keys(model.rawAttributes || {})
    .filter(key => value[key] !== undefined)
    .map(key => [key, value[key]])
)

const REPAIR_ERROR_MESSAGES = {
  CURRENT_GALLERY_IS_AVAILABLE_OR_UNCERTAIN: '当前 Gallery 已恢复可访问或状态不确定，原审批已失效',
  CURRENT_SITE_IS_AVAILABLE: '当前站点已恢复访问，不再需要切换域名',
  CURRENT_SITE_AVAILABILITY_UNCERTAIN: '当前站点只是网络错误或状态不确定，不能据此切换域名',
  GALLERY_VERSION_GDATA_UNAVAILABLE: '无法重新取得版本链元数据，未执行 Gallery 版本升级',
  GALLERY_VERSION_RELATION_CHANGED: 'Gallery 版本关系已经变化，原审批已失效',
  REPAIR_GDATA_UNAVAILABLE: '候选 Gallery 网页可访问，但 gdata 元数据获取失败，未修改 URL',
  REPAIR_CANDIDATE_UNAVAILABLE: '候选 Gallery 当前不可访问，原审批已失效',
  INVALID_REPAIR_CANDIDATE_URL: '候选 Gallery URL 无效',
  EHVIEWER_RECOVERY_GDATA_UNAVAILABLE: '当前 Gallery 的 gdata 元数据验证失败，未重写 .ehviewer',
  EHVIEWER_RECOVERY_IDENTITY_CHANGED: '当前元数据 URL 已变化，原 .ehviewer 修复审批已失效',
  APPROVAL_STALE_TITLE: '当前元数据标题已变化，原 .ehviewer 修复审批已失效'
}

const createRepairValidationError = ({ anomaly, action, prepared, index, total }) => {
  const code = prepared?.error || 'REPAIR_AVAILABILITY_CHANGED'
  const filename = path.basename(action.filepath || '') || String(action.bookId || anomaly.id)
  const detail = prepared?.detail || null
  const detailText = detail?.gdataStatus
    ? `；gdata=${detail.gdataStatus}${detail.gdataError ? ` (${detail.gdataError})` : ''}`
    : detail?.currentSiteStatus
      ? `；${detail.currentSite}=${detail.currentSiteStatus}，${detail.targetSite}=${detail.targetSiteStatus}`
      : detail?.versionStatus
        ? `；version=${detail.versionStatus}`
        : detail?.currentGdataStatus
          ? `；current-gdata=${detail.currentGdataStatus}，candidate-gdata=${detail.candidateGdataStatus}`
      : ''
  const error = new Error(`${code}: ${filename} (${index}/${total})${detailText}`)
  error.code = code
  error.auditContext = {
    anomalyId: anomaly.id,
    bookId: action.bookId,
    filepath: action.filepath,
    currentUrl: action.currentUrl || null,
    newUrl: action.newUrl || null,
    index,
    total,
    detail
  }
  error.auditLogMessage = `审批预检失败 ${index}/${total}：${filename}；${REPAIR_ERROR_MESSAGES[code] || code}${detailText}`
  return error
}

const executeApprovedAnomalies = async ({
  anomalyReport,
  anomalyReview,
  executionId,
  executionDir,
  auditStorePath,
  Manga,
  Metadata,
  databasePath,
  metadataPath,
  collectionList,
  rendererState,
  verifyRepairAction,
  setProgress = async () => {},
  appendLog = async () => {},
  isCancelled = () => false
}) => {
  const review = normalizeAnomalyReview(anomalyReport, anomalyReview)
  const approvedIds = new Set(review.actionIds)
  const approvedAnomalies = (anomalyReport.anomalies || []).filter(item => item.action && approvedIds.has(String(item.id)))
  if (approvedAnomalies.length === 0) throw new Error('NO_APPROVED_ACTIONS')

  const context = createExecutionContext({ executionDir, auditStorePath, executionId, isCancelled })
  const { backupDir, writeActionLog, assertNotCancelled } = context
  const preparedRepairs = []
  const preparedFileRepairs = []
  const affectedHashes = new Set()
  let databaseCommitted = false
  let metadataCommitted = false

  try {
    await setProgress({ phase: 'validating-approvals', completed: 0, total: approvedAnomalies.length, phaseCompleted: 0, phaseTotal: approvedAnomalies.length })
    let completed = 0
    for (const anomaly of approvedAnomalies) {
      assertNotCancelled()
      const action = anomaly.action
      const currentItem = {
        id: action.bookId ? String(action.bookId) : null,
        title: path.basename(action.filepath || ''),
        filepath: action.filepath || null
      }
      await setProgress({ phase: 'validating-approvals', completed, total: approvedAnomalies.length, phaseCompleted: completed, phaseTotal: approvedAnomalies.length, currentItem })
      await ensureExpectedFile({ filepath: action.filepath, size: action.expectedSize, mtimeMs: action.expectedMtimeMs, bookType: action.bookType })
      const book = await Manga.findByPk(action.bookId, { raw: true })
      if (!book) throw new Error(`BOOK_MISSING: ${action.bookId}`)
      const metadata = book.hash ? await Metadata.findByPk(book.hash, { raw: true }) : null
      const effectiveUrl = metadata?.url || book.url || null
      if ((action.currentUrl || null) !== effectiveUrl) throw new Error(`APPROVAL_STALE_URL: ${action.bookId}`)
      if (action.type === 'repair-ehviewer') {
        const effectiveTitle = sanitizeEhviewerTitle(metadata
          ? metadata.title_jpn || metadata.title || book.title_jpn || book.title
          : book.title_jpn || book.title)
        if (effectiveTitle !== action.expectedTitle) throw new Error(`APPROVAL_STALE_TITLE: ${action.bookId}`)
      }
      const prepared = await verifyRepairAction?.(action)
      if (!prepared?.valid) {
        const error = createRepairValidationError({ anomaly, action, prepared, index: completed + 1, total: approvedAnomalies.length })
        try {
          await appendLog(error.auditLogMessage, 'error')
          error.auditLogWritten = true
        } catch {}
        throw error
      }
      if (book.hash) affectedHashes.add(book.hash)
      preparedRepairs.push({ anomaly, action, book, prepared })
      completed += 1
      await setProgress({ phase: 'validating-approvals', completed, total: approvedAnomalies.length, phaseCompleted: completed, phaseTotal: approvedAnomalies.length, currentItem })
    }

    assertNotCancelled()
    await setProgress({ phase: 'preparing-execution', completed: 0, total: approvedAnomalies.length, phaseCompleted: 0, phaseTotal: approvedAnomalies.length, currentItem: null })
    await backupExecutionState({ backupDir, databasePath, metadataPath, rendererState })
    const originalMetadataRows = await snapshotMetadataRows(Metadata, affectedHashes)

    for (const repair of preparedRepairs.filter(item => item.action.type === 'repair-ehviewer')) {
      assertNotCancelled()
      const fileRepair = await prepareEhviewerRepair({ action: repair.action, backupDir })
      repair.fileRepair = fileRepair
      preparedFileRepairs.push(fileRepair)
    }

    const mangaTransaction = await Manga.sequelize.transaction()
    const metadataTransaction = await Metadata.sequelize.transaction()
    try {
      completed = 0
      for (const repair of preparedRepairs) {
        assertNotCancelled()
        const currentItem = {
          id: repair.action.bookId ? String(repair.action.bookId) : null,
          title: path.basename(repair.action.filepath || ''),
          filepath: repair.action.filepath || null
        }
        await setProgress({ phase: 'writing-metadata', completed, total: approvedAnomalies.length, phaseCompleted: completed, phaseTotal: approvedAnomalies.length, currentItem })
        const book = await Manga.findByPk(repair.action.bookId, { transaction: mangaTransaction })
        if (!book) throw new Error(`BOOK_MISSING: ${repair.action.bookId}`)
        let nextValues
        if (repair.action.type === 'repair-ehviewer') {
          await repair.fileRepair.apply()
          const fileSnapshot = await repair.fileRepair.snapshot()
          nextValues = { bundleSize: fileSnapshot.bundleSize, mtime: fileSnapshot.mtime }
          await book.update(nextValues, { transaction: mangaTransaction })
        } else {
          nextValues = {
            ...(repair.prepared.metadata || {}),
            url: repair.prepared.newUrl || repair.action.newUrl
          }
          await book.update(nextValues, { transaction: mangaTransaction })
          const hashCount = book.hash ? await Manga.count({ where: { hash: book.hash }, transaction: mangaTransaction }) : 0
          if (book.hash && hashCount === 1) {
            await Metadata.upsert(selectModelFields(Metadata, book.toJSON()), { transaction: metadataTransaction })
          }
        }
        completed += 1
        await setProgress({ phase: 'writing-metadata', completed, total: approvedAnomalies.length, phaseCompleted: completed, phaseTotal: approvedAnomalies.length, currentItem })
        await writeActionLog({
          status: 'prepared',
          type: repair.action.type,
          anomalyId: repair.anomaly.id,
          bookId: book.id,
          ...(repair.action.type === 'repair-ehviewer'
            ? {
                filepath: repair.action.filepath,
                entryPath: repair.action.entryPath,
                gid: repair.action.identity?.gid,
                token: repair.action.identity?.token,
                backupPath: repair.fileRepair.backupPath
              }
            : { oldUrl: repair.action.currentUrl, newUrl: nextValues.url })
        })
      }

      await metadataTransaction.commit()
      metadataCommitted = true
      await mangaTransaction.commit()
      databaseCommitted = true
    } catch (error) {
      if (!metadataTransaction.finished) await metadataTransaction.rollback().catch(() => {})
      if (!mangaTransaction.finished) await mangaTransaction.rollback().catch(() => {})
      if (metadataCommitted && !databaseCommitted) {
        try {
          await restoreMetadataRows(Metadata, affectedHashes, originalMetadataRows)
          metadataCommitted = false
        } catch (restoreError) {
          await writeActionLog({ status: 'recovery-required', target: 'metadata.sqlite', error: restoreError.stack || restoreError.message })
          const recoveryError = new Error(`AUDIT_RECOVERY_REQUIRED: ${backupDir}`)
          recoveryError.cause = error
          throw recoveryError
        }
      }
      for (const fileRepair of [...preparedFileRepairs].reverse()) {
        await fileRepair.rollback().catch(async restoreError => {
          await writeActionLog({ status: 'recovery-required', target: fileRepair.targetPath, error: restoreError.stack || restoreError.message })
          const recoveryError = new Error(`AUDIT_RECOVERY_REQUIRED: ${backupDir}`)
          recoveryError.cause = error
          throw recoveryError
        })
      }
      throw error
    }

    for (const fileRepair of preparedFileRepairs) {
      await fileRepair.finalize().catch(async error => {
        await writeActionLog({ status: 'cleanup-pending', target: fileRepair.targetPath, error: error.stack || error.message }).catch(() => {})
      })
    }
    await invalidateAuditCacheEntries(
      auditStorePath,
      preparedRepairs.filter(item => item.action.type === 'repair-ehviewer').map(item => item.action.filepath)
    ).catch(async error => {
      await writeActionLog({ status: 'cache-invalidation-pending', error: error.stack || error.message }).catch(() => {})
    })

    await setProgress({ phase: 'verified', completed: approvedAnomalies.length, total: approvedAnomalies.length, phaseCompleted: approvedAnomalies.length, phaseTotal: approvedAnomalies.length, currentItem: null })
    await writeActionLog({ status: 'verified', taskType: 'anomaly', repairedCount: approvedAnomalies.length }).catch(() => {})
    return {
      success: true,
      taskType: 'anomaly',
      backupDir,
      rendererState,
      collectionList,
      movedCount: 0,
      repairedCount: approvedAnomalies.length,
      repairedAnomalyIds: approvedAnomalies.map(item => String(item.id))
    }
  } catch (error) {
    for (const fileRepair of [...preparedFileRepairs].reverse()) {
      await fileRepair.rollback().catch(() => {})
    }
    await writeActionLog({ status: 'failed', taskType: 'anomaly', error: error.stack || error.message }).catch(() => {})
    throw error
  }
}

module.exports = { executeApprovedAnomalies }

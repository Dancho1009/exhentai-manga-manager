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
const { mergeEffectiveBook } = require('../book_detail.js')
const { getAnomalyAction } = require('./review_validator.js')
const { metadataFingerprint, isAutomaticSourceReplacementBlocked } = require('./utils.js')

const selectModelFields = (model, value) => Object.fromEntries(
  Object.keys(model.rawAttributes || {})
    .filter(key => value[key] !== undefined)
    .map(key => [key, value[key]])
)

const selectLocalScanFields = value => Object.fromEntries(
  ['pageCount', 'bundleSize', 'mtime']
    .filter(key => value?.[key] !== undefined)
    .map(key => [key, value[key]])
)

// Keep approval validation consistent with the audit snapshot merge rule:
// an existing Metadata row is authoritative even when its URL is empty.
const normalizeApprovalUrl = value => {
  const url = typeof value === 'string' ? value.trim() : ''
  return url || null
}

const createStaleUrlError = ({ action, book, metadata, effectiveUrl }) => {
  const error = new Error(`APPROVAL_STALE_URL: ${action.bookId}`)
  error.code = 'APPROVAL_STALE_URL'
  error.auditContext = {
    bookId: action.bookId,
    repairKind: action.repairKind || null,
    actionCurrentUrl: normalizeApprovalUrl(action.currentUrl),
    mangaUrl: normalizeApprovalUrl(book?.url),
    metadataUrl: normalizeApprovalUrl(metadata?.url),
    effectiveUrl
  }
  return error
}

const REPAIR_ERROR_MESSAGES = {
  AUTOMATIC_CROSS_SOURCE_REPAIR: '旧审批试图自动覆盖非 EH/EX 来源，请重新检查或人工选择来源',
  NHENTAI_API_KEY_MISSING: '请先在设置中填写 nHentai API Key，未修改元数据',
  NHENTAI_METADATA_UNAVAILABLE: 'nHentai 元数据获取失败，未修改 URL 或元数据',
  NHENTAI_METADATA_INVALID: 'nHentai 返回的元数据与所选来源不一致，未修改数据库',
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
  APPROVAL_STALE_TITLE: '当前元数据标题已变化，原 .ehviewer 修复审批已失效',
  APPROVAL_STALE_URL: '当前元数据 URL 已变化，原审批已失效，请重新检查后再执行',
  APPROVAL_STALE_SIZE: '文件大小已变化，原审批已失效',
  APPROVAL_STALE_MTIME: '文件修改时间已变化，原审批已失效',
  APPROVAL_FILE_MISSING: '文件已不存在，原审批已失效',
  BOOK_MISSING: '数据库记录已不存在，原审批已失效',
  LOCAL_SCAN_PAGE_COUNT_CHANGED: '文件页数已经变化，原本地扫描修复审批已失效',
  LOCAL_SCAN_REPAIR_INVALID: '本地扫描修复数据无效，未修改数据库',
  ORPHAN_METADATA_MISSING: '孤立元数据记录已不存在，原审批已失效',
  ORPHAN_METADATA_NO_LONGER_ORPHAN: '元数据已重新关联 Manga，原删除审批已失效',
  ORPHAN_METADATA_CHANGED: '孤立元数据内容已变化，原删除审批已失效'
}

const SKIPPABLE_APPROVAL_ERRORS = new Set(Object.keys(REPAIR_ERROR_MESSAGES))

const getErrorCode = error => {
  const messageCode = String(error?.message || '').match(/^([A-Z][A-Z0-9_]+)(?::|$)/)?.[1]
  if (error?.code === 'ENOENT') return 'APPROVAL_FILE_MISSING'
  return SKIPPABLE_APPROVAL_ERRORS.has(error?.code)
    ? error.code
    : SKIPPABLE_APPROVAL_ERRORS.has(messageCode) ? messageCode : null
}

const createSkippedApproval = ({ anomaly, action, error, index, total }) => {
  const code = getErrorCode(error)
  if (!code) return null
  const filename = path.basename(action.filepath || '') || String(action.bookId || anomaly.id)
  const detail = error?.auditContext?.detail || null
  const detailText = formatRepairDetail(detail)
  return {
    anomalyId: String(anomaly.id),
    bookId: action.bookId ? String(action.bookId) : null,
    filepath: action.filepath || null,
    code,
    detail,
    logMessage: error?.auditLogMessage || `审批预检跳过 ${index}/${total}：${filename}；${REPAIR_ERROR_MESSAGES[code] || code}${detailText}`
  }
}

const formatRepairDetail = detail => {
  if (!detail) return ''
  if (detail.gdataStatus) return `；gdata=${detail.gdataStatus}${detail.gdataError ? ` (${detail.gdataError})` : ''}`
  if (detail.currentSiteStatus) return `；${detail.currentSite}=${detail.currentSiteStatus}，${detail.targetSite}=${detail.targetSiteStatus}`
  if (detail.versionStatus) return `；version=${detail.versionStatus}`
  if (detail.currentGdataStatus) return `；current-gdata=${detail.currentGdataStatus}，candidate-gdata=${detail.candidateGdataStatus}`
  if (detail.actualPageCount !== undefined) return `；page-count=${detail.actualPageCount}，expected=${detail.expectedPageCount}`
  if (detail.inspectionError) return `；inspection=${detail.inspectionError}`
  return ''
}

const createRepairValidationError = ({ anomaly, action, prepared, index, total }) => {
  const code = prepared?.error || 'REPAIR_AVAILABILITY_CHANGED'
  const filename = path.basename(action.filepath || '') || String(action.bookId || anomaly.id)
  const detail = prepared?.detail || null
  const detailText = formatRepairDetail(detail)
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
  const approvedAnomalies = (anomalyReport.anomalies || [])
    .map(item => ({ ...item, action: getAnomalyAction(item, review) }))
    .filter(item => item.action && approvedIds.has(String(item.id)))
  if (approvedAnomalies.length === 0) throw new Error('NO_APPROVED_ACTIONS')

  const context = createExecutionContext({ executionDir, auditStorePath, executionId, isCancelled })
  const { backupDir, writeActionLog, assertNotCancelled } = context
  const preparedRepairs = []
  const preparedFileRepairs = []
  const skippedItems = []
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
        title: path.basename(action.filepath || '') || action.expectedTitle || action.metadataHash || String(action.bookId || ''),
        filepath: action.filepath || null
      }
      await setProgress({ phase: 'validating-approvals', completed, total: approvedAnomalies.length, phaseCompleted: completed, phaseTotal: approvedAnomalies.length, currentItem })
      try {
        if (action.type === 'delete-orphan-metadata') {
          const metadataHash = String(action.metadataHash || '')
          const metadata = await Metadata.findByPk(metadataHash, { raw: true })
          if (!metadata) throw new Error(`ORPHAN_METADATA_MISSING: ${metadataHash}`)
          const mangaReferences = await Manga.count({ where: { hash: metadataHash } })
          if (mangaReferences > 0) throw new Error(`ORPHAN_METADATA_NO_LONGER_ORPHAN: ${metadataHash}`)
          if (metadataFingerprint(metadata) !== action.expectedFingerprint) {
            throw new Error(`ORPHAN_METADATA_CHANGED: ${metadataHash}`)
          }
          affectedHashes.add(metadataHash)
          preparedRepairs.push({ anomaly, action, book: null, metadata, prepared: { valid: true } })
        } else {
          await ensureExpectedFile({ filepath: action.filepath, size: action.expectedSize, mtimeMs: action.expectedMtimeMs, bookType: action.bookType })
          const book = await Manga.findByPk(action.bookId, { raw: true })
          if (!book) throw new Error(`BOOK_MISSING: ${action.bookId}`)
          const [metadata, hashPeers] = book.hash
            ? await Promise.all([
                Metadata.findByPk(book.hash, { raw: true }),
                Manga.findAll({ where: { hash: book.hash }, raw: true })
              ])
            : [null, []]
          const effectiveBook = mergeEffectiveBook({ manga: book, metadata, hashPeers })
          if (action.type !== 'repair-local-scan') {
            const effectiveUrl = normalizeApprovalUrl(effectiveBook.url)
            const approvedUrl = normalizeApprovalUrl(action.currentUrl)
            if (approvedUrl !== effectiveUrl) throw createStaleUrlError({ action, book, metadata, effectiveUrl })
          }
          if (isAutomaticSourceReplacementBlocked(action)) throw new Error('AUTOMATIC_CROSS_SOURCE_REPAIR')
          if (action.type === 'repair-ehviewer') {
            const effectiveTitle = sanitizeEhviewerTitle(effectiveBook.title_jpn || effectiveBook.title)
            if (effectiveTitle !== action.expectedTitle) throw new Error(`APPROVAL_STALE_TITLE: ${action.bookId}`)
          }
          const prepared = await verifyRepairAction?.(action)
          if (!prepared?.valid) {
            throw createRepairValidationError({ anomaly, action, prepared, index: completed + 1, total: approvedAnomalies.length })
          }
          if (book.hash) affectedHashes.add(book.hash)
          preparedRepairs.push({ anomaly, action, book, prepared })
        }
      } catch (error) {
        if (error?.message === 'AUDIT_CANCELLED') throw error
        const skipped = createSkippedApproval({ anomaly, action, error, index: completed + 1, total: approvedAnomalies.length })
        if (!skipped) throw error
        skippedItems.push(skipped)
        try {
          await appendLog(skipped.logMessage, 'warning')
        } catch {}
        await writeActionLog({
          status: 'skipped',
          type: action.type,
          repairKind: action.repairKind || null,
          anomalyId: skipped.anomalyId,
          bookId: skipped.bookId,
          filepath: skipped.filepath,
          code: skipped.code,
          detail: skipped.detail
        }).catch(() => {})
      }
      completed += 1
      await setProgress({ phase: 'validating-approvals', completed, total: approvedAnomalies.length, phaseCompleted: completed, phaseTotal: approvedAnomalies.length, currentItem })
    }

    assertNotCancelled()
    if (preparedRepairs.length === 0) {
      await setProgress({ phase: 'verified', completed: approvedAnomalies.length, total: approvedAnomalies.length, phaseCompleted: approvedAnomalies.length, phaseTotal: approvedAnomalies.length, currentItem: null })
      await writeActionLog({ status: 'verified', taskType: 'anomaly', repairedCount: 0, skippedCount: skippedItems.length }).catch(() => {})
      return {
        success: true,
        taskType: 'anomaly',
        backupDir: null,
        rendererState,
        collectionList,
        movedCount: 0,
        repairedCount: 0,
        skippedCount: skippedItems.length,
        skippedItems,
        repairedAnomalyIds: []
      }
    }

    await setProgress({ phase: 'preparing-execution', completed: 0, total: preparedRepairs.length, phaseCompleted: 0, phaseTotal: preparedRepairs.length, currentItem: null })
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
          title: path.basename(repair.action.filepath || '') || repair.action.expectedTitle || repair.action.metadataHash || String(repair.action.bookId || ''),
          filepath: repair.action.filepath || null
        }
        await setProgress({ phase: 'writing-metadata', completed, total: preparedRepairs.length, phaseCompleted: completed, phaseTotal: preparedRepairs.length, currentItem })
        let nextValues
        if (repair.action.type === 'delete-orphan-metadata') {
          const deleted = await Metadata.destroy({ where: { hash: repair.action.metadataHash }, transaction: metadataTransaction })
          if (deleted !== 1) throw new Error(`ORPHAN_METADATA_MISSING: ${repair.action.metadataHash}`)
          nextValues = { metadataHash: repair.action.metadataHash }
        } else {
          const book = await Manga.findByPk(repair.action.bookId, { transaction: mangaTransaction })
          if (!book) throw new Error(`BOOK_MISSING: ${repair.action.bookId}`)
          if (repair.action.type === 'repair-ehviewer') {
            await repair.fileRepair.apply()
            const fileSnapshot = await repair.fileRepair.snapshot()
            nextValues = { bundleSize: fileSnapshot.bundleSize, mtime: fileSnapshot.mtime }
            await book.update(nextValues, { transaction: mangaTransaction })
          } else if (repair.action.type === 'repair-local-scan') {
            nextValues = selectLocalScanFields(repair.prepared.localUpdates || repair.action.updates || {})
            if (Object.keys(nextValues).length === 0) throw new Error('LOCAL_SCAN_REPAIR_INVALID')
            await book.update(nextValues, { transaction: mangaTransaction })
          } else {
            nextValues = {
              ...(repair.prepared.metadata || {}),
              url: repair.prepared.newUrl || repair.action.newUrl
            }
            await book.update(nextValues, { transaction: mangaTransaction })
            if (book.hash) await Metadata.upsert(selectModelFields(Metadata, book.toJSON()), { transaction: metadataTransaction })
          }
        }
        completed += 1
        await setProgress({ phase: 'writing-metadata', completed, total: preparedRepairs.length, phaseCompleted: completed, phaseTotal: preparedRepairs.length, currentItem })
        await writeActionLog({
          status: 'prepared',
          type: repair.action.type,
          anomalyId: repair.anomaly.id,
          bookId: repair.action.bookId ? String(repair.action.bookId) : null,
          ...(repair.action.type === 'delete-orphan-metadata'
            ? { metadataHash: repair.action.metadataHash }
            : repair.action.type === 'repair-ehviewer'
            ? {
                filepath: repair.action.filepath,
                entryPath: repair.action.entryPath,
                gid: repair.action.identity?.gid,
                token: repair.action.identity?.token,
                backupPath: repair.fileRepair.backupPath
              }
            : repair.action.type === 'repair-local-scan'
              ? { updates: nextValues }
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
      preparedRepairs.filter(item => ['repair-ehviewer', 'repair-local-scan'].includes(item.action.type)).map(item => item.action.filepath)
    ).catch(async error => {
      await writeActionLog({ status: 'cache-invalidation-pending', error: error.stack || error.message }).catch(() => {})
    })

    await setProgress({ phase: 'verified', completed: approvedAnomalies.length, total: approvedAnomalies.length, phaseCompleted: approvedAnomalies.length, phaseTotal: approvedAnomalies.length, currentItem: null })
    await writeActionLog({ status: 'verified', taskType: 'anomaly', repairedCount: preparedRepairs.length, skippedCount: skippedItems.length }).catch(() => {})
    return {
      success: true,
      taskType: 'anomaly',
      backupDir,
      rendererState,
      collectionList,
      movedCount: 0,
      repairedCount: preparedRepairs.length,
      skippedCount: skippedItems.length,
      skippedItems,
      repairedAnomalyIds: preparedRepairs.map(item => String(item.anomaly.id))
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

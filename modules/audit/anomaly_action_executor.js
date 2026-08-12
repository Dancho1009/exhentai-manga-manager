const { normalizeAnomalyReview } = require('./review_validator.js')
const {
  backupExecutionState,
  ensureExpectedFile,
  snapshotMetadataRows,
  restoreMetadataRows,
  createExecutionContext
} = require('./execution_common.js')

const selectModelFields = (model, value) => Object.fromEntries(
  Object.keys(model.rawAttributes || {})
    .filter(key => value[key] !== undefined)
    .map(key => [key, value[key]])
)

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
  isCancelled = () => false
}) => {
  const review = normalizeAnomalyReview(anomalyReport, anomalyReview)
  const approvedIds = new Set(review.actionIds)
  const approvedAnomalies = (anomalyReport.anomalies || []).filter(item => item.action && approvedIds.has(String(item.id)))
  if (approvedAnomalies.length === 0) throw new Error('NO_APPROVED_ACTIONS')

  const context = createExecutionContext({ executionDir, auditStorePath, executionId, isCancelled })
  const { backupDir, writeActionLog, assertNotCancelled } = context
  const preparedRepairs = []
  const affectedHashes = new Set()
  let databaseCommitted = false
  let metadataCommitted = false

  try {
    await setProgress({ phase: 'validating-approvals', completed: 0, total: approvedAnomalies.length, phaseCompleted: 0, phaseTotal: approvedAnomalies.length })
    let completed = 0
    for (const anomaly of approvedAnomalies) {
      assertNotCancelled()
      const action = anomaly.action
      await ensureExpectedFile({ filepath: action.filepath, size: action.expectedSize, mtimeMs: action.expectedMtimeMs })
      const book = await Manga.findByPk(action.bookId, { raw: true })
      if (!book) throw new Error(`BOOK_MISSING: ${action.bookId}`)
      const metadata = book.hash ? await Metadata.findByPk(book.hash, { raw: true }) : null
      const effectiveUrl = book.url || metadata?.url || null
      if ((action.currentUrl || null) !== effectiveUrl) throw new Error(`APPROVAL_STALE_URL: ${action.bookId}`)
      const prepared = await verifyRepairAction?.(action)
      if (!prepared?.valid) throw new Error(prepared?.error || `REPAIR_AVAILABILITY_CHANGED: ${anomaly.id}`)
      if (book.hash) affectedHashes.add(book.hash)
      preparedRepairs.push({ anomaly, action, book, prepared })
      completed += 1
      await setProgress({ phase: 'validating-approvals', completed, total: approvedAnomalies.length, phaseCompleted: completed, phaseTotal: approvedAnomalies.length })
    }

    assertNotCancelled()
    await setProgress({ phase: 'preparing-execution', completed: 0, total: approvedAnomalies.length, phaseCompleted: 0, phaseTotal: approvedAnomalies.length })
    await backupExecutionState({ backupDir, databasePath, metadataPath, rendererState })
    const originalMetadataRows = await snapshotMetadataRows(Metadata, affectedHashes)

    const mangaTransaction = await Manga.sequelize.transaction()
    const metadataTransaction = await Metadata.sequelize.transaction()
    try {
      completed = 0
      for (const repair of preparedRepairs) {
        assertNotCancelled()
        const book = await Manga.findByPk(repair.action.bookId, { transaction: mangaTransaction })
        if (!book) throw new Error(`BOOK_MISSING: ${repair.action.bookId}`)
        const nextValues = {
          ...(repair.prepared.metadata || {}),
          url: repair.prepared.newUrl || repair.action.newUrl
        }
        await book.update(nextValues, { transaction: mangaTransaction })
        const hashCount = book.hash ? await Manga.count({ where: { hash: book.hash }, transaction: mangaTransaction }) : 0
        if (book.hash && hashCount === 1) {
          await Metadata.upsert(selectModelFields(Metadata, book.toJSON()), { transaction: metadataTransaction })
        }
        completed += 1
        await setProgress({ phase: 'writing-metadata', completed, total: approvedAnomalies.length, phaseCompleted: completed, phaseTotal: approvedAnomalies.length })
        await writeActionLog({
          status: 'prepared',
          type: 'repair-url',
          anomalyId: repair.anomaly.id,
          bookId: book.id,
          oldUrl: repair.action.currentUrl,
          newUrl: nextValues.url
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
      throw error
    }

    await setProgress({ phase: 'verified', completed: approvedAnomalies.length, total: approvedAnomalies.length, phaseCompleted: approvedAnomalies.length, phaseTotal: approvedAnomalies.length })
    await writeActionLog({ status: 'verified', taskType: 'anomaly', repairedCount: approvedAnomalies.length }).catch(() => {})
    return {
      success: true,
      taskType: 'anomaly',
      backupDir,
      rendererState,
      collectionList,
      movedCount: 0,
      repairedCount: approvedAnomalies.length
    }
  } catch (error) {
    await writeActionLog({ status: 'failed', taskType: 'anomaly', error: error.stack || error.message }).catch(() => {})
    throw error
  }
}

module.exports = { executeApprovedAnomalies }

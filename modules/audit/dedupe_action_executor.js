const path = require('path')
const { Op } = require('sequelize')
const { normalizeDedupeReview, assertQuarantineRoot } = require('./review_validator.js')
const {
  backupExecutionState,
  ensureExpectedFile,
  moveAndVerify,
  uniqueTargetPath,
  mergeRendererState,
  snapshotMetadataRows,
  restoreMetadataRows,
  createExecutionContext
} = require('./execution_common.js')

const selectModelFields = (model, value) => Object.fromEntries(
  Object.keys(model.rawAttributes || {})
    .filter(key => value[key] !== undefined)
    .map(key => [key, value[key]])
)

const executeApprovedDuplicates = async ({
  dedupeReport,
  dedupeReview,
  executionId,
  executionDir,
  auditStorePath,
  Manga,
  Metadata,
  databasePath,
  metadataPath,
  collectionList,
  saveCollectionList,
  library,
  quarantineRoot: fallbackQuarantineRoot,
  rendererState,
  setProgress = async () => {},
  isCancelled = () => false
}) => {
  const review = normalizeDedupeReview(dedupeReport, {
    ...dedupeReview,
    quarantineRoot: dedupeReview?.quarantineRoot || fallbackQuarantineRoot
  })
  const quarantineRoot = assertQuarantineRoot(library, review.quarantineRoot)
  const selectedGroups = Object.entries(review.selections)
  if (selectedGroups.length === 0) throw new Error('NO_APPROVED_ACTIONS')

  const groupMap = new Map((dedupeReport.groups || []).map(group => [String(group.id), group]))
  const duplicateActions = selectedGroups.map(([groupId, selection]) => {
    const group = groupMap.get(groupId)
    const keep = group.items.find(item => String(item.id) === selection.keepId)
    const quarantineIdSet = new Set(selection.quarantineIds)
    const quarantineItems = group.items.filter(item => quarantineIdSet.has(String(item.id)))
    return { group, keep, quarantineItems }
  })
  const totalActions = duplicateActions.reduce((sum, action) => sum + action.quarantineItems.length, 0)
  if (totalActions === 0) throw new Error('NO_APPROVED_ACTIONS')

  const context = createExecutionContext({ executionDir, auditStorePath, executionId, isCancelled })
  const { backupDir, writeActionLog, assertNotCancelled } = context
  const movedFiles = []
  const idMap = {}
  const affectedHashes = new Set(duplicateActions.flatMap(action => [action.keep, ...action.quarantineItems].map(item => item.hash).filter(Boolean)))
  let nextCollections = JSON.parse(JSON.stringify(collectionList || []))
  let databaseCommitted = false
  let metadataCommitted = false
  let collectionWriteAttempted = false

  try {
    await setProgress({ phase: 'validating-approvals', completed: 0, total: totalActions, phaseCompleted: 0, phaseTotal: totalActions })
    let completed = 0
    for (const action of duplicateActions) {
      assertNotCancelled()
      await ensureExpectedFile(action.keep)
      for (const item of action.quarantineItems) {
        await ensureExpectedFile(item)
        completed += 1
        await setProgress({ phase: 'validating-approvals', completed, total: totalActions, phaseCompleted: completed, phaseTotal: totalActions })
      }
    }

    assertNotCancelled()
    await setProgress({ phase: 'preparing-execution', completed: 0, total: totalActions, phaseCompleted: 0, phaseTotal: totalActions })
    await backupExecutionState({ backupDir, databasePath, metadataPath, rendererState })
    const originalMetadataRows = await snapshotMetadataRows(Metadata, affectedHashes)

    completed = 0
    for (const action of duplicateActions) {
      for (const item of action.quarantineItems) {
        assertNotCancelled()
        const relative = path.relative(library, item.filepath)
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`FILE_OUTSIDE_LIBRARY: ${item.filepath}`)
        const requestedTarget = path.join(quarantineRoot, executionId, relative)
        const target = await uniqueTargetPath(requestedTarget, item.id)
        await writeActionLog({ status: 'prepared', type: 'quarantine', groupId: action.group.id, source: item.filepath, target, keepId: action.keep.id })
        await moveAndVerify(item.filepath, target)
        movedFiles.push({ source: item.filepath, target })
        idMap[item.id] = action.keep.id
        completed += 1
        await setProgress({ phase: 'quarantining-files', completed, total: totalActions, phaseCompleted: completed, phaseTotal: totalActions })
        await writeActionLog({ status: 'file-verified', type: 'quarantine', groupId: action.group.id, source: item.filepath, target, keepId: action.keep.id })
      }
    }

    const mangaTransaction = await Manga.sequelize.transaction()
    const metadataTransaction = await Metadata.sequelize.transaction()
    try {
      for (const action of duplicateActions) {
        assertNotCancelled()
        const keepBook = await Manga.findByPk(action.keep.id, { transaction: mangaTransaction })
        const quarantineIds = action.quarantineItems.map(item => item.id)
        const removedBooks = await Manga.findAll({ where: { id: { [Op.in]: quarantineIds } }, transaction: mangaTransaction })
        if (!keepBook || removedBooks.length !== quarantineIds.length) throw new Error(`BOOK_SET_CHANGED: ${action.group.id}`)
        const allBooks = [keepBook, ...removedBooks]
        await keepBook.update({
          readCount: Math.max(...allBooks.map(book => Number(book.readCount || 0))),
          mark: allBooks.some(book => Boolean(book.mark)),
          hiddenBook: allBooks.every(book => Boolean(book.hiddenBook))
        }, { transaction: mangaTransaction })
        await Manga.destroy({ where: { id: { [Op.in]: quarantineIds } }, transaction: mangaTransaction })

        const removedKeys = new Set(action.quarantineItems.flatMap(item => [item.id, item.hash]).filter(Boolean))
        nextCollections = nextCollections.map(collection => ({
          ...collection,
          list: [...new Set((collection.list || []).map(value => removedKeys.has(value) ? keepBook.hash : value))]
        }))

        if (keepBook.hash && await Manga.count({ where: { hash: keepBook.hash }, transaction: mangaTransaction }) === 1) {
          await Metadata.upsert(selectModelFields(Metadata, keepBook.toJSON()), { transaction: metadataTransaction })
        }
        for (const hash of new Set(action.quarantineItems.map(item => item.hash).filter(Boolean))) {
          if (await Manga.count({ where: { hash }, transaction: mangaTransaction }) === 0) {
            await Metadata.destroy({ where: { hash }, transaction: metadataTransaction })
          }
        }
        await writeActionLog({ status: 'prepared-database', type: 'dedupe', groupId: action.group.id, keepId: keepBook.id, removedIds: quarantineIds })
      }

      collectionWriteAttempted = true
      await saveCollectionList(nextCollections)
      await metadataTransaction.commit()
      metadataCommitted = true
      await mangaTransaction.commit()
      databaseCommitted = true
    } catch (error) {
      if (!metadataTransaction.finished) await metadataTransaction.rollback().catch(() => {})
      if (!mangaTransaction.finished) await mangaTransaction.rollback().catch(() => {})
      let collectionRestoreError = null
      if (collectionWriteAttempted) {
        try {
          await saveCollectionList(collectionList)
        } catch (restoreError) {
          collectionRestoreError = restoreError
          await writeActionLog({ status: 'recovery-required', target: 'collectionList.json', error: restoreError.stack || restoreError.message })
        }
        collectionWriteAttempted = false
      }
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
      if (collectionRestoreError) {
        const recoveryError = new Error(`AUDIT_RECOVERY_REQUIRED: ${backupDir}`)
        recoveryError.cause = error
        recoveryError.restoreError = collectionRestoreError
        throw recoveryError
      }
      throw error
    }

    const nextRendererState = mergeRendererState(rendererState, idMap)
    await setProgress({ phase: 'writing-metadata', completed: totalActions, total: totalActions, phaseCompleted: totalActions, phaseTotal: totalActions })
    await setProgress({ phase: 'verified', completed: totalActions, total: totalActions, phaseCompleted: totalActions, phaseTotal: totalActions })
    await writeActionLog({ status: 'verified', taskType: 'dedupe', movedCount: movedFiles.length, repairedCount: 0 }).catch(() => {})
    return {
      success: true,
      taskType: 'dedupe',
      backupDir,
      rendererState: nextRendererState,
      collectionList: nextCollections,
      movedCount: movedFiles.length,
      repairedCount: 0
    }
  } catch (error) {
    let rollbackFailed = false
    if (!databaseCommitted) {
      for (const moved of [...movedFiles].reverse()) {
        try {
          await moveAndVerify(moved.target, moved.source)
        } catch (rollbackError) {
          rollbackFailed = true
          await writeActionLog({ status: 'rollback-failed', source: moved.source, target: moved.target, error: rollbackError.stack || rollbackError.message }).catch(() => {})
        }
      }
    }
    await writeActionLog({ status: 'failed', taskType: 'dedupe', error: error.stack || error.message }).catch(() => {})
    if (rollbackFailed) {
      const recoveryError = new Error(`AUDIT_RECOVERY_REQUIRED: ${backupDir}`)
      recoveryError.cause = error
      throw recoveryError
    }
    throw error
  }
}

module.exports = { executeApprovedDuplicates }

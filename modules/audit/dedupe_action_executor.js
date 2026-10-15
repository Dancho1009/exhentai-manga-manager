const path = require('path')
const { Op } = require('sequelize')
const { normalizeDedupeReview, assertQuarantineRoot, getDedupeActions } = require('./review_validator.js')
const { verifyDedupeItem } = require('./dedupe_verification.js')
const { atomicWriteJson, normalizePath } = require('./utils.js')
const { mergeEffectiveBook } = require('../book_detail.js')
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
  sevenZipPath,
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
  const duplicateActions = getDedupeActions(dedupeReport, review)
  const totalActions = duplicateActions.reduce((sum, action) => sum + action.quarantineItems.length, 0)
  if (totalActions === 0) throw new Error('NO_APPROVED_ACTIONS')
  const removedFolders = duplicateActions.flatMap(action => action.quarantineItems).filter(item => item.type === 'folder')
  if (removedFolders.length) {
    const currentPaths = await Manga.findAll({ attributes: ['id', 'filepath'], raw: true })
    for (const folder of removedFolders) {
      const prefix = normalizePath(folder.filepath) + path.sep
      if (currentPaths.some(book => book.filepath && normalizePath(book.filepath).startsWith(prefix))) throw new Error('DUPLICATE_FOLDER_CONTAINS_OTHER_BOOKS: ' + folder.id)
    }
  }

  const context = createExecutionContext({ executionDir, auditStorePath, executionId, isCancelled })
  const { backupDir, writeActionLog, assertNotCancelled } = context
  const movedFiles = []
  const idMap = {}
  const affectedHashes = new Set(duplicateActions.flatMap(action => [action.keep, ...action.quarantineItems].map(item => item.hash).filter(Boolean)))
  let nextCollections = JSON.parse(JSON.stringify(collectionList || []))
  let databaseCommitted = false
  let metadataCommitted = false
  let collectionWriteAttempted = false
  const verifiedIds = new Set()
  const verify = async item => {
    if (verifiedIds.has(String(item.id))) return
    if (dedupeReport.dedupeVersion >= 2) await verifyDedupeItem(item, { Manga, Metadata, sevenZipPath, isCancelled })
    else await ensureExpectedFile(item)
    verifiedIds.add(String(item.id))
  }

  try {
    await setProgress({ phase: 'validating-approvals', completed: 0, total: totalActions, phaseCompleted: 0, phaseTotal: totalActions })
    let completed = 0
    for (const action of duplicateActions) {
      assertNotCancelled()
      await setProgress({
        phase: 'validating-approvals',
        completed,
        total: totalActions,
        phaseCompleted: completed,
        phaseTotal: totalActions,
        currentItem: { id: String(action.keep.id), title: action.keep.title || path.basename(action.keep.filepath), filepath: action.keep.filepath }
      })
      await verify(action.keep)
      for (const item of action.quarantineItems) {
        const currentItem = { id: String(item.id), title: item.title || path.basename(item.filepath), filepath: item.filepath }
        await setProgress({ phase: 'validating-approvals', completed, total: totalActions, phaseCompleted: completed, phaseTotal: totalActions, currentItem })
        await verify(item)
        completed += 1
        await setProgress({ phase: 'validating-approvals', completed, total: totalActions, phaseCompleted: completed, phaseTotal: totalActions, currentItem })
      }
    }

    assertNotCancelled()
    await setProgress({ phase: 'preparing-execution', completed: 0, total: totalActions, phaseCompleted: 0, phaseTotal: totalActions, currentItem: null })
    await backupExecutionState({ backupDir, databasePath, metadataPath, rendererState })
    const originalMetadataRows = await snapshotMetadataRows(Metadata, affectedHashes)
    const participantIds = [...new Set(duplicateActions.flatMap(action => [action.keep.id, ...action.quarantineItems.map(item => item.id)]))]
    const beforeState = { mangas: await Manga.findAll({ where: { id: { [Op.in]: participantIds } }, raw: true }), metadata: originalMetadataRows,
      collections: collectionList, rendererState }
    const statePath = path.join(executionDir, 'dedupe-state.json')
    await atomicWriteJson(statePath, { executionId, reportId: dedupeReport.reportId, review, before: beforeState })

    completed = 0
    for (const action of duplicateActions) {
      for (const item of action.quarantineItems) {
        assertNotCancelled()
        const currentItem = { id: String(item.id), title: item.title || path.basename(item.filepath), filepath: item.filepath }
        await setProgress({ phase: 'quarantining-files', completed, total: totalActions, phaseCompleted: completed, phaseTotal: totalActions, currentItem })
        const relative = path.relative(library, item.filepath)
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`FILE_OUTSIDE_LIBRARY: ${item.filepath}`)
        const requestedTarget = path.join(quarantineRoot, executionId, relative)
        const target = await uniqueTargetPath(requestedTarget, item.id)
        await writeActionLog({ status: 'prepared', type: 'quarantine', groupId: action.group.id, evidenceRevision: action.group.evidenceRevision,
          reason: review.decisions[action.group.id]?.reason || '', source: item.filepath, target, keepId: action.keep.id })
        await moveAndVerify(item.filepath, target)
        movedFiles.push({ source: item.filepath, target })
        idMap[item.id] = action.keep.id
        completed += 1
        await setProgress({ phase: 'quarantining-files', completed, total: totalActions, phaseCompleted: completed, phaseTotal: totalActions, currentItem })
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
        const keepMetadata = keepBook.hash ? await Metadata.findByPk(keepBook.hash, { transaction: metadataTransaction }) : null
        const effectiveKeeper = mergeEffectiveBook({ manga: keepBook.toJSON(),
          metadata: keepMetadata?.toJSON() || null,
          hashPeers: keepBook.hash ? await Manga.findAll({ where: { hash: keepBook.hash }, raw: true, transaction: mangaTransaction }) : [] })
        await Manga.destroy({ where: { id: { [Op.in]: quarantineIds } }, transaction: mangaTransaction })

        const removedKeys = new Set(action.quarantineItems.flatMap(item => [item.id, item.hash]).filter(Boolean))
        nextCollections = nextCollections.map(collection => ({
          ...collection,
          list: [...new Set((collection.list || []).map(value => removedKeys.has(value) ? keepBook.hash : value))]
        }))

        if (keepBook.hash && await Manga.count({ where: { hash: keepBook.hash }, transaction: mangaTransaction }) === 1) {
          await Metadata.upsert(selectModelFields(Metadata, { ...effectiveKeeper, mark: keepBook.mark }), { transaction: metadataTransaction })
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
    await atomicWriteJson(statePath, { executionId, reportId: dedupeReport.reportId, review, before: beforeState,
      after: { mangas: await Manga.findAll({ where: { id: { [Op.in]: participantIds } }, raw: true }), metadata: await snapshotMetadataRows(Metadata, affectedHashes),
        collections: nextCollections, rendererState: nextRendererState }, movedFiles }).catch(async error => {
      await writeActionLog({ status: 'recovery-required', target: statePath, error: error.message }).catch(() => {})
    })
    await setProgress({ phase: 'writing-metadata', completed: totalActions, total: totalActions, phaseCompleted: totalActions, phaseTotal: totalActions, currentItem: null })
    await setProgress({ phase: 'verified', completed: totalActions, total: totalActions, phaseCompleted: totalActions, phaseTotal: totalActions, currentItem: null })
    await writeActionLog({ status: 'verified', taskType: 'dedupe', movedCount: movedFiles.length, repairedCount: 0 }).catch(() => {})
    return {
      success: true,
      taskType: 'dedupe',
      backupDir,
      executionId,
      statePath,
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

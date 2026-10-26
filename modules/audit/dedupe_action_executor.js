const fs = require('fs')
const path = require('path')
const { Op } = require('sequelize')
const { normalizeDedupeReview, assertQuarantineRoot, getDedupeActions } = require('./review_validator.js')
const { verifyDedupeItem } = require('./dedupe_verification.js')
const { atomicWriteJson } = require('./utils.js')
const { mergeEffectiveBook } = require('../book_detail.js')
const { planDedupeOperations, collectOwnedEntries } = require('./dedupe_execution_plan.js')
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
  const currentPaths = await Manga.findAll({ attributes: ['id', 'filepath'], raw: true })
  const planned = planDedupeOperations(duplicateActions, currentPaths)

  const context = createExecutionContext({ executionDir, auditStorePath, executionId, isCancelled })
  const { backupDir, writeActionLog, assertNotCancelled } = context
  const movedFiles = []
  const idMap = {}
  const droppedIds = new Set()
  const collectionIdTargets = new Map()
  const collectionHashTargets = new Map()
  const affectedHashes = new Set(duplicateActions.flatMap(action => action.group.items.map(item => item.hash).filter(Boolean)))
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
      const retainedItems = action.keep ? [action.keep] : action.group.items.filter(item => review.decisions[action.groupId]?.keepIds.includes(String(item.id)))
      const firstItem = retainedItems[0] || action.quarantineItems[0]
      await setProgress({
        phase: 'validating-approvals',
        completed,
        total: totalActions,
        phaseCompleted: completed,
        phaseTotal: totalActions,
        currentItem: { id: String(firstItem.id), title: firstItem.title || path.basename(firstItem.filepath), filepath: firstItem.filepath }
      })
      for (const item of retainedItems) await verify(item)
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
    const participantIds = [...new Set(duplicateActions.flatMap(action => action.group.items.map(item => item.id)))]
    const beforeState = { mangas: await Manga.findAll({ where: { id: { [Op.in]: participantIds } }, raw: true }), metadata: originalMetadataRows,
      collections: collectionList, rendererState }
    const statePath = path.join(executionDir, 'dedupe-state.json')
    await atomicWriteJson(statePath, { executionId, reportId: dedupeReport.reportId, review, before: beforeState })

    completed = 0
    for (const row of planned) {
      const { item, keep, group, mode, equivalent } = row
        assertNotCancelled()
        const currentItem = { id: String(item.id), title: item.title || path.basename(item.filepath), filepath: item.filepath }
        await setProgress({ phase: 'quarantining-files', completed, total: totalActions, phaseCompleted: completed, phaseTotal: totalActions, currentItem })
        const relative = path.relative(library, item.filepath)
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`FILE_OUTSIDE_LIBRARY: ${item.filepath}`)
        const target = ['record-only', 'shared-move'].includes(mode) ? null : await uniqueTargetPath(path.join(quarantineRoot, executionId, relative), item.id)
        await writeActionLog({ status: 'prepared', type: 'quarantine', mode, groupId: group.id, evidenceRevision: group.evidenceRevision,
          reason: review.decisions[group.id]?.reason || '', source: item.filepath, target, bookId: item.id, keepId: keep?.id || null })
        if (mode === 'move') {
          await moveAndVerify(item.filepath, target)
          movedFiles.push({ source: item.filepath, target })
          await writeActionLog({ status: 'file-verified', type: 'quarantine', mode, groupId: group.id, source: item.filepath, target, bookId: item.id, keepId: keep?.id || null })
        } else if (mode === 'split-folder') {
          const owned = await collectOwnedEntries(fs, item.filepath, row.nestedPaths)
          for (const source of owned) {
            const entryTarget = path.join(target, path.relative(item.filepath, source))
            await moveAndVerify(source, entryTarget)
            movedFiles.push({ source, target: entryTarget })
            await writeActionLog({ status: 'file-verified', type: 'quarantine', mode, groupId: group.id, source, target: entryTarget, bookId: item.id, keepId: keep?.id || null })
          }
        }
        if (equivalent) idMap[String(item.id)] = keep.id
        else droppedIds.add(String(item.id))
        collectionIdTargets.set(String(item.id), equivalent ? String(keep.hash || keep.id) : null)
        if (item.hash) {
          if (!collectionHashTargets.has(String(item.hash))) collectionHashTargets.set(String(item.hash), new Set())
          if (equivalent) collectionHashTargets.get(String(item.hash)).add(String(keep.hash || keep.id))
        }
        completed += 1
        await setProgress({ phase: 'quarantining-files', completed, total: totalActions, phaseCompleted: completed, phaseTotal: totalActions, currentItem })
    }

    const mangaTransaction = await Manga.sequelize.transaction()
    const metadataTransaction = await Metadata.sequelize.transaction()
    try {
      for (const action of duplicateActions) {
        assertNotCancelled()
        const keepBook = action.keep ? await Manga.findByPk(action.keep.id, { transaction: mangaTransaction }) : null
        const quarantineIds = action.quarantineItems.map(item => item.id)
        const removedBooks = await Manga.findAll({ where: { id: { [Op.in]: quarantineIds } }, transaction: mangaTransaction })
        if ((action.keep && !keepBook) || removedBooks.length !== quarantineIds.length) throw new Error(`BOOK_SET_CHANGED: ${action.group.id}`)
        const equivalentIds = new Set(planned.filter(row => row.keep?.id === action.keep?.id && row.equivalent).map(row => String(row.item.id)))
        const equivalentBooks = removedBooks.filter(book => equivalentIds.has(String(book.id)))
        if (equivalentBooks.length) {
          const allBooks = [keepBook, ...equivalentBooks]
          await keepBook.update({
            readCount: Math.max(...allBooks.map(book => Number(book.readCount || 0))),
            mark: allBooks.some(book => Boolean(book.mark)),
            hiddenBook: allBooks.every(book => Boolean(book.hiddenBook))
          }, { transaction: mangaTransaction })
        }
        const keepMetadata = keepBook?.hash ? await Metadata.findByPk(keepBook.hash, { transaction: metadataTransaction }) : null
        const effectiveKeeper = keepBook ? mergeEffectiveBook({ manga: keepBook.toJSON(),
          metadata: keepMetadata?.toJSON() || null,
          hashPeers: keepBook.hash ? await Manga.findAll({ where: { hash: keepBook.hash }, raw: true, transaction: mangaTransaction }) : [] }) : null
        await Manga.destroy({ where: { id: { [Op.in]: quarantineIds } }, transaction: mangaTransaction })

        if (keepBook?.hash && await Manga.count({ where: { hash: keepBook.hash }, transaction: mangaTransaction }) === 1) {
          await Metadata.upsert(selectModelFields(Metadata, { ...effectiveKeeper, mark: keepBook.mark }), { transaction: metadataTransaction })
        }
        for (const hash of new Set(action.quarantineItems.map(item => item.hash).filter(Boolean))) {
          if (await Manga.count({ where: { hash }, transaction: mangaTransaction }) === 0) {
            await Metadata.destroy({ where: { hash }, transaction: metadataTransaction })
          }
        }
        await writeActionLog({ status: 'prepared-database', type: 'dedupe', groupId: action.group.id, keepId: keepBook?.id || null, removedIds: quarantineIds })
      }

      const collectionHashMap = new Map()
      for (const [hash, targets] of collectionHashTargets) {
        if (await Manga.count({ where: { hash }, transaction: mangaTransaction })) collectionHashMap.set(hash, hash)
        else collectionHashMap.set(hash, targets.size === 1 ? [...targets][0] : null)
      }
      nextCollections = nextCollections.map(collection => ({ ...collection,
        list: [...new Set((collection.list || []).flatMap(value => {
          const key = String(value)
          if (collectionIdTargets.has(key)) return collectionIdTargets.get(key) ? [collectionIdTargets.get(key)] : []
          if (collectionHashMap.has(key)) return collectionHashMap.get(key) ? [collectionHashMap.get(key)] : []
          return [value]
        }))] }))

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

    const nextRendererState = mergeRendererState(rendererState, idMap, droppedIds)
    const recordOnlyCount = planned.filter(row => ['record-only', 'shared-move'].includes(row.mode)).length
    for (const row of planned.filter(row => ['record-only', 'shared-move'].includes(row.mode))) {
      await writeActionLog({ status: 'record-verified', type: 'quarantine', mode: row.mode, groupId: row.groupId,
        source: row.item.filepath, bookId: row.item.id, keepId: row.keep?.id || null }).catch(() => {})
    }
    await atomicWriteJson(statePath, { executionId, reportId: dedupeReport.reportId, review, before: beforeState,
      after: { mangas: await Manga.findAll({ where: { id: { [Op.in]: participantIds } }, raw: true }), metadata: await snapshotMetadataRows(Metadata, affectedHashes),
        collections: nextCollections, rendererState: nextRendererState }, movedFiles }).catch(async error => {
      await writeActionLog({ status: 'recovery-required', target: statePath, error: error.message }).catch(() => {})
    })
    await setProgress({ phase: 'writing-metadata', completed: totalActions, total: totalActions, phaseCompleted: totalActions, phaseTotal: totalActions, currentItem: null })
    await setProgress({ phase: 'verified', completed: totalActions, total: totalActions, phaseCompleted: totalActions, phaseTotal: totalActions, currentItem: null })
    await writeActionLog({ status: 'verified', taskType: 'dedupe', movedCount: movedFiles.length, recordOnlyCount, repairedCount: 0 }).catch(() => {})
    return {
      success: true,
      taskType: 'dedupe',
      backupDir,
      executionId,
      statePath,
      rendererState: nextRendererState,
      collectionList: nextCollections,
      movedCount: movedFiles.length,
      recordOnlyCount,
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

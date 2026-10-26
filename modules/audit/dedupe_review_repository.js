const path = require('path')
const { readJson, atomicWriteJson, stableId } = require('./utils.js')

const getHistoryPath = storePath => path.join(storePath, 'dedupe-review-history.json')
const loadDedupeDecisions = async (storePath, report) => {
  const history = await readJson(getHistoryPath(storePath), {})
  return Object.fromEntries((report.groups || []).flatMap(group => {
    const previous = history[group.id]
    if (previous?.evidenceRevision === group.evidenceRevision) return [[group.id, previous]]
    // Report revisions 6 and 7 only change how shared pages create groups.
    // Preserve a choice when members and direct relations are unchanged.
    if (previous) {
      for (const version of [6, 5]) {
        const priorRevision = stableId(version, group.items.map(item => [item.id, item.filepath, item.archiveSha256, item.contentProof,
          item.folderFingerprint, item.size, item.mtimeMs, item.sourceEvidence.fingerprint, item.metadataFingerprint,
          item.nestedBookIds.slice().sort()]),
        group.relations.map(({ leftId, rightId, declaredRelation, contentRelation, matchedPages, leftPages, rightPages, sources }) =>
          [leftId, rightId, declaredRelation, contentRelation, matchedPages, leftPages, rightPages, sources]))
        if (previous.evidenceRevision === priorRevision) return [[group.id, { ...previous, evidenceRevision: group.evidenceRevision }]]
      }
    }
    // Version 5 adds direct relation evidence. Unchanged pre-existing duplicate
    // groups keep their review decision when no coverage edge joined them.
    if (!previous || group.relations?.some(relation => relation.category === 'coverage')) return []
    const previousRevision = stableId(4, group.items.map(item => [item.id, item.filepath, item.archiveSha256, item.contentProof,
      item.folderFingerprint, item.size, item.mtimeMs, item.sourceEvidence.fingerprint, item.metadataFingerprint,
      item.nestedBookIds.slice().sort()]))
    return previous.evidenceRevision === previousRevision
      ? [[group.id, { ...previous, evidenceRevision: group.evidenceRevision }]] : []
  }))
}
const saveDedupeDecisions = async (storePath, decisions, groupIds = []) => {
  const history = await readJson(getHistoryPath(storePath), {})
  for (const id of groupIds) delete history[id]
  for (const [id, decision] of Object.entries(decisions || {})) history[id] = decision
  await atomicWriteJson(getHistoryPath(storePath), history)
}
module.exports = { loadDedupeDecisions, saveDedupeDecisions }

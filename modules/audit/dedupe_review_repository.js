const path = require('path')
const { readJson, atomicWriteJson } = require('./utils.js')

const getHistoryPath = storePath => path.join(storePath, 'dedupe-review-history.json')
const loadDedupeDecisions = async (storePath, report) => {
  const history = await readJson(getHistoryPath(storePath), {})
  return Object.fromEntries((report.groups || []).flatMap(group => {
    const previous = history[group.id]
    return previous?.evidenceRevision === group.evidenceRevision ? [[group.id, previous]] : []
  }))
}
const saveDedupeDecisions = async (storePath, decisions, groupIds = []) => {
  const history = await readJson(getHistoryPath(storePath), {})
  for (const id of groupIds) delete history[id]
  for (const [id, decision] of Object.entries(decisions || {})) history[id] = decision
  await atomicWriteJson(getHistoryPath(storePath), history)
}
module.exports = { loadDedupeDecisions, saveDedupeDecisions }

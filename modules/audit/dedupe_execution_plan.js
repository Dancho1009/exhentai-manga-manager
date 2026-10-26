const path = require('path')
const { normalizePath } = require('./utils.js')

const isEligiblePair = (group, removedId, keepId) => (group.equivalenceClasses || []).some(entry =>
  entry.eligible && entry.memberIds.includes(String(removedId)) && entry.memberIds.includes(String(keepId)))

const findEquivalentKeeperId = (group, removedId, keepIds) => {
  const equivalence = (group.equivalenceClasses || []).find(entry => entry.eligible && entry.memberIds.includes(String(removedId)))
  const peers = (keepIds || []).filter(id => equivalence?.memberIds.includes(String(id)))
  return peers.includes(equivalence?.suggestedKeepId) ? equivalence.suggestedKeepId : peers[0] || null
}

// A database row is not necessarily a distinct file. Plan physical ownership
// once for the whole approval, then attach the result to each reviewed row.
const planDedupeOperations = (actions, registeredBooks = []) => {
  const rows = actions.flatMap(action => action.quarantineItems.map(item => ({
    groupId: action.groupId, item, keep: action.keep, group: action.group,
    equivalent: Boolean(action.keep && isEligiblePair(action.group, item.id, action.keep.id))
  })))
  const removedIds = new Set(rows.map(row => String(row.item.id)))
  const owners = new Map()
  const knownBooks = [...registeredBooks, ...actions.flatMap(action => action.group.items || [])]
  for (const book of knownBooks) {
    if (!book.filepath) continue
    const key = normalizePath(book.filepath)
    if (!owners.has(key)) owners.set(key, [])
    if (!owners.get(key).includes(String(book.id))) owners.get(key).push(String(book.id))
  }
  for (const row of rows) {
    const key = normalizePath(row.item.filepath)
    if (!owners.has(key)) owners.set(key, [])
    if (!owners.get(key).includes(String(row.item.id))) owners.get(key).push(String(row.item.id))
  }
  const moverByPath = new Map()
  for (const row of rows) {
    const key = normalizePath(row.item.filepath)
    const retainedOwner = (owners.get(key) || []).some(id => !removedIds.has(id))
    if (retainedOwner) {
      row.mode = 'record-only'
      continue
    }
    if (moverByPath.has(key)) {
      row.mode = 'shared-move'
      row.physicalOwnerId = moverByPath.get(key)
      continue
    }
    moverByPath.set(key, String(row.item.id))
    row.nestedPaths = row.item.type === 'folder' ? [...owners.keys()].filter(other => other.startsWith(key + path.sep)) : []
    row.mode = row.nestedPaths.length ? 'split-folder' : 'move'
  }
  return rows
}

// A registered descendant owns its own path. Move the parent's remaining
// entries, leaving those descendants in place and readable.
const collectOwnedEntries = async (fs, folder, registeredPaths) => {
  const protectedPaths = registeredPaths.map(normalizePath)
  const owned = []
  const visit = async current => {
    for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
      const filepath = path.join(current, entry.name)
      const key = normalizePath(filepath)
      if (protectedPaths.includes(key)) continue
      if (protectedPaths.some(other => other.startsWith(key + path.sep))) {
        if (!entry.isDirectory()) throw new Error('DEDUPE_NESTED_PATH_CHANGED: ' + filepath)
        await visit(filepath)
      } else owned.push(filepath)
    }
  }
  await visit(folder)
  return owned
}

module.exports = { isEligiblePair, findEquivalentKeeperId, planDedupeOperations, collectOwnedEntries }

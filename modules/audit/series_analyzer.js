const { stableId } = require('./utils.js')
const { parseTitleParts, normalizeTitle } = require('./dedupe_title.js')

const localPublications = book => book.semantic?.publications || [book.title, book.title_jpn].filter(Boolean).flatMap(title => parseTitleParts(title).publications)
const effectivePublications = book => Object.hasOwn(book.aiSemantic || {}, 'publication')
  ? book.aiSemantic.publication ? [book.aiSemantic.publication] : [] : localPublications(book)
const publicationNameKey = publication => publication.nameKey || parseTitleParts(`${publication.name} Vol.1`).publications[0]?.nameKey || normalizeTitle(publication.name)
const semanticWarnings = book => (book.aiSemantic?.uncertainties || []).map(reason => `${book.id}: ${reason}`)

// Validated AI metadata supplies publications unknown to the local parser. Adjacent
// periods use one stable representative per issue, keeping this linear in the
// number of known periods instead of comparing every issue/edition pair.
const collectPublicationRelations = books => {
  const publications = new Map()
  for (const book of [...books].sort((left, right) => String(left.id).localeCompare(String(right.id)))) {
    const localPeriods = new Map()
    for (const publication of effectivePublications(book)) {
      if (publication.kind !== 'whole-issue' || !publication.name) continue
      const nameKey = publicationNameKey(publication)
      const issue = String(publication.issue || '').normalize('NFKC').trim().replace(/\s+/g, ' '), date = String(publication.date || '').trim()
      const number = issue.match(/^(\d+)(?:\s*[-~～–—]\s*(\d+))?$/)
      const calendar = date.match(/^(\d{4})-(0[1-9]|1[0-2])$/)
      const aiIssue = Object.hasOwn(book.aiSemantic || {}, 'publication') && issue ? issue.normalize('NFKC').replace(/\s+/g, ' ').toLowerCase() : null
      if (!number && !calendar && !aiIssue) continue
      // An issue number and a publication month can describe the same issue;
      // only compare periods expressed in the same numbering system.
      const family = number ? 'issue' : calendar ? 'date' : 'label'
      const period = number ? number.slice(1).filter(value => value !== undefined).map(Number).join('-') : calendar ? date : aiIssue
      const order = number ? [Number(number[1]), Number(number[2] || number[1])] : calendar ? [Number(calendar[1]), Number(calendar[2])] : [0, 0]
      const key = `${nameKey}:${family}`
      if (!localPeriods.has(key)) localPeriods.set(key, new Map())
      localPeriods.get(key).set(period, { period, order, name: publication.name, id: String(book.id), warnings: semanticWarnings(book), source: Object.hasOwn(book.aiSemantic || {}, 'publication') ? 'AI 刊物语义' : '本地刊物元数据' })
    }
    for (const [key, periods] of localPeriods) {
      // Conflicting title sources cannot establish which issue this file is.
      if (periods.size !== 1) continue
      if (!publications.has(key)) publications.set(key, new Map())
      const entry = [...periods.values()][0]
      if (!publications.get(key).has(entry.period)) publications.get(key).set(entry.period, entry)
    }
  }
  const relations = new Map()
  for (const [, periodMap] of [...publications].sort(([left], [right]) => left.localeCompare(right))) {
    const periods = [...periodMap.values()].sort((left, right) => left.order[0] - right.order[0] || left.order[1] - right.order[1] || left.period.localeCompare(right.period) || left.id.localeCompare(right.id))
    for (let index = 1; index < periods.length; index++) {
      const left = periods[index - 1], right = periods[index]
      if (left.id === right.id) continue
      const key = JSON.stringify([left.id, right.id].sort())
      const source = left.source === right.source ? left.source : '刊物元数据与 AI 语义'
      const warnings = [...new Set([...left.warnings, ...right.warnings])]
      relations.set(key, { leftId: left.id, rightId: right.id, relation: 'same_publication_different_issue',
        reason: `${source}：${left.name} ${left.period} 与 ${right.period} 是不同期次，仅作刊物关系展示。${warnings.length ? '\n待确认：' + warnings.join('；') : ''}`, evidenceRefs: [] })
    }
  }
  return [...relations.values()]
}

const wholeIssue = book => effectivePublications(book).some(publication => publication.kind === 'whole-issue')
const workOrdinal = (book, field) => Object.hasOwn(book.aiSemantic || {}, field) ? book.aiSemantic[field] : book.semantic?.[field] ||
  [book.title, book.title_jpn].filter(Boolean).map(title => parseTitleParts(title)[field]).find(Boolean) || null
const orderMembers = (left, right) => {
  for (const field of ['volume', 'chapter']) {
    const a = workOrdinal(left, field)?.start, b = workOrdinal(right, field)?.start
    if (a !== undefined || b !== undefined) {
      if (a === undefined) return 1
      if (b === undefined) return -1
      if (a !== b) return a - b
    }
  }
  return String(left.id).localeCompare(String(right.id))
}
const groupTitle = members => {
  const counts = new Map()
  for (const member of members) {
    const title = member.aiSemantic?.seriesTitle || parseTitleParts(member.title_jpn || member.title || '').body || '未命名系列'
    counts.set(title, (counts.get(title) || 0) + 1)
  }
  return [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0][0]
}

const buildSeriesReport = ({ books, relations }) => {
  const byId = new Map(books.map(book => [String(book.id), book]))
  const parent = new Map([...byId.keys()].map(id => [id, id]))
  const find = id => { const root = parent.get(id); if (root !== id) parent.set(id, find(root)); return parent.get(id) }
  const seriesRelations = [], publicationRelations = [], uncertainRelations = []
  for (const relation of relations) {
    const left = byId.get(relation.leftId), right = byId.get(relation.rightId)
    if (!left || !right || relation.leftId === relation.rightId) throw new Error('INVALID_SERIES_RELATION_MEMBERS')
    if (relation.relation === 'same_publication_different_issue') publicationRelations.push(relation)
    else if (relation.relation === 'unknown') uncertainRelations.push(relation)
    else if (relation.relation === 'same_series_different_part') {
      if (wholeIssue(left) || wholeIssue(right)) uncertainRelations.push({ ...relation, relation: 'unknown', reason: '杂志期次不能作为作品系列关系。' })
      else {
        seriesRelations.push(relation)
        parent.set(find(relation.leftId), find(relation.rightId))
      }
    }
  }
  const grouped = new Map()
  for (const relation of seriesRelations) {
    const root = find(relation.leftId)
    if (!grouped.has(root)) grouped.set(root, [])
    grouped.get(root).push(relation)
  }
  const groups = []
  for (const edges of grouped.values()) {
    const memberIds = [...new Set(edges.flatMap(relation => [relation.leftId, relation.rightId]))].sort()
    const ids = new Set(memberIds)
    if (relations.some(relation => relation.relation === 'unrelated' && ids.has(relation.leftId) && ids.has(relation.rightId))) {
      uncertainRelations.push(...edges.map(relation => ({ ...relation, relation: 'unknown', reason: '本组同时存在互相矛盾的系列与无关判断，需要人工确认。' })))
      continue
    }
    const members = memberIds.map(id => byId.get(id)).sort(orderMembers)
    const uncertainties = members.flatMap(semanticWarnings)
    for (const member of members) {
      if (!workOrdinal(member, 'chapter') && !workOrdinal(member, 'volume')) uncertainties.push(`${member.id}: 作品卷话未标注，未推断为第1话。`)
      if (member.semantic?.ordinalConflict) uncertainties.push(`${member.id}: 本地卷话信息存在冲突。`)
    }
    const confirmedPairs = new Set(relations.filter(relation => ids.has(relation.leftId) && ids.has(relation.rightId) &&
      ['same_series_different_part', 'same_work_same_part', 'same_work_different_edition'].includes(relation.relation))
      .map(relation => JSON.stringify([relation.leftId, relation.rightId].sort())))
    if (confirmedPairs.size < members.length * (members.length - 1) / 2) uncertainties.push('部分成员仅通过其他成员关联；未逐对确认的关系仍未知。')
    groups.push({ id: stableId('ai-series-suggestion', memberIds), title: groupTitle(members), members, relations: edges, uncertainties: [...new Set(uncertainties)] })
  }
  return { groups: groups.sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id)), publicationRelations, uncertainRelations }
}

module.exports = { buildSeriesReport, collectPublicationRelations }

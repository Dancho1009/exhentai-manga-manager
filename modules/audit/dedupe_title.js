const path = require('path')
const { parseTags } = require('./utils.js')

const DEDUPE_RULES_VERSION = 2
const normalizeTitle = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
const publicationNameKey = name => {
  const key = normalizeTitle(name)
  return ({ コミックメガストア: 'comicmegastore', ダスコミ: 'dascomi' })[key] || key
}
const isPublicationName = name => /^(?:comic\b|コミック|雑誌|magazine\b|dascomi\b|ダスコミ)/i.test(name.trim())
const parsePublication = (text, kind) => {
  const match = text.trim().match(/^(.*?)\s*(?:(?:\bvol(?:ume)?|\bno|\bissue)\.?\s*(\d+(?:\s*[-~～–—]\s*\d+)?)|第?\s*(\d+)\s*号|((?:19|20)\d{2})\s*[-/.年]\s*(\d{1,2})(?:\s*月(?:号)?)?)\s*$/i)
  if (!match || !isPublicationName(match[1])) return null
  const issue = match[2] ? match[2].split(/\s*[-~～–—]\s*/).map(Number).join('-') : match[3] ? String(Number(match[3])) : null
  const date = match[4] ? `${match[4]}-${String(Number(match[5])).padStart(2, '0')}` : null
  return { kind, name: match[1].trim(), nameKey: publicationNameKey(match[1]), issue, date, rawText: text.trim() }
}

const parseTitleParts = (value, origin = 'title') => {
  const original = String(value || '').normalize('NFKC')
  let text = original.replace(/^\d{4,}[-_\s]+/, '').trim()
  text = text.replace(/^\((?:C\d+|COMITIA[^)]*|[^)]*(?:同人|コミケ|Comic Market)[^)]*)\)\s*/i, '')
  const creator = text.match(/^\[([^\]]+)\]/)?.[1] || ''
  text = text.replace(/^\[[^\]]*\]\s*/, '').replace(/\[[^\]]*\]/g, '').trim()
  const publication = parsePublication(text, 'whole-issue')
  if (publication) return { origin, original, body: text, creator, chapter: null, volume: null, publications: [publication],
    key: `publication:${publication.nameKey}:${publication.issue || publication.date}` }

  const publications = [], qualifiers = []
  // Only top-level work text supplies a chapter/volume. Parentheses remain
  // opaque unless their entire contents identify a publication and period.
  let topLevel = '', depth = 0, parenthetical = ''
  for (const character of text) {
    if (character === '(') { if (depth++ > 0) parenthetical += character }
    else if (character === ')' && depth) {
      if (--depth) parenthetical += character
      else {
        const publishedIn = parsePublication(parenthetical, 'embedded')
        if (publishedIn) publications.push(publishedIn)
        else qualifiers.push(parenthetical)
        parenthetical = ''; topLevel += ' '
      }
    } else if (depth) parenthetical += character
    else topLevel += character
  }
  if (depth) qualifiers.push(parenthetical)
  const ordinals = []
  const number = '(\\d+(?:\\.\\d+)?)(?:\\s*[-~～–—]\\s*(\\d+(?:\\.\\d+)?))?'
  const english = new RegExp('(?<![a-z])(?:ch(?:apter)?|ep(?:isode)?|vol(?:ume)?)\\.?\\s*' + number + '(?!\\d)', 'ig')
  const japanese = new RegExp('第?\\s*' + number + '\\s*(話|话|章|巻|卷)', 'g')
  const record = (kind, start, end) => ordinals.push({ kind, start: Number(start), end: end ? Number(end) : null })
  let body = topLevel.replace(english, (raw, start, end) => { record(/^vol/i.test(raw) ? 'volume' : 'chapter', start, end); return ' ' })
  body = body.replace(japanese, (_raw, start, end, unit) => { record(/[巻卷]/.test(unit) ? 'volume' : 'chapter', start, end); return ' ' })
  body = body.replace(/(?:^|\s)#\s*(\d+)(?:\s*[-~～–—]\s*(\d+))?/g, (_raw, start, end) => { record('chapter', start, end); return ' ' })
  const unique = [...new Map(ordinals.map(item => [`${item.kind}:${item.start}:${item.end}`, item])).values()]
  const values = kind => unique.filter(item => item.kind === kind).map(({ start, end }) => ({ start, end }))
  const chapters = values('chapter'), volumes = values('volume')
  const key = `${normalizeTitle(body + qualifiers.map(text => `(${text})`).join(''))}|${unique.map(item => `${item.kind}:${item.start}${item.end === null ? '' : '-' + item.end}`).sort().join('|') || 'unmarked'}`
  return { origin, original, body: body.trim(), creator, publications, qualifiers,
    chapter: chapters.length === 1 ? chapters[0] : null, volume: volumes.length === 1 ? volumes[0] : null,
    ordinalConflict: chapters.length > 1 || volumes.length > 1, key }
}

const parseBookSemantics = wrapped => {
  const tags = parseTags(wrapped.effective.tags)
  const filename = path.basename(wrapped.raw.filepath).replace(/\.(zip|cbz|rar|cbr|7z|cb7)$/i, '')
  const parts = [[wrapped.effective.title_jpn, 'title_jpn'], [wrapped.effective.title, 'title'], [filename, 'filename']]
    .filter(([title]) => title).map(([title, origin]) => parseTitleParts(title, origin))
  const aggregate = field => {
    const items = [...new Map(parts.filter(part => part[field]).map(part => [JSON.stringify(part[field]), part[field]])).values()]
    return { value: items.length === 1 ? items[0] : null, conflict: items.length > 1 }
  }
  const chapter = aggregate('chapter'), volume = aggregate('volume')
  const publications = [...new Map(parts.flatMap(part => part.publications).map(item => [`${item.kind}:${item.nameKey}:${item.issue || item.date}`, item])).values()]
  const text = [filename, wrapped.effective.title, wrapped.effective.title_jpn, ...(tags.misc || [])].join(' ')
  const creator = parts.find(part => part.creator)?.creator
  const artists = tags.artist?.length ? tags.artist : creator ? [creator] : tags.group || []
  const languages = tags.language?.length ? tags.language : /汉化|漢化|chinese|中国語|中国翻訳/i.test(text) ? ['chinese'] : /english|英訳/i.test(text) ? ['english'] : []
  return { version: DEDUPE_RULES_VERSION, titles: [...new Set(parts.map(part => part.key).filter(key => !key.startsWith('|')))],
    artists, languages, chapter: chapter.value, volume: volume.value, publications,
    ordinalConflict: chapter.conflict || volume.conflict || parts.some(part => part.ordinalConflict), titleParts: parts,
    versions: [/\bdigital\b|DL版|電子版/i.test(text) ? 'digital' : '', /\b(?:uncensored|decensored)\b|無修正|无修正/i.test(text) ? 'uncensored' : '',
      /\bcolou?ri[sz]ed\b|カラー化|着色|上色/i.test(text) ? 'colorized' : ''].filter(Boolean) }
}

module.exports = { DEDUPE_RULES_VERSION, normalizeTitle, parseTitleParts, parseBookSemantics }

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { parseTitleParts, parseBookSemantics, DEDUPE_RULES_VERSION } = require('../modules/audit/dedupe_title.js')
const { AuditReportRepository } = require('../modules/audit/report_repository.js')
const { AuditWorkspaceManager } = require('../modules/audit/job_manager.js')
const { LibraryTaskCoordinator } = require('../modules/audit/task_coordinator.js')
const { createFixture, scan } = require('./fixtures/dedupe-fixture.cjs')

const book = (id, title, extra = {}) => ({ raw: { id, title, filepath: `C:/fixture/${id}.zip`, type: 'zip', url: '', hash: null, bundleSize: 100 },
  effective: { title, url: '', tags: { artist: ['same-artist'] } }, ...extra })

test('a short story magazine qualifier is published-in information, never a work volume or implied chapter one', () => {
  const title = '[ぐすたふ] 君は輝く月花のように (コミックメガストア Vol.13) [中国翻訳]'
  const semantic = parseBookSemantics(book('a', title))
  assert.equal(semantic.chapter, null)
  assert.equal(semantic.volume, null)
  assert.equal(semantic.publications[0].kind, 'embedded')
  assert.equal(semantic.publications[0].issue, '13')
  assert.deepEqual(semantic.languages, ['chinese'])
  const later = parseTitleParts('[ぐすたふ] 君は輝く月花のように 第3話 (コミックメガストア Vol.16) [中国翻訳]')
  assert.deepEqual(later.chapter, { start: 3, end: null })
  assert.equal(later.volume, null)
  assert.equal(later.publications[0].issue, '16')
  assert.notEqual(later.key, semantic.titles[0])
})

test('chapter notation and zero padding normalize while real volumes, ranges and dates stay distinct', () => {
  const variants = ['Title Ch.01', 'Title Chapter 1', 'Title 第1話', 'Title 第1话']
  assert.equal(new Set(variants.map(title => parseTitleParts(title).key)).size, 1)
  assert.notEqual(parseTitleParts('Title 第1話').key, parseTitleParts('Title 第2話').key)
  assert.notEqual(parseTitleParts('Title 第1話').key, parseTitleParts('Title 第1卷').key)
  assert.notEqual(parseTitleParts('Title').key, parseTitleParts('Title Ch.1').key)
  assert.deepEqual(parseTitleParts('Title Ch.1–3').chapter, { start: 1, end: 3 })
  assert.deepEqual(parseTitleParts('Title Vol.2').volume, { start: 2, end: null })
  assert.equal(parseTitleParts('Title 2023-08').chapter, null)
})

test('unknown parenthetical context is preserved and cannot supply work ordinals', () => {
  const parsed = parseTitleParts('Title (Unrecognized Publisher Vol.13)')
  assert.equal(parsed.volume, null)
  assert.deepEqual(parsed.qualifiers, ['Unrecognized Publisher Vol.13'])
  assert.notEqual(parsed.key, parseTitleParts('Title').key)
  assert.notEqual(parseTitleParts('Title (Subtitle A)').key, parseTitleParts('Title (Subtitle B)').key)
  const conflict = parseBookSemantics({ ...book('a', 'Title Ch.2'), raw: { ...book('a', '').raw, filepath: 'C:/fixture/Title Ch.3.zip' } })
  assert.equal(conflict.ordinalConflict, true)
})

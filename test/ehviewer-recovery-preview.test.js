const test = require('node:test')
const assert = require('node:assert/strict')
const { readEhviewerBuffer } = require('../fileLoader/ehviewer.js')

const loadPreviewHelpers = () => import('../src/audit/ehviewerRecoveryPreview.mjs')

test('builds a VERSION2 .ehviewer preview from current E-Hentai metadata', async () => {
  const { buildEhviewerRecoveryPreview } = await loadPreviewHelpers()
  const preview = buildEhviewerRecoveryPreview({
    url: 'https://exhentai.org/g/4055722/D7DF36FF21/',
    title: 'Example\nGallery'
  })

  assert.deepEqual(preview, {
    format: 'VERSION2',
    sourceUrl: 'https://exhentai.org/g/4055722/D7DF36FF21/',
    title: 'Example Gallery',
    gid: '4055722',
    token: 'd7df36ff21',
    content: 'VERSION2\nExample Gallery\n4055722\nd7df36ff21\n'
  })
  assert.deepEqual(readEhviewerBuffer(Buffer.from(preview.content, 'utf8')), {
    gid: '4055722',
    token: 'd7df36ff21'
  })
})

test('does not build a recovery preview from unrelated or malformed URLs', async () => {
  const { buildEhviewerRecoveryPreview } = await loadPreviewHelpers()
  assert.equal(buildEhviewerRecoveryPreview({ url: 'https://nhentai.net/g/4055722/' }), null)
  assert.equal(buildEhviewerRecoveryPreview({ url: 'https://exhentai.org/g/not-a-gid/token/' }), null)
  assert.equal(buildEhviewerRecoveryPreview({ url: 'ftp://exhentai.org/g/4055722/d7df36ff21/' }), null)
  assert.equal(buildEhviewerRecoveryPreview({ url: '' }), null)
})

const test = require('node:test')
const assert = require('node:assert/strict')
const { returnTrimFileName } = require('../modules/search_title.js')

test('returnTrimFileName matches metadata search cleanup for archives', () => {
  assert.equal(
    returnTrimFileName({
      filepath: 'C:\\Library\\sample [DL版].zip',
      type: 'zip'
    }, {
      trimTitleRegExp: '\\s*\\[DL版\\]$',
      searchKeySuffix: 'nhentai'
    }),
    'sample nhentai'
  )
})

test('returnTrimFileName keeps the folder name extension behavior', () => {
  assert.equal(
    returnTrimFileName({
      filepath: 'C:\\Library\\sample.folder',
      type: 'folder'
    }),
    'sample.folder'
  )
})

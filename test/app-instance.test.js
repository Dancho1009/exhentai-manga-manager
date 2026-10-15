const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

test('a duplicate app exits before loading code that opens the profile or LAN server', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')
  const loaded = []
  let quitCount = 0
  vm.runInNewContext(`(function () { ${source}\n})()`, {
    require: name => {
      loaded.push(name)
      assert.equal(name, 'electron', 'A duplicate must not initialize storage, logs or other application modules')
      return { app: { requestSingleInstanceLock: () => false, quit: () => { quitCount += 1 } } }
    }
  })
  assert.deepEqual(loaded, ['electron'])
  assert.equal(quitCount, 1)
})

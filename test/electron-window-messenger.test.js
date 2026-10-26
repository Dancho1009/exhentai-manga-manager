const test = require('node:test')
const assert = require('node:assert/strict')
const { createWindowMessenger, safeSend } = require('../modules/electron_window_messenger.js')

const windowFixture = ({ loading = false, destroyed = false, frameDestroyed = false, send = () => {} } = {}) => {
  const contents = {
    isDestroyed: () => destroyed,
    isLoadingMainFrame: () => loading,
    mainFrame: { isDestroyed: () => frameDestroyed },
    send
  }
  return { isDestroyed: () => destroyed, webContents: contents }
}

test('safeSend skips unavailable windows and sends normal frames', () => {
  const calls = []
  const win = windowFixture({ send: (...args) => calls.push(args) })
  assert.equal(safeSend(win, 'audit:state', { completed: 1 }), true)
  assert.deepEqual(calls, [['audit:state', { completed: 1 }]])
  assert.equal(safeSend(windowFixture({ frameDestroyed: true }), 'audit:state', {}), false)
  assert.equal(safeSend(windowFixture({ loading: true }), 'audit:state', {}), false)
})

test('disposed frame errors are isolated from the background task', () => {
  const win = windowFixture({ send: () => { throw new Error('Render frame was disposed before WebFrameMain could be accessed') } })
  assert.equal(safeSend(win, 'audit:state', {}), false)
})

test('messenger retains the latest state during reload and flushes it after load', () => {
  const calls = []
  const win = windowFixture({ send: (...args) => calls.push(args) })
  const messenger = createWindowMessenger({ getWindow: () => win })
  messenger.markLoading()
  assert.equal(messenger.send('audit:state', { completed: 1 }), false)
  assert.deepEqual(messenger.pendingChannels(), ['audit:state'])
  messenger.markReady()
  assert.deepEqual(calls, [['audit:state', { completed: 1 }]])
  assert.equal(messenger.isReady(), true)
  messenger.dispose()
  assert.equal(messenger.send('audit:state', { completed: 2 }), false)
})

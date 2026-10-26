const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { performance } = require('node:perf_hooks')
const { DEV_HOST, DEV_PORT, CONNECT_TIMEOUT_MS, checkDevPort, probeExitCode } = require('../scripts/check-dev-port.cjs')

const listen = () => new Promise((resolve, reject) => {
  const server = net.createServer(socket => socket.end())
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(server))
})
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))

test('development port detection uses IPv4 and a 200 ms deadline', () => {
  assert.equal(DEV_HOST, '127.0.0.1')
  assert.equal(DEV_PORT, 15374)
  assert.equal(CONNECT_TIMEOUT_MS, 200)
})

test('development port detection succeeds for a real local listening socket', async t => {
  const server = await listen()
  t.after(() => close(server))
  assert.equal(await checkDevPort({ port: server.address().port }), true)
})

test('development port detection fails quickly for a verified unbound local port', async () => {
  const server = await listen()
  const port = server.address().port
  await close(server)
  const started = performance.now()
  assert.equal(await checkDevPort({ port }), false)
  assert.ok(performance.now() - started < 1000, 'an unused port must not wait through the Windows TCP retry interval')
})

test('development port detection times out and destroys a connection that never responds', async () => {
  const socket = new EventEmitter()
  let destroyed = false
  socket.destroy = () => { destroyed = true }
  const started = performance.now()
  assert.equal(await checkDevPort({ timeoutMs: 30, connect: () => socket }), false)
  const elapsed = performance.now() - started
  assert.ok(elapsed >= 20 && elapsed < 1000, `unexpected bounded wait: ${elapsed} ms`)
  assert.equal(destroyed, true)
  socket.emit('connect')
  socket.emit('error', new Error('late network failure'))
})

test('development port detection distinguishes waiting from an exited Vite process', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-port-probe-'))
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const pidFile = path.join(root, 'vite.pid')
  fs.writeFileSync(pidFile, String(process.pid))
  assert.equal(await probeExitCode({ pidFile, probe: async () => false }), 1)
  fs.writeFileSync(pidFile, 'not a pid')
  assert.equal(await probeExitCode({ pidFile, probe: async () => false }), 2)
  assert.equal(await probeExitCode({ pidFile, probe: async () => true }), 0)
  assert.equal(await probeExitCode({ probe: async () => false }), 1)
})

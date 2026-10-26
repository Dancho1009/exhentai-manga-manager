const net = require('node:net')
const fs = require('node:fs')

const DEV_HOST = '127.0.0.1'
const DEV_PORT = 15374
const CONNECT_TIMEOUT_MS = 200

const checkDevPort = ({ host = DEV_HOST, port = DEV_PORT, timeoutMs = CONNECT_TIMEOUT_MS, connect = net.createConnection } = {}) => new Promise(resolve => {
  let socket
  let settled = false
  const finish = open => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    socket?.destroy()
    resolve(open)
  }
  // A wall-clock deadline also bounds a connection that never emits an error.
  const timer = setTimeout(() => finish(false), timeoutMs)
  try {
    socket = connect({ host, port })
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('close', () => finish(false))
  } catch { finish(false) }
})

const checkPidFile = filename => {
  let pid
  try { pid = Number(fs.readFileSync(filename, 'utf8').trim()) } catch { return false }
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true }
  catch (error) { return error.code === 'EPERM' }
}

const probeExitCode = async ({ pidFile, probe = checkDevPort } = {}) => {
  if (await probe()) return 0
  return pidFile && !checkPidFile(pidFile) ? 2 : 1
}

if (require.main === module) {
  probeExitCode({ pidFile: process.argv[2] === '--pid-file' ? process.argv[3] : null })
    .then(code => { process.exitCode = code })
    .catch(() => { process.exitCode = 2 })
}

module.exports = { DEV_HOST, DEV_PORT, CONNECT_TIMEOUT_MS, checkDevPort, checkPidFile, probeExitCode }

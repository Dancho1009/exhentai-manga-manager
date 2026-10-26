const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const runLauncher = (t, { ready = false, repair = 'success', portState = 'ready' } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manga-launcher-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const bin = path.join(root, 'bin')
  const dependencies = path.join(root, 'node_modules', '.bin')
  fs.mkdirSync(bin)
  fs.mkdirSync(dependencies, { recursive: true })
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.writeFileSync(path.join(root, 'scripts', 'check-dev-port.cjs'), `
    const fs = require('fs')
    fs.appendFileSync('launcher.log', 'port-check\\n')
    if (process.env.LAUNCHER_PORT_STATE === 'ready') process.exit(0)
    if (!fs.existsSync('port-checked')) { fs.writeFileSync('port-checked', ''); process.exit(1) }
    process.exit(process.env.LAUNCHER_PORT_STATE === 'dead' ? 2 : 0)
  `)
  // CALL lets the PowerShell .cmd stub return like the real executable.
  const launcher = fs.readFileSync(path.join(__dirname, '..', 'start-dev.bat'), 'utf8')
  fs.writeFileSync(path.join(root, 'start-dev.bat'), launcher.replace(/\bpowershell\b/g, 'call powershell'))
  fs.writeFileSync(path.join(root, 'package.json'), '{}')
  fs.writeFileSync(path.join(root, 'secret_key.json'), '{}')
  if (ready) fs.writeFileSync(path.join(root, 'sqlite-ready'), '')

  const writeBatch = (filename, lines) => fs.writeFileSync(filename, ['@echo off', ...lines, ''].join('\r\n'))
  writeBatch(path.join(dependencies, 'vite.cmd'), ['exit /b 0'])
  writeBatch(path.join(dependencies, 'electron.cmd'), [
    'echo sqlite-check>>launcher.log',
    'if not "%~1"=="-e" exit /b 2',
    'if not "%ELECTRON_RUN_AS_NODE%"=="1" exit /b 3',
    'if exist sqlite-ready exit /b 0',
    'exit /b 1'
  ])
  writeBatch(path.join(bin, 'powershell.cmd'), ['echo powershell-launch>>launcher.log', 'exit /b 0'])
  writeBatch(path.join(bin, 'npm.cmd'), [
    'echo npm %*>>launcher.log',
    'if "%~1"=="rebuild" goto rebuild',
    'if "%~1 %~2"=="run start" goto start',
    'exit /b 9',
    ':rebuild',
    'if not "%~2"=="sqlite3" exit /b 9',
    'if "%LAUNCHER_REPAIR%"=="failed" exit /b 7',
    'if "%LAUNCHER_REPAIR%"=="success" type nul >sqlite-ready',
    'exit /b 0',
    ':start',
    'if defined ELECTRON_RUN_AS_NODE exit /b 8',
    'type nul >app-started',
    'exit /b 0'
  ])

  const env = { ...process.env, LAUNCHER_REPAIR: repair, LAUNCHER_PORT_STATE: portState }
  const originalPath = env.Path || env.PATH || ''
  delete env.Path
  env.PATH = `${bin};${originalPath}`
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start-dev.bat'], {
    cwd: root,
    env,
    input: '\r\n',
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true
  })
  assert.ifError(result.error)
  return {
    ...result,
    log: fs.readFileSync(path.join(root, 'launcher.log'), 'utf8'),
    started: fs.existsSync(path.join(root, 'app-started'))
  }
}

test('launcher skips repair when SQLite loads in Electron', { skip: process.platform !== 'win32' }, t => {
  const result = runLauncher(t, { ready: true })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(result.started, true, result.stdout + result.stderr + result.log)
  assert.equal(result.log.includes('npm rebuild'), false)
  assert.equal(result.log.split('sqlite-check').length - 1, 1)
})

test('launcher repairs missing SQLite before starting Electron', { skip: process.platform !== 'win32' }, t => {
  const result = runLauncher(t)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(result.started, true, result.stdout + result.stderr + result.log)
  assert.match(result.log, /sqlite-check[\s\S]*npm rebuild sqlite3[\s\S]*sqlite-check[\s\S]*npm run start/)
})

test('launcher uses the Node port probe and starts Vite with one PowerShell invocation', { skip: process.platform !== 'win32' }, t => {
  const result = runLauncher(t, { ready: true, portState: 'starts' })
  assert.equal(result.status, 0, result.stdout + result.stderr + result.log)
  assert.equal(result.started, true)
  assert.equal(result.log.split('port-check').length - 1, 2)
  assert.equal(result.log.split('powershell-launch').length - 1, 1)
  assert.match(result.stdout, /Waiting for http:\/\/127\.0\.0\.1:15374/)
})

test('launcher stops if the port probe reports that Vite exited', { skip: process.platform !== 'win32' }, t => {
  const result = runLauncher(t, { ready: true, portState: 'dead' })
  assert.equal(result.status, 1, result.stdout + result.stderr + result.log)
  assert.equal(result.started, false)
  assert.match(result.stdout, /Vite exited before port 15374 became ready/)
  assert.equal(result.log.includes('npm run start'), false)
})

for (const repair of ['failed', 'unrepaired']) {
  test(`launcher stops when SQLite repair is ${repair}`, { skip: process.platform !== 'win32' }, t => {
    const result = runLauncher(t, { repair })
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.equal(result.started, false)
    assert.match(result.stdout, /SQLite native dependency repair failed/)
    assert.equal(result.log.includes('npm run start'), false)
  })
}

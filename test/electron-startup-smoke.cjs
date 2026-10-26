// node test/electron-startup-smoke.cjs [temporary-output-directory]
// Runs production Electron window creation/preload/HTML against a delayed local
// Vue fixture. Each scenario gets a new empty profile; no installed app, real
// library, dev-server port or visible native window is used.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { EventEmitter } = require('node:events')

const projectRoot = path.resolve(__dirname, '..')
const outputRoot = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'emm-startup-electron-')))
const scenarioName = process.argv[3]
const scenarios = {
  normal: { language: 'zh-CN', theme: 'dark exhentai', title: '正在启动…', background: 'rgb(52, 53, 59)' },
  minimized: { language: 'en-US', theme: 'light e-hentai', title: 'Starting…', background: 'rgb(226, 224, 210)', minimizeOnStart: true },
  tray: { language: 'zh-TW', theme: 'dark nhentai', title: '正在啟動…', background: 'rgb(13, 13, 13)', minimizeOnStart: true, minimizeToTray: true },
  'user-minimized': { language: 'en-US', theme: 'light', title: 'Starting…', background: 'rgb(255, 255, 255)', userMinimize: true },
  'close-main': { language: 'zh-CN', theme: 'dark exhentai', title: '正在启动…', background: 'rgb(52, 53, 59)', minimizeToTray: true, closeMain: true },
  'close-to-tray': { language: 'zh-CN', theme: 'dark exhentai', title: '正在启动…', background: 'rgb(52, 53, 59)', closeToTray: true, closeMain: true }
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitUntil = async (read, label, timeout = 20000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await wait(50)
  }
  throw new Error('Timed out: ' + label)
}

const supervise = async () => {
  fs.mkdirSync(outputRoot, { recursive: true })
  let electronPath
  if (process.versions.electron) {
    const { app } = require('electron')
    const supervisorProfile = path.join(outputRoot, 'supervisor-profile')
    fs.mkdirSync(supervisorProfile, { recursive: true })
    app.setPath('userData', supervisorProfile)
    app.setPath('sessionData', path.join(supervisorProfile, 'browser-session'))
    electronPath = process.execPath
  } else electronPath = require('electron')
  const results = []
  for (const name of Object.keys(scenarios)) {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    await new Promise((resolve, reject) => {
      const child = spawn(electronPath, [__filename, outputRoot, name], { cwd: projectRoot, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', chunk => { output += chunk.toString() })
      child.stderr.on('data', chunk => { output += chunk.toString() })
      child.once('error', reject)
      child.once('close', code => {
        if (code === 0) { console.log('STARTUP_SCENARIO_OK ' + name); resolve() }
        else reject(new Error(`Startup scenario ${name} exited ${code}\n${output}`))
      })
    })
    results.push(JSON.parse(fs.readFileSync(path.join(outputRoot, name, 'validation.json'), 'utf8')))
  }
  fs.writeFileSync(path.join(outputRoot, 'startup-electron-validation.json'), JSON.stringify({ success: true, results }, null, 2))
  console.log('ELECTRON_STARTUP_SMOKE_OK ' + outputRoot)
  if (process.versions.electron) require('electron').app.exit(0)
}

const runScenario = async () => {
  assert.ok(process.versions.electron, 'Scenario must run in Electron')
  const scenario = scenarios[scenarioName]
  assert.ok(scenario, 'Unknown startup scenario')
  const electron = require('electron')
  const { app, session } = electron
  const scenarioRoot = path.join(outputRoot, scenarioName)
  const profile = path.join(scenarioRoot, 'profile')
  assert.ok(!fs.existsSync(profile), 'Use a fresh output directory; never reuse a live or existing profile')
  assert.ok(!fs.existsSync(path.join(projectRoot, 'data')) && !fs.existsSync(path.join(projectRoot, 'portable')), 'This isolated smoke test requires a non-portable checkout')
  fs.mkdirSync(profile, { recursive: true })
  app.setPath('userData', profile)
  app.setPath('sessionData', path.join(profile, 'browser-session'))
  require('../modules/utils.js').getRootPath = () => projectRoot
  const { prepareSetting, STORE_PATH } = require('../modules/init_folder_setting.js')
  assert.equal(STORE_PATH, profile)
  const library = path.join(profile, 'Library')
  fs.mkdirSync(library)
  const setting = { ...prepareSetting(), library, metadataPath: profile, language: scenario.language, theme: scenario.theme,
    loadOnStart: false, autoCheckUpdates: false, enabledLANBrowsing: false, proxy: '', startOnLogin: false,
    minimizeOnStart: Boolean(scenario.minimizeOnStart), minimizeToTray: Boolean(scenario.minimizeToTray), closeToTray: Boolean(scenario.closeToTray) }
  fs.writeFileSync(path.join(profile, 'setting.json'), JSON.stringify(setting, null, 2))
  fs.writeFileSync(path.join(profile, 'collectionList.json'), '[]')
  fs.writeFileSync(path.join(profile, '.startup-smoke-fixture'), 'Isolated startup test; no user library data.')

  const actions = [], requests = [], unexpectedRequests = [], screenshots = []
  let main, server, moduleMode = 'hold', heldModule, readyCount = 0, trayCount = 0
  let logicalVisible = false, logicalMinimized = false
  const record = (name, extra = {}) => actions.push({ name, readyCount, ...extra })
  // Native operations are replaced on only this test process's windows. Tray
  // construction is replaced before the production module destructures it.
  class FixtureTray extends EventEmitter {
    constructor () { super(); trayCount++; record('tray-created') }
    setToolTip () {}
    setContextMenu () {}
    destroy () {}
  }
  const fixtureElectron = Object.create(electron)
  Object.defineProperty(fixtureElectron, 'Tray', { value: FixtureTray })
  app.on('browser-window-created', (_event, win) => {
    if (main) {
      assert.ok(scenario.closeMain, 'Other scenarios should create only the main window')
      const loadURL = win.loadURL.bind(win)
      win.loadURL = value => {
        const requested = new URL(value)
        assert.equal(requested.hostname, 'localhost')
        assert.equal(requested.port, '15374')
        assert.ok(['/audit.html', '/ai-inspector.html'].includes(requested.pathname))
        return loadURL(baseUrl + requested.pathname)
      }
      return
    }
    main = win
    win.webContents.setBackgroundThrottling(false)
    win.webContents.debugger.attach('1.3')
    win.on('ready-to-show', () => { readyCount++; record('ready-to-show') })
    win.show = () => {
      logicalVisible = true; record('show'); win.emit('show')
      if (scenario.userMinimize && !actions.some(action => action.name === 'user-minimize')) {
        record('user-minimize'); win.minimize()
      }
    }
    win.hide = () => { logicalVisible = false; record('hide') }
    win.focus = () => record('focus')
    win.minimize = () => {
      logicalMinimized = true; record('minimize')
      win.emit('minimize', { preventDefault () {} })
    }
    win.restore = () => { logicalMinimized = false; record('restore'); win.emit('restore') }
    win.isVisible = () => logicalVisible
    win.isMinimized = () => logicalMinimized
    win.setSkipTaskbar = value => record('skip-taskbar', { value })
    const loadURL = win.loadURL.bind(win)
    win.loadURL = value => {
      const requested = new URL(value)
      assert.equal(requested.hostname, 'localhost')
      assert.equal(requested.port, '15374')
      assert.equal(requested.pathname, '/')
      record('load-url', { theme: requested.searchParams.get('theme'), language: requested.searchParams.get('language') })
      return loadURL(baseUrl + requested.pathname + requested.search)
    }
  })

  const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8')
  const mainSource = fs.readFileSync(path.join(projectRoot, 'src/main.js'), 'utf8')
  const mountTail = mainSource.match(/app\.mount\('#app'\)[\s\S]*$/)?.[0]
  assert.ok(mountTail?.includes("window.dispatchEvent(new Event('app:mounted'))"), 'Production mount must dispatch its startup completion event')
  const fixtureModule = `import { createApp, h } from '/fixture-vue.js';\nconst app = createApp({render:()=>h('main',{id:'fixture-mounted',style:{position:'fixed',inset:'0',background:'#ffffff',color:'#222222'}},'Empty fixture library is ready')});\n${mountTail}`
  const sendModule = response => {
    if (!response.destroyed) { response.setHeader('Content-Type', 'text/javascript'); response.end(fixtureModule) }
  }
  server = http.createServer((request, response) => {
    const requested = new URL(request.url, 'http://127.0.0.1')
    requests.push(requested.pathname)
    response.setHeader('Cache-Control', 'no-store')
    if (requested.pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html) }
    else if (['/audit.html', '/ai-inspector.html'].includes(requested.pathname)) {
      response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Auxiliary window fixture</title>')
    }
    else if (requested.pathname === '/src/main.js') {
      if (moduleMode === 'hold') heldModule = response
      else if (moduleMode === 'fail') { response.statusCode = 503; response.end('Fixture module unavailable') }
      else sendModule(response)
    } else if (requested.pathname === '/fixture-vue.js') {
      response.setHeader('Content-Type', 'text/javascript')
      response.end(fs.readFileSync(path.join(projectRoot, 'node_modules/vue/dist/vue.esm-browser.prod.js')))
    } else if (requested.pathname === '/favicon.ico') { response.statusCode = 204; response.end() }
    else { response.statusCode = 404; response.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://localhost:${server.address().port}`
  const watchdog = setTimeout(() => { console.error('Startup scenario timed out'); app.exit(1) }, 45000)
  const evaluate = async expression => {
    const result = await main.webContents.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const inspectLoading = () => evaluate(`(()=>{const node=document.querySelector('#startup-loading');if(!node)return null;const rect=node.getBoundingClientRect();return{title:document.querySelector('#startup-title').textContent,background:getComputedStyle(node).backgroundColor,width:rect.width,height:rect.height,display:getComputedStyle(node).display,retryHidden:document.querySelector('#startup-retry').hidden,mounted:Boolean(document.querySelector('#fixture-mounted'))}})()`)
  const capture = async name => {
    // The OS window intentionally remains hidden. Capture the initial painted
    // loading surface without activating or revealing it.
    main.webContents.invalidate()
    await wait(100)
    const image = await waitUntil(async () => {
      try { return await main.webContents.capturePage(undefined, { stayHidden: true }) }
      catch (error) { if (error.message.includes('display surface not available')) return null; throw error }
    }, 'rendered capture surface: ' + name, 5000)
    assert.ok(!image.isEmpty(), 'Hidden test window must capture a rendered page')
    const size = image.getSize()
    assert.ok(size.width > 500 && size.height > 300)
    const center = await require('sharp')(image.toPNG()).extract({ left: Math.floor(size.width * .3), top: Math.floor(size.height * .35),
      width: Math.floor(size.width * .4), height: Math.floor(size.height * .3) }).stats()
    const variation = Math.max(...center.channels.slice(0, 3).map(channel => channel.stdev))
    if (name === 'loading') assert.ok(variation > 1, 'Captured loading frame contains the visible spinner and text')
    const screenshot = path.join(scenarioRoot, name + '.png')
    fs.writeFileSync(screenshot, image.toPNG())
    screenshots.push(screenshot)
    return screenshot
  }
  try {
    await app.whenReady()
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const allowed = details.url.startsWith(baseUrl + '/') || details.url === 'about:blank'
      if (!allowed) unexpectedRequests.push(details.url)
      callback({ cancel: !allowed })
    })
    const Module = require('node:module'), originalLoad = Module._load
    Module._load = function (request, parent, isMain) {
      return request === 'electron' && parent?.filename === path.join(projectRoot, 'index.js')
        ? fixtureElectron : originalLoad.call(this, request, parent, isMain)
    }
    try { require('../index.js') } finally { Module._load = originalLoad }
    await waitUntil(() => main && heldModule, 'production window requests its delayed module')
    const loading = await waitUntil(inspectLoading, 'HTML startup UI before the Vue module arrives')
    assert.equal(loading.title, scenario.title)
    assert.equal(loading.background, scenario.background)
    assert.equal(loading.display, 'grid')
    assert.ok(loading.width > 500 && loading.height > 300)
    assert.equal(loading.retryHidden, true)
    assert.equal(loading.mounted, false)
    assert.ok(!requests.includes('/fixture-vue.js'), 'Loading UI renders independently of Vue')
    assert.equal(actions.find(action => action.name === 'load-url').theme, scenario.theme)
    assert.equal(actions.find(action => action.name === 'load-url').language, scenario.language)
    if (scenario.minimizeOnStart) assert.equal(actions.filter(action => action.name === 'show').length, 0)
    else assert.equal(actions.find(action => action.name === 'show')?.readyCount, 0, 'Normal startup shows before ready-to-show')
    if (scenario.userMinimize) assert.equal(actions.find(action => action.name === 'user-minimize')?.readyCount, 0)
    await capture('loading')
    moduleMode = 'ready'; sendModule(heldModule)
    await waitUntil(async () => await evaluate("Boolean(document.querySelector('#fixture-mounted')) && !document.querySelector('#startup-loading') && !document.querySelector('#startup-style')"), 'Vue mount removes the startup overlay')
    await waitUntil(() => readyCount > 0, 'ready-to-show emitted')
    const returnedSetting = await evaluate("window.ipcRenderer.invoke('load-setting')")
    assert.equal(returnedSetting.library, library, 'Production IPC reads only the fixture profile')
    assert.equal(returnedSetting.metadataPath, profile)
    assert.deepEqual(fs.readdirSync(library), [], 'Fixture library stays empty')
    if (scenario.minimizeOnStart) {
      assert.equal(actions.filter(action => action.name === 'show').length, 0, 'Minimized startup never shows early')
      if (scenario.minimizeToTray) {
        assert.equal(trayCount, 1)
        assert.ok(actions.some(action => action.name === 'hide' && action.readyCount > 0))
        assert.ok(actions.some(action => action.name === 'skip-taskbar' && action.value === true))
        assert.equal(logicalVisible, false)
      } else assert.ok(actions.some(action => action.name === 'minimize' && action.readyCount > 0))
    } else {
      assert.equal(actions.filter(action => action.name === 'show').length, 1, 'Ready-to-show must not show a second time')
      if (scenario.userMinimize) assert.equal(logicalMinimized, true, 'User minimization survives renderer readiness')
    }
    let retryVerified = false
    if (scenarioName === 'normal') {
      moduleMode = 'fail'
      main.webContents.reload()
      const failed = await waitUntil(async () => {
        const state = await inspectLoading()
        return state && !state.retryHidden ? state : null
      }, 'failed module reveals the static retry action')
      assert.equal(failed.title, '界面加载失败')
      assert.equal(failed.mounted, false)
      moduleMode = 'ready'
      await evaluate("document.querySelector('#startup-retry').click()")
      await waitUntil(async () => await evaluate("Boolean(document.querySelector('#fixture-mounted')) && !document.querySelector('#startup-loading')"), 'retry reload mounts successfully')
      assert.ok(requests.filter(value => value === '/').length >= 3)
      retryVerified = true
    }
    assert.deepEqual(unexpectedRequests, [], 'Renderer never contacts a real server')
    assert.equal(app.getPath('userData'), profile)
    const validation = { success: true, scenario: scenarioName, profile, fixtureRenderer: true,
      productionMainPreloadHtml: true, loading, actions, requests, screenshots, retryVerified, emptyLibrary: true, nativeWindowOperationsIntercepted: true }
    if (scenario.closeMain) {
      await evaluate("window.ipcRenderer.invoke('audit:open-window')")
      await evaluate("window.ipcRenderer.invoke('ai-trace:open', {runId:'fixture'})")
      assert.equal(electron.BrowserWindow.getAllWindows().length, 3)
      if (scenario.closeToTray) {
        main.close()
        await waitUntil(() => !logicalVisible && trayCount === 1, 'main window hidden in tray')
        assert.equal(main.isDestroyed(), false)
        assert.equal(electron.BrowserWindow.getAllWindows().length, 3, 'Auxiliary windows remain open')
        assert.ok(actions.some(action => action.name === 'skip-taskbar' && action.value === true))
        await evaluate("window.ipcRenderer.invoke('load-setting')")
        fs.writeFileSync(path.join(scenarioRoot, 'validation.json'), JSON.stringify({ ...validation, mainHiddenInTray: true, auxiliaryWindowsOpen: true }, null, 2))
        console.log('STARTUP_CHILD_OK ' + scenarioName)
        clearTimeout(watchdog)
        server.close()
        app.exit(0)
        return
      }
      app.once('will-quit', () => {
        try {
          assert.equal(electron.BrowserWindow.getAllWindows().length, 0, 'Closing main closes every auxiliary window')
          assert.equal(trayCount, 0, 'Closing with close-to-tray disabled does not create a tray')
          fs.writeFileSync(path.join(scenarioRoot, 'validation.json'), JSON.stringify({ ...validation, allWindowsClosed: true }, null, 2))
          console.log('STARTUP_CHILD_OK ' + scenarioName)
          clearTimeout(watchdog)
          server.close()
        } catch (error) {
          console.error(error.stack || error)
          app.exit(1)
        }
      })
      main.close()
      return
    }
    fs.writeFileSync(path.join(scenarioRoot, 'validation.json'), JSON.stringify(validation, null, 2))
    console.log('STARTUP_CHILD_OK ' + scenarioName)
    clearTimeout(watchdog)
    server.close()
    app.exit(0)
  } catch (error) {
    clearTimeout(watchdog)
    fs.writeFileSync(path.join(scenarioRoot, 'error.txt'), String(error.stack || error) + '\n' + JSON.stringify({ actions, requests, unexpectedRequests }, null, 2))
    server.close()
    throw error
  }
}

(scenarioName ? runScenario() : supervise()).catch(error => {
  console.error(error.stack || error)
  if (process.versions.electron) require('electron').app.exit(1)
  else process.exitCode = 1
})

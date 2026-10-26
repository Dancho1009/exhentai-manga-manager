const assert = require('node:assert/strict')
const path = require('node:path')
const locale = require('../../src/locales/zh-CN.json')

module.exports = async ({ chromium, executablePath, baseUrl, screenshotDir }) => {
  const browser = await chromium.launch({ headless: true, executablePath })
  const page = await browser.newPage({ viewport: { width: 1320, height: 900 } })
  page.setDefaultTimeout(20000)
  const errors = [], requests = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => requests.push(request.url()))
  await page.addInitScript(() => {
    const listeners = {}
    const setting = {
      language: 'zh-CN', theme: 'dark', library: 'C:/fixture', pageSize: 12,
      displayTitle: 'japaneseTitle', disableRandomTag: true, showTranslation: false,
      showComment: false, autoCheckUpdates: false, loadOnStart: false, viewerType: 'original',
      customOptions: '', imageExplorer: 'fixture-reader', defaultInsertEmptyPage: false,
      collectTag: [{ id: 'artist:fixture', letter: 'a', cat: 'artist', tag: 'fixture', color: '#333333' }]
    }
    const books = Array.from({ length: 3 }, (_, index) => ({
      id: 'book-' + index, hash: 'hash-' + index, filepath: `C:/fixture/book-${index}.zip`,
      title: 'Fixture title ' + index, title_jpn: 'Fixture title ' + index, coverPath: '/icon.png',
      type: 'zip', status: 'tagged', tags: { artist: ['fixture'], female: ['fixture-tag'], male: [] },
      category: 'Non-H', pageCount: 1, filecount: 1, rating: 3.5, readCount: 0, mark: false,
      date: '2026-10-08', mtime: '2026-10-08', url: 'https://example.com/fixture', filesize: 12345
    }))
    window.fixtureCalls = []
    const observer = new MutationObserver(() => {
      if (document.querySelector('.book-search-bar')) {
        window.fixtureMountedAt = performance.now()
        observer.disconnect()
      }
    })
    observer.observe(document, { subtree: true, childList: true })
    window.ipcRenderer = {
      on: (channel, fn) => { (listeners[channel] ||= []).push(fn) },
      removeAllListeners: channel => { delete listeners[channel] },
      sendSync: () => '/',
      invoke: async (channel, ...args) => {
        window.fixtureCalls.push({ channel, args })
        if (channel === 'load-setting') return structuredClone(setting)
        if (channel === 'load-book-list') return structuredClone(books)
        if (channel === 'load-collection-list' || channel === 'get-folder-tree') return []
        if (channel === 'get-locale') return 'zh-CN'
        if (channel === 'load-manga-image-list') {
          setTimeout(() => (listeners['manga-image'] || []).forEach(fn => fn({}, {
            id: 'fixture-page', index: 0, total: 1, width: 256, height: 256, filepath: '/icon.png'
          })), 50)
        }
        return null
      }
    }
    window.electronFunction = { 'get-zoom-level': () => 0, 'set-zoom-level': () => {}, 'insert-css': () => {} }
    window.aiApi = { getConfig: async () => {
      window.fixtureCalls.push({ channel: 'ai-get-config' })
      return { config: { enabled: false, baseUrl: '', model: '', responseMode: 'json_schema', timeoutMs: 30000, concurrency: 1, maxRequests: 10, dedupeEnabled: true, seriesEnabled: true }, hasApiKey: false }
    } }
  })
  const app = (fn, arg) => page.evaluate(({ fn, arg }) => {
    const vm = document.querySelector('#app').__vue_app__._instance.proxy
    return new Function('vm', 'arg', `return (${fn})(vm, arg)`)(vm, arg)
  }, { fn: fn.toString(), arg })
  const downloaded = pattern => requests.some(url => pattern.test(url))
  try {
    await page.goto(baseUrl)
    await page.locator('.book-card').first().waitFor()
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'))
    assert.equal(await app(vm => vm.localeFile.name), 'zh-cn')
    assert.ok(await page.locator('.book-search-bar svg').count() >= 10, 'Toolbar icons render through individual imports')
    const startup = await page.evaluate(() => ({
      mountedAt: window.fixtureMountedAt,
      bytes: performance.getEntriesByType('resource').reduce((sum, entry) => sum + entry.decodedBodySize, 0),
      resources: performance.getEntriesByType('resource').length,
      paint: performance.getEntriesByType('paint').map(entry => ({ name: entry.name, start: entry.startTime }))
    }))
    assert.equal(downloaded(/@vicons_(?:fluent|material|carbon|ionicons4)\.js/), false, 'Icon package barrels stay off the startup path')
    for (const dependency of [/chart[._-]+js/i, /ComicReader/i, /AiSettings\.vue/, /vuedraggable/]) {
      assert.equal(downloaded(dependency), false, `${dependency} is not downloaded by hidden components`)
    }
    assert.equal(await page.evaluate(() => window.fixtureCalls.some(call => call.channel === 'ai-get-config')), false)

    let releaseChart
    const chartReady = new Promise(resolve => { releaseChart = resolve })
    await page.route(/chart[._-]+js/, async route => { await chartReady; await route.continue() })
    await page.getByTitle(locale.m.tagAnalysis, { exact: true }).click()
    await app(vm => { vm.$refs.TagGraphRef.displayTagGraph() })
    assert.equal(await page.locator('#graph-artist:visible').count(), 0, 'The chart dialog opens after its code is ready')
    releaseChart()
    await page.locator('#graph-artist').waitFor({ state: 'visible' })
    await page.waitForFunction(() => document.querySelector('#graph-artist').toDataURL().length > 1000)
    assert.equal(downloaded(/chart[._-]+js/i), true, 'Chart.js loads when analysis is opened')
    await app(vm => {
      vm.$refs.TagGraphRef.dialogVisibleGraph = false
      vm.$refs.TagGraphRef.displayTagGraph()
    })
    await page.waitForFunction(() => document.querySelector('#graph-artist')?.toDataURL().length > 1000)
    await page.locator('.el-dialog:visible .el-dialog__headerbtn').click()
    await page.locator('#graph-artist').waitFor({ state: 'hidden' })

    await page.getByTitle(locale.m.setting, { exact: true }).click()
    const settings = page.locator('.setting-dialog')
    await settings.waitFor({ state: 'visible' })
    assert.equal(downloaded(/AiSettings\.vue|vuedraggable/), false, 'General settings do not mount unused tabs')
    await settings.getByRole('tab', { name: locale.ai.settings, exact: true }).click()
    await settings.getByTestId('ai-key').waitFor()
    assert.equal(downloaded(/AiSettings\.vue/), true)
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(call => call.channel === 'ai-get-config').length), 1)
    await settings.getByRole('tab', { name: locale.m.collectTag, exact: true }).click()
    await settings.locator('[data-draggable="true"]').waitFor()
    assert.equal(downloaded(/vuedraggable/), true)
    await settings.locator('.el-dialog__headerbtn').click()
    await settings.waitFor({ state: 'hidden' })

    await page.getByTitle(locale.m.manageCollection, { exact: true }).click()
    await page.locator('.book-collection').waitFor({ state: 'visible' })
    await page.getByTitle(locale.m.addCollection, { exact: true }).click()
    const prompt = page.locator('.el-message-box')
    await prompt.locator('input').fill('Lazy collection fixture')
    await prompt.getByRole('button', { name: '确定', exact: true }).click()
    await page.locator('.book-collect-card').first().click()
    await page.locator('.book-collection-line').waitFor()
    await page.getByTitle(locale.m.exit, { exact: true }).click()
    await page.locator('.book-collection').waitFor({ state: 'hidden' })

    await app(vm => vm.$refs.InternalViewerRef.viewManga(vm.bookList[0]))
    await page.locator('.viewer-drawer').waitFor({ state: 'visible' })
    await page.locator('.viewer-image').waitFor()
    assert.equal(downloaded(/ComicReader/i), false, 'Original reader does not fetch the alternative reader')
    await app(vm => { vm.$refs.InternalViewerRef.drawerVisibleViewer = false })
    await page.locator('.viewer-drawer').waitFor({ state: 'hidden' })
    const screenshot = path.join(screenshotDir, 'startup-home.png')
    await page.screenshot({ path: screenshot, animations: 'disabled' })
    assert.deepEqual(errors, [])
    return { startup, screenshots: [screenshot], checks: 'individual icons, theme and locale bootstrap, hidden dependency requests, lazy chart, AI settings, draggable collection and original reader' }
  } catch (error) {
    await page.screenshot({ path: path.join(screenshotDir, 'startup-loading-failure.png') })
    throw error
  } finally { await browser.close() }
}

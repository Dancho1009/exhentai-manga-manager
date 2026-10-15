// Runs the production main process against an isolated temporary library.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, shell } = require('electron')
const outputRoot = path.resolve(process.argv[2])
const fixtureRoot = path.resolve(process.argv[3])
const expectedMembers = Number(process.argv[4] || 3)
const expectedKeepIds = expectedMembers === 2 ? ['a'] : ['a', 'c']
app.setPath('userData', fixtureRoot)
require('../modules/utils.js').getRootPath = () => path.resolve(__dirname, '..')
const { prepareSetting } = require('../modules/init_folder_setting.js')
const setting = { ...prepareSetting(), library: path.join(fixtureRoot, 'Library'), metadataPath: fixtureRoot, language: 'zh-CN', theme: 'dark', loadOnStart: false, autoCheckUpdates: false }
fs.writeFileSync(path.join(fixtureRoot, 'setting.json'), JSON.stringify(setting, null, 2))
fs.writeFileSync(path.join(fixtureRoot, 'collectionList.json'), JSON.stringify([{ id: 'fixture', title: 'Fixture', list: ['sample-b'] }]))
const opened = []
shell.showItemInFolder = filename => opened.push({ type: 'locate', filename })
shell.openExternal = async url => { opened.push({ type: 'url', url }) }
app.on('browser-window-created', (_event, win) => { win.show = () => {}; win.focus = () => {} })
require('../index.js')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitUntil = async read => {
  for (let index = 0; index < 300; index++) { const result = await read(); if (result) return result; await wait(100) }
  throw new Error('Electron dedupe smoke timed out')
}

const run = async () => {
  const main = await waitUntil(async () => {
    const win = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('localhost:15374') && !item.webContents.getURL().includes('.html'))
    return win && await win.webContents.executeJavaScript('Boolean(window.ipcRenderer)') ? win : null
  })
  await main.webContents.executeJavaScript(`localStorage.setItem('recentRead', JSON.stringify([{id:'b',read_time:100}])); localStorage.setItem('viewerReadingProgress',JSON.stringify([{bookId:'b',pageId:'02.png'}])); window.ipcRenderer.invoke('audit:open-window')`)
  let audit = await waitUntil(async () => {
    const win = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('audit.html'))
    return win && await win.webContents.executeJavaScript('Boolean(window.auditApi)') ? win : null
  })
  const evaluate = code => audit.webContents.executeJavaScript(code)
  const startedAt = Date.now()
  await evaluate(`window.auditApi.startDedupe({scanMode:'full',forceRecompute:true})`)
  await waitUntil(async () => await evaluate(`window.auditApi.getWorkspaceState().then(state=>!state.activeTask && state.channels.dedupe.status==='completed')`))
  const report = await evaluate(`window.auditApi.getReport('dedupe')`)
  assert.equal(report.dedupeRulesVersion, 2)
  assert.equal(report.groups.length, 1)
  const group = report.groups[0]
  assert.equal(group.items.length, expectedMembers)
  assert.equal(group.equivalenceClasses.length, 1)
  assert.equal(group.items.find(item => item.id === 'a').semantic.chapter, null)
  assert.equal(group.items.find(item => item.id === 'a').semantic.volume, null)
  assert.equal(group.items.find(item => item.id === 'a').semantic.publications[0].issue, '13')
  if (expectedMembers === 3) assert.equal(group.items.find(item => item.id === 'c').semantic.chapter.start, 3)
  const request = { reportId: report.reportId, groupId: group.id, leftId: 'a', rightId: 'b' }
  const comparisonStarted = Date.now()
  const comparison = await evaluate(`window.auditApi.getDedupeComparison(${JSON.stringify(request)})`)
  assert.equal(comparison.comparison.matchedCount, 3)
  const comparisonMs = Date.now() - comparisonStarted
  const preview = await evaluate(`window.auditApi.getDedupePreview(${JSON.stringify({ ...request, leftIndex: 1, rightIndex: 1 })})`)
  assert.equal(preview.length, 6)
  assert.ok(preview.every(item => item.url && item.width === 24))
  const detailResult = await evaluate('window.auditApi.openBookDetail(' + JSON.stringify({bookId:'a',navigationIds:group.items.map(item=>item.id)}) + ')')
  assert.ok(detailResult)
  await waitUntil(async () => BrowserWindow.getAllWindows().some(win => win.webContents.getURL().includes('book-detail.html')))
  await evaluate(`window.auditApi.showFile(${JSON.stringify(group.items[0].filepath)})`)
  await evaluate(`window.auditApi.openUrl('https://exhentai.org/g/123456/abcdef1234/')`)
  assert.deepEqual(opened.map(item => item.type), ['locate', 'url'])
  await evaluate("window.auditApi.saveReview('dedupe'," + JSON.stringify({ reportId: report.reportId, selections: {}, decisions: {}, quarantineRoot: path.join(fixtureRoot, 'Quarantine') }) + ")")
  audit.reload()
  await waitUntil(async () => await evaluate('Boolean(document.querySelector("#tab-dedupe"))'))
  await evaluate('document.querySelector("#tab-dedupe").click()')
  await waitUntil(async () => await evaluate('document.querySelectorAll(".member-card").length === ' + expectedMembers))
  assert.equal(await evaluate('document.querySelectorAll(".member-strip").length'), 0)
  assert.equal(await evaluate('document.querySelectorAll(".member-card details").length'), 0)
  assert.equal(await evaluate('document.querySelectorAll(".member-details .sources").length'), expectedMembers)
  await evaluate('document.querySelector("[data-book-id=b] input[type=checkbox]").click()')
  assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".member-card")).filter(node=>node.querySelector("input[type=checkbox]").checked).map(node=>node.dataset.bookId)'), expectedKeepIds)
  await evaluate('Array.from(document.querySelectorAll(".decision-actions button")).find(node=>node.textContent.includes("确认重复并保存")).click()')
  await waitUntil(async () => await evaluate("window.auditApi.getReview('dedupe').then(review=>review.decisions[" + JSON.stringify(group.id) + "]?.quarantineToKeep.b === 'a')"))
  await waitUntil(async () => await evaluate('!document.querySelector(".member-summary-bar .draft-state")'))
  const savedReview = await evaluate("window.auditApi.getReview('dedupe')")
  assert.deepEqual(savedReview.decisions[group.id].keepIds, expectedKeepIds)
  const zoomChecks = []
  audit.setContentSize(1320, 860)
  audit.webContents.setBackgroundThrottling(false)
  for (const factor of [1, 1.25, 1.5]) {
    audit.webContents.setZoomFactor(factor)
    await waitUntil(async () => Math.abs(await evaluate('innerWidth') - 1320 / factor) < 2)
    const geometry = await evaluate('({width:innerWidth,height:innerHeight,widthUsed:document.querySelector(".dedupe-panel").scrollWidth,footer:document.querySelector(".review-action-bar").getBoundingClientRect().bottom,controls:document.querySelector(".decision-editor").getBoundingClientRect().bottom,workspace:document.querySelector(".comparison-area").getBoundingClientRect().bottom,scrollHeight:document.querySelector(".comparison-scroll").clientHeight})')
    assert.ok(geometry.widthUsed <= geometry.width, JSON.stringify({ factor, geometry }))
    assert.ok(geometry.footer <= geometry.height + 1, JSON.stringify({ factor, geometry }))
    assert.ok(geometry.controls <= geometry.workspace + 1, JSON.stringify({ factor, geometry }))
    assert.ok(geometry.scrollHeight > 120, JSON.stringify({ factor, geometry }))
    const layout = await evaluate('(()=>{const grid=document.querySelector(".member-grid"),rect=grid.getBoundingClientRect(),cards=Array.from(grid.querySelectorAll(".member-card")).map(node=>node.getBoundingClientRect());return{columns:getComputedStyle(grid).gridTemplateColumns.split(" ").length,width:rect.width,cardWidth:cards[0].width,lastRight:cards.at(-1).right,right:rect.right}})()')
    assert.equal(layout.columns, Math.min(expectedMembers, factor === 1 ? 3 : factor === 1.25 ? 2 : 1))
    if (expectedMembers === 2 && factor === 1) assert.ok(layout.cardWidth >= layout.width * .48 && Math.abs(layout.right - layout.lastRight) < 1)
    zoomChecks.push({ factor, ...geometry, layout })
  }
  audit.webContents.setZoomFactor(1)
  const plan = await evaluate(`window.auditApi.getExecutionPreview({taskType:'dedupe',reportId:${JSON.stringify(report.reportId)}})`)
  assert.equal(plan.quarantineFileCount, 1)
  assert.equal(plan.files[0].keepId, 'a')
  await evaluate(`document.querySelector('#tab-dedupe').click()`)
  await wait(500)
  const screenshot = path.join(outputRoot, 'dedupe-electron-overview.png')
  await fs.promises.writeFile(screenshot, (await audit.webContents.capturePage()).toPNG())
  const executed = await evaluate(`window.auditApi.executeApproved({taskType:'dedupe',reportId:${JSON.stringify(report.reportId)}})`)
  assert.equal(executed.movedCount, 1)
  assert.equal(executed.rendererState.recentRead[0].id, 'a')
  assert.equal(executed.rendererState.viewerReadingProgress[0].bookId, 'a')
  const history = await evaluate('window.auditApi.getDedupeHistory()')
  assert.equal(history.length, 1)
  assert.ok(fs.existsSync(history[0].files[0].target))
  assert.equal(fs.existsSync(path.join(fixtureRoot, 'Library', 'b.zip')), false)
  assert.deepEqual(JSON.parse(await fs.promises.readFile(path.join(fixtureRoot, 'collectionList.json'), 'utf8'))[0].list, ['sample-a'])
  await evaluate('window.auditApi.cleanupDedupePreview()')
  assert.ok(preview.every(item => !fs.existsSync(item.path)))
  const oldId = audit.id
  audit.destroy()
  await main.webContents.executeJavaScript(`window.ipcRenderer.invoke('audit:open-window')`)
  audit = await waitUntil(async () => {
    const win = BrowserWindow.getAllWindows().find(item => item.id !== oldId && item.webContents.getURL().includes('audit.html'))
    return win && await win.webContents.executeJavaScript('Boolean(window.auditApi)') ? win : null
  })
  assert.equal((await evaluate('window.auditApi.getDedupeHistory()')).length, 1)
  await evaluate(`window.auditApi.startDedupe({scanMode:'full',forceRecompute:true})`)
  await evaluate('window.auditApi.cancelActive()')
  await waitUntil(async () => await evaluate(`window.auditApi.getWorkspaceState().then(state=>!state.activeTask)`))
  const state = await evaluate('window.auditApi.getWorkspaceState()')
  assert.equal(state.channels.dedupe.phase, 'cancelled')
  fs.writeFileSync(path.join(outputRoot, 'dedupe-electron-validation.json'), JSON.stringify({ success: true, fixtureRoot,
    reportId: report.reportId, scanMs: Date.now() - startedAt, comparisonMs, previewEntries: preview.length,
    movedCount: executed.movedCount, historyEntries: history.length, cancelled: true, opened, screenshot, zoomChecks, uiKeepSelection: savedReview.decisions[group.id] }, null, 2))
  console.log('ELECTRON_DEDUPE_SMOKE_OK')
  app.exit(0)
}
app.whenReady().then(run).catch(error => { console.error(error); app.exit(1) })

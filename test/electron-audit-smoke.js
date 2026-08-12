const fs = require('fs')

const port = Number(process.argv[2] || 9333)
const screenshotPath = process.argv[3] || `${process.env.TEMP}\\emm-audit-smoke.png`
const startTask = process.env.AUDIT_SMOKE_START_TASK || ''
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const openSockets = new Set()

const targets = async () => await (await fetch(`http://127.0.0.1:${port}/json`)).json()

const connect = async url => {
  const ws = new WebSocket(url)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  openSockets.add(ws)
  ws.onclose = () => openSockets.delete(ws)
  let id = 0
  const pending = new Map()
  const events = []
  ws.onmessage = event => {
    const message = JSON.parse(event.data)
    if (!message.id) {
      events.push(message)
      return
    }
    if (!pending.has(message.id)) return
    const promise = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) promise.reject(new Error(message.error.message))
    else promise.resolve(message.result)
  }
  return {
    ws,
    events,
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const messageId = ++id
        pending.set(messageId, { resolve, reject })
        ws.send(JSON.stringify({ id: messageId, method, params }))
      })
    }
  }
}

const run = async () => {
  let list = await targets()
  const main = list.find(item => item.type === 'page' && !item.url.includes('audit.html'))
  if (!main) throw new Error('Main renderer target missing')
  const mainCdp = await connect(main.webSocketDebuggerUrl)
  const clicked = await mainCdp.send('Runtime.evaluate', {
    expression: `(() => {
      const button = [...document.querySelectorAll('button')]
        .find(node => (node.title || '').includes('异常检查与去重'))
      if (!button) return false
      button.click()
      return true
    })()`,
    returnByValue: true
  })
  mainCdp.ws.close()
  if (!clicked.result.value) throw new Error('Audit toolbar button missing')

  let audit
  for (let index = 0; index < 40; index += 1) {
    list = await targets()
    audit = list.find(item => item.url.includes('audit.html'))
    if (audit) break
    await wait(250)
  }
  if (!audit) throw new Error('Audit renderer target missing')
  const auditCdp = await connect(audit.webSocketDebuggerUrl)
  await auditCdp.send('Page.enable')
  await auditCdp.send('Runtime.enable')
  await auditCdp.send('Log.enable')
  await auditCdp.send('Emulation.setDeviceMetricsOverride', { width: 1320, height: 860, deviceScaleFactor: 1, mobile: false })
  await wait(250)
  let body = ''
  for (let index = 0; index < 40; index += 1) {
    const result = await auditCdp.send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true })
    body = result.result.value || ''
    if (body.includes('漫画库异常检查与去重')) break
    await wait(250)
  }
  if (startTask === 'anomaly' && !body.includes('任务进行中')) {
    await auditCdp.send('Runtime.evaluate', {
      expression: `window.auditApi.startAnomaly({ onlinePolicy: 'none', forceLocal: false, forceOnline: false })`,
      awaitPromise: true,
      returnByValue: true
    })
    for (let index = 0; index < 80; index += 1) {
      const result = await auditCdp.send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true })
      body = result.result.value || ''
      if (body.includes('任务进行中') && body.includes('已完成阶段')) break
      await wait(100)
    }
  }
  if (!body.includes('异常检查') || !body.includes('重复检查')) {
    throw new Error(`Audit UI text incomplete: ${body.slice(0, 500)}`)
  }
  if (body.includes('审批与执行')) throw new Error('Standalone approval tab is still visible')
  if (!body.includes('开始异常检查')) throw new Error('Independent anomaly start action missing')
  if (body.includes('快速检查') || body.includes('深度检查') || body.includes('在线来源检查')) {
    throw new Error('Legacy combined audit modes are still visible')
  }
  if (body.includes('任务进行中') && (!body.includes('已完成阶段') || !body.includes('下一阶段') || !body.includes('剩余阶段'))) {
    throw new Error('Active audit stage summary is incomplete')
  }
  const clickTab = async text => {
    const position = await auditCdp.send('Runtime.evaluate', {
      expression: `(() => {
        const node = [...document.querySelectorAll('[role="tab"]')].find(item => item.textContent.includes(${JSON.stringify(text)}))
        if (!node) return null
        const rect = node.getBoundingClientRect()
        const x = rect.left + rect.width / 2
        const y = rect.top + rect.height / 2
        const top = document.elementFromPoint(x, y)
        return { x, y, top: top ? top.outerHTML.slice(0, 240) : null }
      })()`,
      returnByValue: true
    })
    const point = position.result.value
    if (!point) return false
    await auditCdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await auditCdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    return point
  }
  const dedupeClicked = await clickTab('重复检查')
  await wait(400)
  const dedupeState = await auditCdp.send('Runtime.evaluate', {
    expression: `({
      visible: document.body.innerText.includes('开始重复检查'),
      preview: document.body.innerText.slice(0, 500),
      tabs: [...document.querySelectorAll('[role="tab"]')].map(node => ({ text: node.textContent, active: node.getAttribute('aria-selected') }))
    })`,
    returnByValue: true
  })
  const dedupeScreenshotPath = screenshotPath.replace(/(\.png)?$/i, '-dedupe.png')
  const dedupeScreenshot = await auditCdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(dedupeScreenshotPath, Buffer.from(dedupeScreenshot.data, 'base64'))
  const anomalyClicked = await clickTab('异常检查')
  await wait(400)
  const anomalyState = await auditCdp.send('Runtime.evaluate', {
    expression: `({ visible: document.body.innerText.includes('开始异常检查'), tabCount: document.querySelectorAll('[role="tab"]').length })`,
    returnByValue: true
  })
  const tabs = {
    dedupeClicked: Boolean(dedupeClicked),
    dedupeVisible: dedupeState.result.value.visible,
    anomalyClicked: Boolean(anomalyClicked),
    anomalyVisible: anomalyState.result.value.visible,
    tabCount: anomalyState.result.value.tabCount,
    dedupeTarget: dedupeClicked,
    dedupeTabState: dedupeState.result.value.tabs,
    dedupePreview: dedupeState.result.value.preview,
    runtimeEvents: auditCdp.events.filter(event => ['Runtime.exceptionThrown', 'Log.entryAdded', 'Runtime.consoleAPICalled'].includes(event.method)).slice(-10)
  }
  if (!tabs.dedupeClicked || !tabs.dedupeVisible || !tabs.anomalyClicked || !tabs.anomalyVisible || tabs.tabCount !== 2) {
    throw new Error(`Independent audit tabs failed: ${JSON.stringify(tabs)}`)
  }
  const screenshot = await auditCdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  let logScreenshotPath = null
  if (startTask) {
    const logHeader = await auditCdp.send('Runtime.evaluate', {
      expression: `(() => {
        const node = document.querySelector('.log-pane .el-collapse-item__header')
        if (!node) return null
        const rect = node.getBoundingClientRect()
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      })()`,
      returnByValue: true
    })
    const point = logHeader.result.value
    if (!point) throw new Error('Task log header missing')
    await auditCdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await auditCdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await wait(300)
    const logState = await auditCdp.send('Runtime.evaluate', {
      expression: `(() => {
        const node = document.querySelector('.active-task-summary')
        return node ? node.innerText : ''
      })()`,
      returnByValue: true
    })
    const logText = logState.result.value || ''
    if (!logText.includes('已完成阶段') || !logText.includes('下一阶段') || !logText.includes('剩余阶段')) {
      throw new Error(`Expanded task stage summary is incomplete: ${logText}`)
    }
    logScreenshotPath = screenshotPath.replace(/(\.png)?$/i, '-log.png')
    const logScreenshot = await auditCdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    fs.writeFileSync(logScreenshotPath, Buffer.from(logScreenshot.data, 'base64'))
    await auditCdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await auditCdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await wait(200)
  }
  await auditCdp.send('Emulation.setDeviceMetricsOverride', { width: 820, height: 900, deviceScaleFactor: 1, mobile: false })
  await wait(300)
  const narrowState = await auditCdp.send('Runtime.evaluate', {
    expression: `({
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      anomalyActionVisible: document.body.innerText.includes('执行异常修复'),
      tabCount: document.querySelectorAll('[role="tab"]').length
    })`,
    returnByValue: true
  })
  const narrowScreenshotPath = screenshotPath.replace(/(\.png)?$/i, '-narrow.png')
  const narrowScreenshot = await auditCdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(narrowScreenshotPath, Buffer.from(narrowScreenshot.data, 'base64'))
  const narrow = narrowState.result.value
  if (!narrow.anomalyActionVisible || narrow.tabCount !== 2 || narrow.scrollWidth > narrow.innerWidth + 1) {
    throw new Error(`Narrow audit layout failed: ${JSON.stringify(narrow)}`)
  }
  const runtimeExceptions = auditCdp.events.filter(event => event.method === 'Runtime.exceptionThrown')
  if (runtimeExceptions.length > 0) {
    throw new Error(`Audit runtime exception: ${JSON.stringify(runtimeExceptions.slice(-5))}`)
  }
  if (startTask) {
    await auditCdp.send('Runtime.evaluate', {
      expression: 'window.auditApi.cancelActive()',
      awaitPromise: true,
      returnByValue: true
    })
  }
  auditCdp.ws.close()
  console.log(JSON.stringify({ auditUrl: audit.url, screenshotPath, dedupeScreenshotPath, logScreenshotPath, narrowScreenshotPath, textPreview: body.slice(0, 240) }))
}

run().catch(error => {
  for (const socket of openSockets) socket.close()
  console.error(error)
  setTimeout(() => process.exit(1), 25)
})

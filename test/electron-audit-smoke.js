const fs = require('fs')

const port = Number(process.argv[2] || 9333)
const screenshotPath = process.argv[3] || `${process.env.TEMP}\\emm-audit-smoke.png`
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const targets = async () => await (await fetch(`http://127.0.0.1:${port}/json`)).json()

const connect = async url => {
  const ws = new WebSocket(url)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  let id = 0
  const pending = new Map()
  ws.onmessage = event => {
    const message = JSON.parse(event.data)
    if (!message.id || !pending.has(message.id)) return
    const promise = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) promise.reject(new Error(message.error.message))
    else promise.resolve(message.result)
  }
  return {
    ws,
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
  let body = ''
  for (let index = 0; index < 40; index += 1) {
    const result = await auditCdp.send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true })
    body = result.result.value || ''
    if (body.includes('漫画库异常检查与去重')) break
    await wait(250)
  }
  if (!body.includes('异常检查') || !body.includes('重复检查') || !body.includes('审批与执行')) {
    throw new Error(`Audit UI text incomplete: ${body.slice(0, 500)}`)
  }
  const screenshot = await auditCdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  auditCdp.ws.close()
  console.log(JSON.stringify({ auditUrl: audit.url, screenshotPath, textPreview: body.slice(0, 240) }))
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})

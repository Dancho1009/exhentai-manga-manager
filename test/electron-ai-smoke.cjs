// Run with Electron, against a temporary profile and a local mock AI service.
// electron test/electron-ai-smoke.cjs <temporary-output-directory> [resume|packaged]
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { randomBytes, generateKeyPairSync, sign } = require('node:crypto')
const { app, BrowserWindow, safeStorage, session, shell, ipcMain, dialog } = require('electron')
const fetch = require('node-fetch')

const outputRoot = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'emm-ai-electron-')))
const fixtureRoot = path.join(outputRoot, 'profile')
const resume = process.argv[3] === 'resume'
const packagedMode = process.argv[3] === 'packaged'
const projectRoot = path.resolve(__dirname, '..')
assert.ok(!fs.existsSync(path.join(projectRoot, 'data')) && !fs.existsSync(path.join(projectRoot, 'portable')), 'Smoke test requires a non-portable project checkout')
fs.mkdirSync(fixtureRoot, { recursive: true })
app.setPath('userData', fixtureRoot)
app.setPath('sessionData', path.join(fixtureRoot, 'browser-session'))
require('../modules/utils.js').getRootPath = () => projectRoot
const { prepareSetting } = require('../modules/init_folder_setting.js')
const { prepareMangaModel, prepareMetadataModel } = require('../modules/database.js')
const { archive } = require('./fixtures/dedupe-fixture.cjs')
const { AiCredentialStore } = require('../modules/ai_credentials.js')

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitUntil = async (read, label) => {
  for (let attempt = 0; attempt < 600; attempt++) {
    const value = await read()
    if (value) return value
    await wait(100)
  }
  throw new Error('Timed out: ' + label)
}
const calls = [], broadcasts = [], rendererErrors = [], terminalAiLogs = []
const originalConsoleInfo = console.info.bind(console)
console.info = (...values) => {
  const line = values.map(String).join(' ')
  if (line.startsWith('[AI] ')) terminalAiLogs.push(line)
  originalConsoleInfo(...values)
}
const expectedModels = ['fixture-model', 'fixture-model-vision']
const reasoningEfforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const codexClientId = 'app_EMoamEEZ73f0CkXaXp7hrann'
let server, frontendServer, frontendOrigin, secret = '', draftSecret = '', oauthSecret = '', requestDelay = 0, audit
let browserAuthorization, usagePageOpened = false
const oauthCalls = []
const oauthScope = 'openid profile email offline_access'
const usageResetsAt = Math.floor(Date.now() / 1000) + 3600
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const oauthJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'smoke-key', alg: 'RS256', use: 'sig' }
const signedIdentity = clientId => {
  const content = [Buffer.from(JSON.stringify({ alg: 'RS256', kid: oauthJwk.kid })).toString('base64url'), Buffer.from(JSON.stringify({
    iss: 'https://auth.openai.com', aud: clientId, sub: 'smoke-user', email: 'smoke@example.invalid',
    exp: Math.floor(Date.now() / 1000) + 3600, nonce: browserAuthorization?.searchParams.get('nonce'),
    'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-web-account', chatgpt_plan_type: 'plus' }
  })).toString('base64url')].join('.')
  return content + '.' + sign('RSA-SHA256', Buffer.from(content), privateKey).toString('base64url')
}
app.on('browser-window-created', (_event, win) => {
  win.show = () => {}; win.focus = () => {}
  win.webContents.setBackgroundThrottling(false)
  if (packagedMode) {
    const loadFile=win.loadFile.bind(win)
    // Electron resolves relative loadFile paths against the smoke entry's test/
    // app path; a real installed package resolves them against the project root.
    win.loadFile=(filename,options)=>loadFile(path.resolve(projectRoot,filename),options)
  }
  const loadURL = win.loadURL.bind(win)
  win.loadURL = value => {
    const requested = new URL(value)
    if (packagedMode && requested.protocol === 'file:') return loadURL(value)
    assert.equal(requested.origin, 'http://localhost:15374', 'Only this fixture app dev URL is redirected')
    return loadURL(frontendOrigin + requested.pathname + requested.search + requested.hash)
  }
  const send = win.webContents.send.bind(win.webContents)
  win.webContents.send = (channel, ...values) => { broadcasts.push({ channel, values }); return send(channel, ...values) }
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3 && !message.includes('Content Security Policy')) rendererErrors.push(message)
  })
})

const prepareFixture = async () => {
  const markerPath = path.join(fixtureRoot, '.ai-smoke-fixture')
  if (resume) { assert.ok(fs.existsSync(markerPath), 'Resume requires a smoke-test profile'); return }
  assert.ok(!fs.existsSync(path.join(fixtureRoot, 'database.sqlite')), 'Use a fresh temporary output directory')
  fs.writeFileSync(markerPath, 'AI smoke fixture only')
  const library = path.join(fixtureRoot, 'Library')
  fs.mkdirSync(library)
  const Manga = prepareMangaModel(path.join(fixtureRoot, 'database.sqlite'))
  const Metadata = prepareMetadataModel(path.join(fixtureRoot, 'metadata.sqlite'))
  await Promise.all([Manga.sync(), Metadata.sync()])
  const sharp = require('sharp')
  const images = await Promise.all([20, 50, 80, 110, 140, 170, 200, 230, 15, 245].map(red => sharp({ create: { width: 24, height: 32, channels: 3, background: { r: red, g: 90, b: 120 } } }).png().toBuffer()))
  const descriptors = [
    { id: 'a', title: '[Fixture Author] 月花 第1話 (コミックメガストア Vol.13)', image: 0 },
    { id: 'b', title: '[Fixture Author] Moonflower Ch. 1 (COMIC Megastore Vol.13)', image: 0 },
    { id: 'c', title: '[Fixture Author] 月花 第2話 (コミックメガストア Vol.15)', image: 1 },
    { id: 'd', title: '[Fixture Author] 月花 第3話 (コミックメガストア Vol.16)', image: 2 },
    { id: 'e', title: '[Creator X] 星の約束', image: 3 },
    { id: 'f', title: '[Creator X] Promise beneath stars', image: 4 },
    { id: 'm35', title: 'Dascomi Vol.35', image: 5 },
    { id: 'm38', title: 'Dascomi Vol.38', image: 6 },
    ...['n1', 'n2'].map(id => ({ id, title: '[Napo] Koi no Rank Match - Make Love Rank match!! | 恋之排位决斗战 (COMIC ExE 60) [Chinese] [软蒲汉化组] [Digital]', image: 7 })),
    { id: 'u1', title: '[Unknown Creator] 夜の航路 卷之貳 第三話 (銀河特別誌 春季増刊号)', image: 8 },
    { id: 'u2', title: '[Unknown Creator] Starway Volume Two Ch.4 (Galaxy Review Spring Extra Ω)', image: 9 }
  ]
  for (const descriptor of descriptors) {
    const filepath = path.join(library, descriptor.id + '.zip')
    const count = descriptor.image + 3, gid = descriptor.image + 123456
    const entries = Object.fromEntries(Array.from({ length: count }, (_, index) => [String(index + 1).padStart(2, '0') + '.png', images[descriptor.image]]))
    entries['.ehviewer'] = `VERSION2\nFixture title\n${gid}\nabcdef1234\n`
    fs.writeFileSync(filepath, archive(entries, descriptor.id))
    const stat = fs.statSync(filepath)
    const value = { id: descriptor.id, title: descriptor.title, title_jpn: '', hash: 'fixture-' + descriptor.id, filepath, type: 'zip',
      pageCount: count, filecount: count, coverPath: '', bundleSize: stat.size, mtime: stat.mtime.toISOString(), url: `https://exhentai.org/g/${gid}/abcdef1234/`, status: 'tagged',
      tags: { artist: [descriptor.id === 'e' || descriptor.id === 'f' ? 'creator x' : 'fixture author'], language: ['japanese'] } }
    await Manga.create(value)
    await Metadata.create(Object.fromEntries(Object.keys(Metadata.rawAttributes).filter(key => value[key] !== undefined).map(key => [key, value[key]])))
  }
  await Promise.all([Manga.sequelize.close(), Metadata.sequelize.close()])
  const setting = { ...prepareSetting(), library, metadataPath: fixtureRoot, language: 'zh-CN', theme: 'dark', loadOnStart: false,
    autoCheckUpdates: false, enabledLANBrowsing: false, proxy: '', minimizeToTray: false, closeToTray: false }
  fs.writeFileSync(path.join(fixtureRoot, 'setting.json'), JSON.stringify(setting, null, 2))
  fs.writeFileSync(path.join(fixtureRoot, 'collectionList.json'), '[]')
}

const describe = input => {
  const moon = ['a', 'b', 'c', 'd'].includes(input.id), stars = ['e', 'f'].includes(input.id), unknownPublication = ['u1', 'u2'].includes(input.id)
  const publication = input.publications?.[0]
  return { id: input.id, workTitle: moon ? '月花' : stars ? '星の約束' : unknownPublication ? '夜の航路' : input.title,
    seriesTitle: moon ? '月花' : unknownPublication ? '夜の航路' : '',
    authors: input.authors, titleAliases: [input.title, ...(moon ? ['月花', 'Moonflower'] : stars ? ['星の約束', 'Promise beneath stars'] : unknownPublication ? ['夜の航路', 'Starway'] : [])],
    chapter: unknownPublication ? { start: 3, end: null } : input.chapter ? { start: input.chapter.start, end: input.chapter.end ?? input.chapter.start } : null,
    volume: unknownPublication ? { start: 2, end: null } : input.volume,
    publication: unknownPublication ? { kind: 'embedded', name: input.id === 'u1' ? '銀河特別誌' : 'Galaxy Review', issue: input.id === 'u1' ? '春季増刊号' : 'Spring Extra Ω', date: null }
      : publication ? { kind: publication.kind, name: publication.name, issue: publication.issue, date: publication.date } : null,
    uncertainties: [], evidenceRefs: [{ bookId: input.id, field: 'title', quote: input.title },
      ...(input.chapter ? [{ bookId: input.id, field: 'chapter', quote: JSON.stringify({ end: input.chapter.end, start: input.chapter.start }, null, 2) }] : [])] }
}
const mockResponse = payload => {
  if (payload.test === 'connection') return { ok: true }
  const books = payload.books.map(describe), byId = new Map(payload.books.map(book => [book.id, book]))
  const relations = payload.pairs.map(pair => {
    const left = byId.get(pair.leftId), right = byId.get(pair.rightId)
    const relation = left.id.startsWith('m') && right.id.startsWith('m') ? 'same_publication_different_issue'
      : ['u1', 'u2'].includes(left.id) && ['u1', 'u2'].includes(right.id) ? 'same_work_different_edition'
      : left.chapter && right.chapter && left.chapter.start !== right.chapter.start ? 'same_series_different_part'
        : ['e', 'f'].includes(left.id) && ['e', 'f'].includes(right.id) ? 'same_work_different_edition' : 'same_work_same_part'
    return { leftId: pair.leftId, rightId: pair.rightId, relation, reason: 'Fixture relation supported by the supplied titles.' }
  })
  return payload.task === 'normalize' ? { books, relations: [] } : { relations }
}
const openMock = async () => {
  server = http.createServer(async (request, response) => {
    try {
      let text = ''
      for await (const chunk of request) text += chunk.toString('utf8')
      assert.ok(!request.headers.cookie, 'AI requests must not carry library-session cookies')
      if (request.url.startsWith('/oauth-fixture/')) {
        const target = new URL(decodeURIComponent(request.url.slice('/oauth-fixture/'.length)))
        oauthCalls.push({ host: target.host, path: target.pathname, method: request.method })
        response.setHeader('Content-Type', 'application/json')
        if (target.host === 'auth.openai.com') {
          if (target.pathname.endsWith('/openid-configuration')) return response.end(JSON.stringify({ issuer: target.origin, jwks_uri: target.origin + '/.well-known/jwks.json', revocation_endpoint: target.origin + '/oauth/revoke' }))
          if (target.pathname.endsWith('/jwks.json')) return response.end(JSON.stringify({ keys: [oauthJwk] }))
          if (target.pathname === '/oauth/revoke') {
            assert.match(request.headers['content-type'], /application\/json/)
            const revoked = JSON.parse(text)
            assert.equal(revoked.client_id, codexClientId)
            assert.equal(revoked.token_type_hint, 'refresh_token')
            assert.equal(revoked.token, 'account-refresh-' + oauthSecret)
            return response.end('')
          }
          assert.equal(target.pathname, '/oauth/token')
          const body = new URLSearchParams(text)
          assert.equal(body.get('client_id'), codexClientId)
          assert.equal(body.get('grant_type'), 'authorization_code')
          assert.equal(body.get('redirect_uri'), browserAuthorization.searchParams.get('redirect_uri'))
          return response.end(JSON.stringify({ access_token: 'account-access-' + oauthSecret, refresh_token: 'account-refresh-' + oauthSecret,
            id_token: signedIdentity(body.get('client_id')), expires_in: 3600, scope: oauthScope, token_type: 'Bearer' }))
        }
        assert.equal(target.host, 'chatgpt.com', 'Native account and imported Codex credentials use the Codex backend')
        const webAccount = request.headers.authorization === 'Bearer account-access-' + oauthSecret
        assert.equal(request.headers.authorization, 'Bearer ' + (webAccount ? 'account-access-' + oauthSecret : oauthSecret))
        assert.equal(request.headers['chatgpt-account-id'], webAccount ? 'fixture-web-account' : 'fixture-account')
        if (target.pathname === '/backend-api/wham/usage') {
          assert.equal(request.method, 'GET')
          assert.equal(text, '')
          return response.end(JSON.stringify({ plan_type: 'plus', rate_limit: { allowed: true, limit_reached: false,
            primary_window: { used_percent: webAccount ? 25 : 40, reset_at: usageResetsAt, limit_window_seconds: 18000 },
            secondary_window: { used_percent: webAccount ? 55 : 70, reset_at: usageResetsAt + 86400, limit_window_seconds: 604800 } } }))
        }
        if (request.method === 'GET') return response.end(JSON.stringify({ models: [{ slug: 'fixture-chatgpt-model', display_name: 'ChatGPT Fixture', visibility: 'list',
          supported_reasoning_levels: reasoningEfforts.map(effort => ({ effort, description: effort })), default_reasoning_level: 'medium' }] }))
        const body = JSON.parse(text)
        assert.equal(body.stream, true)
        assert.equal(body.store, false)
        assert.equal(body.temperature, undefined)
        assert.ok(reasoningEfforts.includes(body.reasoning?.effort), 'The selected reasoning tier is sent without rewriting its wire value')
        oauthCalls.at(-1).reasoningEffort = body.reasoning.effort
        oauthCalls.at(-1).webAccount = webAccount
        assert.equal(JSON.parse(body.input[0].content[0].text).test, 'connection')
        response.setHeader('Content-Type', 'text/event-stream')
        return response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', model: body.model,
          output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }] } }) + '\n\n')
      }
      if (request.method === 'GET') {
        assert.ok(['/v1/models', '/draft/v1/models'].includes(request.url), 'Models use the requested draft or saved base URL')
        const draft = request.url === '/draft/v1/models'
        assert.ok(request.headers.authorization === 'Bearer ' + (draft ? draftSecret : secret), 'Models use the matching draft or stored credential')
        assert.equal(text, '', 'Models request has no prompt or request body')
        calls.push({ task: 'models', path: request.url, credential: draft ? 'draft' : 'stored', hasAuthorization: Boolean(request.headers.authorization) })
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ object: 'list', data: expectedModels.map(id => ({ id, object: 'model' })) }))
        return
      }
      const body = JSON.parse(text), payload = JSON.parse(body.messages.find(message => message.role === 'user').content)
      if (payload.task !== 'normalize' && payload.books?.some(book => book.id === 'u2')) {
        assert.equal(payload.books.find(book => book.id === 'u2').aiHints.chapter.start, 3, 'Pair classification receives previous AI semantics even when local chapter parsing differs')
      }
      assert.ok(request.headers.authorization === 'Bearer ' + secret, 'Mock received the expected encrypted-profile credential')
      assert.ok(!text.includes(fixtureRoot) && !text.includes(secret), 'Payload excludes local paths and credentials')
      assert.equal(typeof body.stream, 'boolean')
      calls.push({ task: payload.task || 'test', ids: payload.books?.map(book => book.id) || [], pairs: payload.pairs || [],
        model: body.model, stream: body.stream, responseMode: body.response_format?.type, hasAuthorization: Boolean(request.headers.authorization) })
      if (body.model === 'fixture-format-unsupported' && body.response_format?.type === 'json_schema') {
        response.statusCode = 400
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ error: { message: ' This response_format type is unavailable now; private upstream credential=' + secret,
          type: 'invalid_request_error' } }))
        return
      }
      const result = mockResponse(payload)
      if (body.model === 'fixture-invalid-result' && result.relations?.length) result.relations[0].relation = 'private-invalid-relation'
      const send = () => {
        if (response.destroyed) return
        if (body.stream) {
          response.setHeader('Content-Type', 'text/event-stream')
          response.end('data: ' + JSON.stringify({ model: 'fixture-model', choices: [{ delta: { content: JSON.stringify(result) }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\ndata: [DONE]\n\n')
        } else {
          response.setHeader('Content-Type', 'application/json')
          response.end(JSON.stringify({ model: 'fixture-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }))
        }
      }
      if (requestDelay) { const timer = setTimeout(send, requestDelay); response.once('close', () => clearTimeout(timer)) } else send()
    } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: 'Fixture rejected request' })); console.error('MOCK_ERROR', error.message) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}/v1`
}
const openFrontend = async () => {
  const { createServer } = await import('vite')
  // Vite treats port 0 as its default 5173, so select an ephemeral port first.
  const reservation = http.createServer()
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  frontendServer = await createServer({ root: projectRoot, configFile: path.join(projectRoot, 'vite.config.mjs'),
    cacheDir: path.join(fixtureRoot, 'vite-cache'), logLevel: 'error', server: { host: '127.0.0.1', port, strictPort: true, open: false } })
  await frontendServer.listen()
  frontendOrigin = `http://localhost:${frontendServer.httpServer.address().port}`
}
const closeServers = () => {
  server?.closeAllConnections?.()
  server?.close()
  // Vite may wait for the app's own live browser connections. Let Electron's
  // normal quit close them and persist its encryption state before exiting.
  void frontendServer?.close().catch(error => console.error('Fixture frontend shutdown failed:', error.message))
}
const evaluate = code => audit.webContents.executeJavaScript(code)
const expectUnsupportedFormat = async action => {
  let safeMessage
  await assert.rejects(action(), error => {
    safeMessage = String(error.message || error)
    assert.ok(safeMessage.includes('AI_RESPONSE_FORMAT_UNSUPPORTED'), 'The safe error code survives real Electron IPC')
    assert.match(safeMessage, /[\u4e00-\u9fff]/, 'The renderer receives a Chinese explanation')
    assert.ok(!safeMessage.includes(secret) && !safeMessage.includes(draftSecret), 'The renderer error contains no credential')
    assert.ok(!safeMessage.includes('This response_format type is unavailable now') && !safeMessage.includes('private upstream credential'), 'The renderer does not receive the raw upstream error body')
    return true
  })
  return safeMessage
}
const finishAi = async task => {
  const state = await waitUntil(async () => {
    const value = await evaluate('window.auditApi.ai.getState()')
    const workspace = await evaluate('window.auditApi.getWorkspaceState()')
    return value.task === task && !['running', 'cancelling'].includes(value.status) && !workspace.lock?.locked ? value : null
  }, task + ' AI analysis')
  assert.equal(state.status, 'completed', 'AI analysis completed: ' + JSON.stringify(state))
  assert.equal(state.failed, 0)
  return state
}
const assertUsage = (state, webAccount) => {
  assert.equal(state.usage.status, 'ready')
  assert.ok(Number.isFinite(state.usage.fetchedAt))
  assert.equal(state.usage.primary.remainingPercent, webAccount ? 75 : 60)
  assert.equal(state.usage.secondary.remainingPercent, webAccount ? 45 : 30)
  assert.equal(state.usage.primary.resetsAt, usageResetsAt * 1000)
  assert.equal(state.usage.secondary.resetsAt, (usageResetsAt + 86400) * 1000)
  assert.equal(state.usage.primary.windowSeconds, 18000)
  assert.equal(state.usage.secondary.windowSeconds, 604800)
}
const inspectTerminalLogs = () => {
  const records = terminalAiLogs.map(line => {
    const match = line.match(/^\[AI\] ([a-z]+:[a-z]+) (\{.*\})$/)
    assert.ok(match, 'The terminal emitted a parseable AI event')
    return { event: match[1], ...JSON.parse(match[2]) }
  })
  for (const event of ['task:start', 'task:finish', 'request:start', 'request:finish', 'cache:hit', 'result:validated', 'result:invalid']) {
    assert.ok(records.some(record => record.event === event), 'Observed actual terminal output for ' + event)
  }
  assert.ok(records.some(record => record.event === 'request:finish' && record.status === 'completed' && Number.isInteger(record.durationMs)))
  assert.ok(records.some(record => record.event === 'result:invalid' && record.validationReason === 'INVALID_VALUE' && record.fieldPath === 'relations[0].relation'))
  const serialized = terminalAiLogs.join('\n')
  for (const privateValue of [secret, draftSecret, oauthSecret, fixtureRoot, 'Fixture Author', '夜の航路', 'Spring Extra Ω', 'Invented citation', 'Return exactly']) {
    assert.ok(!serialized.includes(privateValue), 'Terminal events exclude credentials, library paths, titles, response bodies and original prompts')
  }
  assert.ok(!/"(?:apiKey|access_token|refresh_token|prompt|messages|payload|title|filepath|quote)"/.test(serialized))
  fs.writeFileSync(path.join(outputRoot, 'ai-terminal.log'), serialized + '\n')
  return { recordCount: records.length, events: [...new Set(records.map(record => record.event))],
    validated: records.filter(record => record.event === 'result:validated').length,
    invalid: records.filter(record => record.event === 'result:invalid') }
}
const run = async () => {
  await prepareFixture()
  await app.whenReady()
  secret = resume ? await new AiCredentialStore({ storePath: fixtureRoot, safeStorage }).get() : randomBytes(24).toString('hex')
  draftSecret = randomBytes(24).toString('hex')
  assert.ok(secret.length > 0, 'Encrypted credentials recover after restart')
  const baseUrl = await openMock()
  await new AiCredentialStore({ storePath: fixtureRoot, safeStorage, slot: 'chatgpt-account' }).set(JSON.stringify({
    version: 1, kind: 'siwc', credentialId: 'fixture-legacy-siwc', clientId: 'oaiapp_smoke', accountId: '',
    accessToken: 'fixture-obsolete-siwc-access', refreshToken: '', idToken: '', scopes: ['chatgpt.tokens.use.direct'],
    expiresAt: Date.now() + 3600000, savedAt: Date.now(), email: 'legacy@example.invalid', identityVerified: true
  }))
  const aiSession = session.fromPartition('ai-service')
  const originalFetch = aiSession.fetch.bind(aiSession)
  aiSession.fetch = (url, options) => {
    const target = new URL(url)
    if (['auth.openai.com', 'api.openai.com', 'chatgpt.com'].includes(target.host)) {
      return originalFetch(baseUrl.replace(/\/v1$/, '') + '/oauth-fixture/' + encodeURIComponent(url), options)
    }
    assert.equal(target.hostname, '127.0.0.1', 'Smoke tests never contact an external service')
    return originalFetch(url, options)
  }
  shell.openExternal = async url => {
    const target = new URL(url)
    if (target.origin === 'https://chatgpt.com') { usagePageOpened = true; return }
    browserAuthorization = target
    assert.equal(browserAuthorization.origin, 'https://auth.openai.com')
    assert.equal(browserAuthorization.pathname, '/oauth/authorize')
    assert.equal(browserAuthorization.searchParams.get('client_id'), codexClientId)
    assert.equal(browserAuthorization.searchParams.get('code_challenge_method'), 'S256')
    assert.ok(browserAuthorization.searchParams.get('code_challenge'))
  }
  await openFrontend()
  if (packagedMode) Object.defineProperty(app,'isPackaged',{value:true})
  require('../index.js')
  const main = await waitUntil(async () => {
    const win = BrowserWindow.getAllWindows().find(item => packagedMode ? item.webContents.getURL().includes('/dist/index.html') : item.webContents.getURL().startsWith(frontendOrigin + '/') && !item.webContents.getURL().includes('.html'))
    return win && await win.webContents.executeJavaScript('Boolean(window.aiApi)') ? win : null
  }, 'main window and production preload')
  const mainEvaluate = code => main.webContents.executeJavaScript(code)
  // General settings schedule their initial normalization save after mounting.
  await wait(1200)
  const config = { enabled: true, baseUrl, model: 'fixture-model', responseMode: 'json_schema', stream: true, timeoutMs: 30000, normalizationBatchSize: 3, concurrency: 2, maxRequests: 100, dedupeEnabled: true, seriesEnabled: true }
  const draftConfig = { ...config, baseUrl: baseUrl.replace(/\/v1$/, '/draft/v1'), enabled: false, model: '' }
  const modelLists = {}
  const formatErrors = {}
  await session.defaultSession.cookies.set({ url: 'http://127.0.0.1', name: 'library-session', value: 'must-not-send' })
  const configBeforeDraft = await mainEvaluate('window.aiApi.getConfig()')
  modelLists.mainDraft = await mainEvaluate('window.aiApi.listModels(' + JSON.stringify({ config: draftConfig, apiKey: draftSecret }) + ')')
  assert.deepEqual(modelLists.mainDraft, { models: expectedModels }, 'Main preload lists models with an unsaved URL/key, disabled AI and no selected model')
  assert.deepEqual(await mainEvaluate('window.aiApi.getConfig()'), configBeforeDraft, 'Draft model lookup does not save configuration')
  if (!resume) assert.ok(!fs.existsSync(path.join(fixtureRoot, 'ai-credentials.json')), 'Draft model lookup does not create stored credentials')
  if (resume) assert.equal((await mainEvaluate('window.aiApi.getConfig()')).hasApiKey, true)
  const saved = await mainEvaluate('window.aiApi.saveConfig(' + JSON.stringify({ config, ...(!resume ? { apiKey: secret } : {}) }) + ')')
  assert.equal(saved.hasApiKey, true)
  assert.equal(saved.config.normalizationBatchSize, 3)
  assert.equal(saved.config.concurrency, 2)
  assert.equal(saved.config.stream, true)
  assert.equal((await mainEvaluate('window.aiApi.getConfig()')).config.normalizationBatchSize, 3)
  assert.ok(!JSON.stringify(saved).includes(secret), 'Configuration response contains no credential')
  modelLists.mainStored = await mainEvaluate('window.aiApi.listModels(' + JSON.stringify({ config: { ...config, enabled: false, model: '' } }) + ')')
  assert.deepEqual(modelLists.mainStored, { models: expectedModels }, 'Main preload can use the stored credential without enable/model prerequisites')
  assert.equal((await mainEvaluate('window.aiApi.testConnection()')).ok, true)
  assert.equal(calls.at(-1).stream, true)
  assert.equal((await mainEvaluate('window.aiApi.testConnection(' + JSON.stringify({ config: { ...config, stream: false } }) + ')')).ok, true)
  assert.equal(calls.at(-1).stream, false)
  assert.equal((await mainEvaluate('window.aiApi.getConfig()')).config.stream, true, 'A draft connection test does not overwrite saved streaming settings')
  assert.equal(saved.config.provider, 'compatible', 'Existing settings migrate to the compatible service')
  assert.equal(saved.ready, true, 'The saved compatible API is ready')
  assert.deepEqual(saved.missing, [])
  assert.equal(saved.auth, null)
  const unsupportedConfig = { ...config, model: 'fixture-format-unsupported', responseMode: 'json_schema' }
  const beforeFormatFailure = calls.length
  formatErrors.main = await expectUnsupportedFormat(() => mainEvaluate('window.aiApi.testConnection(' + JSON.stringify({ config: unsupportedConfig }) + ')'))
  assert.equal(calls.length, beforeFormatFailure + 1, 'Unsupported format fails once without an automatic format fallback')
  assert.equal((await mainEvaluate('window.aiApi.testConnection(' + JSON.stringify({ config: { ...unsupportedConfig, responseMode: 'json_object' } }) + ')')).ok, true,
    'Explicit JSON object selection succeeds with the same endpoint and model')
  const publicSetting = await mainEvaluate("window.ipcRenderer.invoke('load-setting')")
  assert.ok(!JSON.stringify(publicSetting).includes(secret), 'Normal settings exclude the credential')
  const stored = fs.readFileSync(path.join(fixtureRoot, 'ai-credentials.json'), 'utf8')
  assert.ok(!stored.includes(secret), 'Credential file is encrypted')
  assert.ok(JSON.parse(stored).encryptedKey)
  await mainEvaluate("window.ipcRenderer.invoke('audit:open-window')")
  audit = await waitUntil(async () => {
    const win = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('audit.html'))
    return win && await win.webContents.executeJavaScript('Boolean(window.auditApi?.ai)') ? win : null
  }, 'audit production preload')
  await mainEvaluate('window.__authSmokeStates = []; window.__stopAuthSmoke = window.aiApi.onAuthState(value => window.__authSmokeStates.push(value)); true')
  await evaluate('window.__authSmokeStates = []; window.__stopAuthSmoke = window.auditApi.ai.onAuthState(value => window.__authSmokeStates.push(value)); true')
  for (const read of [mainEvaluate, evaluate]) {
    const api = read === mainEvaluate ? 'window.aiApi' : 'window.auditApi.ai'
    const auth = await read(api + '.getAuthState({provider:"chatgpt-json"})')
    assert.equal(auth.provider, 'chatgpt-json')
    assert.equal(auth.hasCredential, false)
    assert.equal(auth.usable, false)
    assert.equal(auth.account, null)
    await assert.rejects(read(api + '.importOAuthJson({json:"invalid-json"})'), /AI_[A-Z_]+/, 'Invalid JSON has a safe IPC error')
  }
  oauthSecret = randomBytes(24).toString('hex')
  const oauthImport = { access_token: oauthSecret, account_id: 'fixture-account', refresh_token: 'fixture-refresh-' + oauthSecret, email: 'json@example.invalid' }
  const imported = await mainEvaluate('window.aiApi.importOAuthJson(' + JSON.stringify({ json: JSON.stringify({ tokens: oauthImport }) }) + ')')
  assert.equal(imported.provider, 'chatgpt-json')
  assert.equal(imported.hasCredential, true)
  assert.equal(imported.usable, true)
  assert.equal(imported.account.canRefresh, false, 'An unknown legacy client is not assumed refreshable')
  assert.equal(imported.account.email, 'json@example.invalid')
  assert.ok(Number.isFinite(imported.account.importedAt), 'The JSON summary records the actual import time')
  assert.equal(imported.account.loggedInAt, null, 'Importing a JSON does not invent a web-login date')
  assert.ok(!JSON.stringify(imported).includes(oauthSecret), 'Import responses contain only the safe account summary')
  await waitUntil(async () => (await mainEvaluate('window.__authSmokeStates.length')) > 0 && (await evaluate('window.__authSmokeStates.length')) > 0,
    'OAuth state broadcasts in both windows')
  assert.equal((await evaluate('window.auditApi.ai.getAuthState({provider:"chatgpt-json"})')).hasCredential, true)
  assert.equal((await mainEvaluate('window.aiApi.getConfig()')).config.provider, 'compatible', 'Import does not silently select a service')
  const jsonConfig = { ...config, provider: 'chatgpt-json', chatgptJsonModel: 'fixture-json-model', chatgptAccountModel: 'fixture-account-model',
    reasoningEffort: 'medium', chatgptJsonReasoningEffort: 'ultra', chatgptAccountReasoningEffort: 'max' }
  const jsonSaved = await evaluate('window.auditApi.ai.saveConfig(' + JSON.stringify({ config: jsonConfig }) + ')')
  assert.equal(jsonSaved.ready, true)
  assert.equal(jsonSaved.config.model, config.model, 'Selecting ChatGPT retains the compatible API model')
  assert.equal(jsonSaved.config.baseUrl, config.baseUrl, 'Selecting ChatGPT retains the compatible API URL')
  assert.equal(jsonSaved.auth.hasCredential, true)
  const chatgptModels = await evaluate('window.auditApi.ai.listModels(' + JSON.stringify({ config: jsonConfig }) + ')')
  assert.deepEqual(chatgptModels.models, ['fixture-chatgpt-model'])
  assert.deepEqual(chatgptModels.modelOptions[0].reasoningEfforts, reasoningEfforts)
  for (const effort of reasoningEfforts) {
    assert.equal((await evaluate('window.auditApi.ai.testConnection(' + JSON.stringify({ config: { ...jsonConfig, chatgptJsonReasoningEffort: effort } }) + ')')).ok, true,
      'Imported Codex credentials complete streamed inference at ' + effort)
    assert.equal(oauthCalls.at(-1).reasoningEffort, effort)
  }
  assertUsage(await mainEvaluate('window.aiApi.refreshUsage({provider:"chatgpt-json"})'), false)
  await evaluate('window.auditApi.ai.openUsagePage({provider:"chatgpt-json"})')
  assert.equal(usagePageOpened, true)
  const accountSaved = await mainEvaluate('window.aiApi.saveConfig(' + JSON.stringify({ config: { ...jsonConfig, provider: 'chatgpt-account' } }) + ')')
  assert.equal(accountSaved.ready, false)
  assert.ok(accountSaved.missing.includes('credential'), 'Account login has independent credentials')
  assert.equal(accountSaved.auth.hasCredential, true)
  assert.equal(accountSaved.auth.error, 'AI_OAUTH_RELOGIN_REQUIRED', 'Old SIWC account sessions require the new native login')
  await assert.rejects(mainEvaluate('window.aiApi.testConnection()'), /AI_OAUTH_RELOGIN_REQUIRED/)
  const loginState = await mainEvaluate('window.aiApi.startLogin()')
  assert.equal(loginState.loginPending, true)
  assert.equal((await evaluate('window.auditApi.ai.getAuthState({provider:"chatgpt-account"})')).loginPending, true)
  const callback = new URL(browserAuthorization.searchParams.get('redirect_uri'))
  callback.search = new URLSearchParams({ state: browserAuthorization.searchParams.get('state'), code: 'smoke-code' }).toString()
  const callbackResponse = await fetch(callback)
  assert.equal(callbackResponse.status, 200)
  await callbackResponse.text()
  const accountReady = await evaluate('window.auditApi.ai.getConfig()')
  assert.equal(accountReady.ready, true)
  assert.equal(accountReady.auth.status, 'signed-in')
  assert.equal(accountReady.auth.account.kind, 'codex')
  assert.equal(accountReady.auth.account.email, 'smoke@example.invalid')
  assert.equal(accountReady.auth.account.identityVerified, true)
  assert.ok(Number.isFinite(accountReady.auth.account.loggedInAt))
  assert.equal(accountReady.auth.account.importedAt, null)
  assert.equal((await mainEvaluate('window.aiApi.listModels()')).models[0], 'fixture-chatgpt-model')
  for (const effort of reasoningEfforts) {
    assert.equal((await mainEvaluate('window.aiApi.testConnection(' + JSON.stringify({ config: { ...jsonConfig, provider: 'chatgpt-account', chatgptAccountReasoningEffort: effort } }) + ')')).ok, true,
      'Native web login completes streamed inference at ' + effort)
    assert.equal(oauthCalls.at(-1).reasoningEffort, effort)
    assert.equal(oauthCalls.at(-1).webAccount, true)
  }
  assertUsage(await evaluate('window.auditApi.ai.refreshUsage({provider:"chatgpt-account"})'), true)
  assertUsage(await mainEvaluate('window.aiApi.getAuthState({provider:"chatgpt-account"})'), true)
  assert.equal((await mainEvaluate('window.aiApi.getConfig()')).config.reasoningEffort, 'medium')
  assert.equal((await mainEvaluate('window.aiApi.getConfig()')).config.chatgptJsonReasoningEffort, 'ultra')
  assert.equal((await mainEvaluate('window.aiApi.getConfig()')).config.chatgptAccountReasoningEffort, 'max')
  const accountLogout = await mainEvaluate('window.aiApi.logout({provider:"chatgpt-account"})')
  assert.equal(accountLogout.hasCredential, false)
  assert.equal(accountLogout.warning, undefined)
  const oauthFiles = fs.readdirSync(fixtureRoot).filter(name => name.startsWith('ai-') && name.endsWith('.json') && name !== 'ai-credentials.json')
  assert.ok(oauthFiles.length > 0, 'OAuth credentials use a separate profile file')
  for (const name of oauthFiles) assert.ok(!fs.readFileSync(path.join(fixtureRoot, name), 'utf8').includes(oauthSecret), 'OAuth credentials are encrypted')
  const loggedOut = await evaluate('window.auditApi.ai.logout({provider:"chatgpt-json"})')
  assert.equal(loggedOut.hasCredential, false)
  assert.equal((await mainEvaluate('window.aiApi.getAuthState({provider:"chatgpt-json"})')).hasCredential, false)
  await mainEvaluate('window.aiApi.saveConfig(' + JSON.stringify({ config: { ...jsonConfig, provider: 'compatible' } }) + ')')
  assert.equal((await mainEvaluate('window.aiApi.getConfig()')).hasApiKey, true, 'OAuth logout preserves the stored API key')
  assert.equal(fs.readFileSync(path.join(fixtureRoot, 'ai-credentials.json'), 'utf8'), stored, 'OAuth changes preserve the original encrypted API file')
  const authStates = [...await mainEvaluate('window.__authSmokeStates'), ...await evaluate('window.__authSmokeStates')]
  assert.ok(authStates.every(state => !JSON.stringify(state).includes(oauthSecret)), 'OAuth broadcasts contain no access or refresh token')
  await mainEvaluate('window.__stopAuthSmoke(); true')
  await evaluate('window.__stopAuthSmoke(); true')
  const auditConfigBeforeDraft = await evaluate('window.auditApi.ai.getConfig()')
  modelLists.auditDraft = await evaluate('window.auditApi.ai.listModels(' + JSON.stringify({ config: draftConfig, apiKey: draftSecret }) + ')')
  assert.deepEqual(modelLists.auditDraft, { models: expectedModels }, 'Audit preload accepts unsaved model-list settings')
  assert.deepEqual(await evaluate('window.auditApi.ai.getConfig()'), auditConfigBeforeDraft, 'Audit draft lookup preserves saved configuration')
  assert.equal(fs.readFileSync(path.join(fixtureRoot, 'ai-credentials.json'), 'utf8'), stored, 'Audit draft lookup preserves encrypted stored credentials')
  modelLists.auditStored = await evaluate('window.auditApi.ai.listModels(' + JSON.stringify({ config: { ...config, enabled: false, model: '' } }) + ')')
  assert.deepEqual(modelLists.auditStored, { models: expectedModels }, 'Audit preload can use the saved credential')
  assert.ok(!JSON.stringify(modelLists).includes(secret) && !JSON.stringify(modelLists).includes(draftSecret), 'Model-list responses do not expose credentials')
  assert.deepEqual(calls.filter(call => call.task === 'models').map(call => call.credential), ['draft', 'stored', 'draft', 'stored'])
  const beforeAuditFormatFailure = calls.length
  formatErrors.audit = await expectUnsupportedFormat(() => evaluate('window.auditApi.ai.testConnection(' + JSON.stringify({ config: unsupportedConfig }) + ')'))
  assert.equal(calls.length, beforeAuditFormatFailure + 1, 'Audit IPC does not silently retry using another response format')
  if (resume) {
    const previous = await evaluate("window.auditApi.ai.getResults({task:'series'})")
    assert.ok(previous.some(result => result.series?.groups.some(group => group.members.length >= 3)), 'Series analysis persists after process restart')
    const failed = (await evaluate("window.auditApi.ai.getResults({task:'dedupe'})")).find(result => result.error === 'AI_RESULT_INVALID')
    assert.equal(failed?.errorDetail?.reason, 'INVALID_VALUE', 'Validation details survive a real process restart')
    assert.equal(failed.errorDetail.path, 'relations[0].relation')
    const recoveredUnknown = (await evaluate("window.auditApi.ai.getResults({task:'discovery'})")).find(result => result.analysisBooks?.some(book => book.id === 'u1'))
    assert.ok(recoveredUnknown.analysisBooks.some(book => book.id === 'u1' && book.publication.issue === '春季増刊号' && book.chapter.start === 3))
    assert.ok(terminalAiLogs.some(line => line.startsWith('[AI] request:start ')) && terminalAiLogs.some(line => line.startsWith('[AI] request:finish ')))
    fs.writeFileSync(path.join(outputRoot, 'ai-terminal-resume.log'), terminalAiLogs.join('\n') + '\n')
    fs.writeFileSync(path.join(outputRoot, 'ai-electron-resume.json'), JSON.stringify({ success: true, recoveredCredential: true, recoveredSeries: true,
      recoveredDiagnostics: true, recoveredUnknownSemantics: recoveredUnknown.analysisBooks, terminalLogCount: terminalAiLogs.length, modelLists, formatErrors, requests: calls.length }, null, 2))
    console.log('ELECTRON_AI_RESUME_OK')
    closeServers(); app.quit(); return
  }
  await evaluate("window.auditApi.startDedupe({scanMode:'full',forceRecompute:true})")
  await waitUntil(async () => await evaluate("window.auditApi.getWorkspaceState().then(value=>!value.activeTask && value.channels.dedupe.status==='completed')"), 'deterministic scan')
  const report = await evaluate("window.auditApi.getReport('dedupe')")
  assert.equal(report.dedupeRulesVersion, 3)
  const group = report.groups.find(value => value.items.some(book => book.id === 'a') && value.items.some(book => book.id === 'b'))
  assert.ok(group?.equivalenceClasses.some(value => value.eligible && value.memberIds.includes('a') && value.memberIds.includes('b')), 'Content proof exists before AI')
  assert.ok(!report.groups.some(value => value.items.some(book => book.id === 'e') && value.items.some(book => book.id === 'f')), 'Cross-language pair is initially absent')
  const reviewBefore = await evaluate("window.auditApi.getReview('dedupe')")
  await evaluate('window.auditApi.ai.start(' + JSON.stringify({ task: 'dedupe', reportId: report.reportId, groupIds: [group.id] }) + ')')
  const dedupeState = await finishAi('dedupe')
  const suggestions = await evaluate('window.auditApi.ai.getResults(' + JSON.stringify({ task: 'dedupe', reportId: report.reportId }) + ')')
  assert.equal(suggestions.length, 1)
  assert.equal(suggestions[0].stale, false)
  assert.ok(suggestions[0].relations.some(value => value.relation === 'same_work_same_part'))
  assert.deepEqual(await evaluate("window.auditApi.getReview('dedupe')"), reviewBefore, 'AI advice does not mutate the review')
  await evaluate('window.auditApi.ai.start(' + JSON.stringify({ task: 'dedupe', reportId: report.reportId, groupIds: [group.id] }) + ')')
  const cachedState = await finishAi('dedupe')
  assert.equal(cachedState.requests, 0)
  assert.ok(cachedState.cached > 0, 'A repeated matching analysis actually emits a cache-hit event')
  const publicationGroup = report.groups.find(value => value.items.some(book => book.id === 'n1') && value.items.some(book => book.id === 'n2'))
  assert.ok(publicationGroup, 'The COMIC ExE 60 fixture is discovered by the actual content worker')
  await evaluate('window.auditApi.ai.start(' + JSON.stringify({ task: 'dedupe', reportId: report.reportId, groupIds: [publicationGroup.id] }) + ')')
  await finishAi('dedupe')
  const publicationResult = (await evaluate('window.auditApi.ai.getResults(' + JSON.stringify({ task: 'dedupe', reportId: report.reportId }) + ')'))
    .find(value => value.books.some(book => book.id === 'n1'))
  assert.equal(publicationResult.status, 'completed')
  assert.ok(publicationResult.books.every(book => book.semantic.publications.some(publication => publication.kind === 'embedded' && publication.issue === '60') && book.semantic.volume === null),
    'Pair classification relies on the original publication metadata instead of copying a second book semantic payload')

  await evaluate("window.auditApi.ai.start({task:'series'})")
  const seriesState = await finishAi('series')
  const series = await evaluate("window.auditApi.ai.getResults({task:'series'})")
  const moon = series.flatMap(value => value.series?.groups || []).find(value => value.members.some(book => book.id === 'a'))
  assert.ok(moon && ['a', 'b', 'c', 'd'].every(id => moon.members.some(book => book.id === id)), 'Series members aggregate across individual pair requests')
  assert.ok(series.every(value => (value.series?.groups || []).every(item => item.members.every(book => !book.id.startsWith('m')))), 'Magazine issues do not enter story series')

  await evaluate("window.auditApi.ai.start({task:'discovery'})")
  const discoveryState = await finishAi('discovery')
  const discovery = await evaluate("window.auditApi.ai.getResults({task:'discovery'})")
  const stars = discovery.find(value => value.relations.some(relation => [relation.leftId, relation.rightId].includes('e') && [relation.leftId, relation.rightId].includes('f')))
  assert.ok(stars && !stars.stale, 'AI normalization discovers the translated title pair')
  const unknownInterpretation = discovery.find(value => value.relations.some(relation => [relation.leftId, relation.rightId].includes('u1') && [relation.leftId, relation.rightId].includes('u2')))
  assert.ok(unknownInterpretation && !unknownInterpretation.stale && unknownInterpretation.status === 'completed', 'Unknown publication names and nonnumeric periods complete the real AI pipeline')
  assert.ok(unknownInterpretation.analysisBooks.every(book => book.chapter.start === 3 && book.volume.start === 2 && book.publication.kind === 'embedded'))
  assert.equal(unknownInterpretation.analysisBooks.find(book => book.id === 'u1').publication.issue, '春季増刊号')
  assert.ok(unknownInterpretation.analysisBooks.find(book => book.id === 'u2').uncertainties.some(value => value.includes('AI chapter differs')),
    'Known local chapter disagreement is visible as uncertainty without failing the result')
  await evaluate('window.auditApi.ai.verifyCandidates(' + JSON.stringify({ resultIds: [stars.id, unknownInterpretation.id] }) + ')')
  await waitUntil(async () => await evaluate("window.auditApi.getWorkspaceState().then(value=>!value.activeTask && value.channels.dedupe.status==='completed')"), 'candidate local verification')
  const verified = await evaluate("window.auditApi.getReport('dedupe')")
  assert.ok(verified.groups.some(value => value.equivalenceClasses.some(entry => entry.eligible && entry.memberIds.includes('a') && entry.memberIds.includes('b'))), 'Local recheck preserves independent strong content evidence')
  const candidateGroup = verified.groups.find(value => value.items.some(book => book.id === 'e') && value.items.some(book => book.id === 'f'))
  assert.ok(candidateGroup?.reasons.some(value => value.code === 'ai-semantic'), 'Semantic candidate enters local review with its source reason')
  assert.ok(!candidateGroup.eligible, 'AI suggestion alone does not grant automatic isolation eligibility')
  const unknownCandidateGroup = verified.groups.find(value => value.items.some(book => book.id === 'u1') && value.items.some(book => book.id === 'u2'))
  assert.ok(unknownCandidateGroup?.reasons.some(value => value.code === 'ai-semantic'))
  assert.equal(unknownCandidateGroup.eligible, false, 'Accepted AI semantics do not bypass the local isolation gate')
  assert.ok(unknownCandidateGroup.equivalenceClasses.every(value => !value.eligible))

  const autoQueue = await evaluate('window.auditApi.ai.discoverAndQueue({force:true})')
  assert.equal(autoQueue.aiState.status, 'completed')
  assert.ok(autoQueue.runId && Number.isInteger(autoQueue.pairCount))
  await waitUntil(async () => await evaluate("window.auditApi.getWorkspaceState().then(value=>!value.activeTask && value.channels.dedupe.status==='completed')"), 'AI duplicate queue')
  const autoReport = await evaluate("window.auditApi.getReport('dedupe')")
  assert.equal(autoReport.options.aiSource, 'ai-discovery', 'The duplicate report records the AI full-library source')

  const traceSnapshot = await evaluate('window.auditApi.aiTrace.snapshot(' + JSON.stringify({runId:autoQueue.runId}) + ')')
  const traced = traceSnapshot.batches.find(batch => batch.phase === 'normalizing' && batch.attempts?.length)
  assert.ok(traced && traced.savedCount > 0, 'Real AI requests are associated with validated and saved batch results')
  assert.ok(traceSnapshot.run.queueGroups !== undefined, 'Local content verification records its final review queue')
  await evaluate('document.querySelector(".log-header").click()')
  await waitUntil(async()=>await evaluate('Boolean(document.querySelector(".ai-trace-panel .el-table__body-wrapper tbody tr")?.getBoundingClientRect().height) && document.querySelector(".el-collapse-item__wrap").getBoundingClientRect().height > 100'),'visible audit batch telemetry list')
  assert.match(await evaluate('document.querySelector(".trace-summary").textContent'),/全库本数/)
  fs.writeFileSync(path.join(outputRoot,'ai-electron-batches.png'),(await audit.webContents.capturePage()).toPNG())
  await evaluate('window.auditApi.aiTrace.open(' + JSON.stringify({runId:autoQueue.runId,batchId:traced.batchId}) + ')')
  let inspector = await waitUntil(async () => {
    const win = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('ai-inspector.html'))
    return win && await win.webContents.executeJavaScript('Boolean(document.querySelector(".raw-viewer"))') ? win : null
  }, 'AI request inspector')
  const inspect = script => inspector.webContents.executeJavaScript(script)
  assert.match(await inspect('document.querySelector(".raw-viewer").value'), /messages/)
  const inspectorTags=await inspect('Array.from(document.querySelectorAll(".el-tag")).map(el=>({text:el.textContent,display:getComputedStyle(el).display,color:getComputedStyle(el).color,width:el.getBoundingClientRect().width}))')
  fs.writeFileSync(path.join(outputRoot,'inspector-tags.json'),JSON.stringify(inspectorTags,null,2))
  assert.ok(inspectorTags.some(tag=>tag.text.includes('完成')&&tag.width>0),'Completed status tags remain visible')
  assert.equal(await inspect('typeof window.aiTraceApi.saveConfig'), 'undefined')
  assert.equal(await inspect('typeof window.require'), 'undefined')
  await assert.rejects(ipcMain._invokeHandlers.get('ai:save-config')({sender:inspector.webContents,senderFrame:inspector.webContents.mainFrame},{config}), /AI_INVALID_SENDER/)
  const originalSaveDialog=dialog.showSaveDialog
  const exported=path.join(outputRoot,'trace-export.txt')
  dialog.showSaveDialog=async()=>({filePath:exported,canceled:false})
  try {
    await inspect('window.aiTraceApi.export(' + JSON.stringify({runId:autoQueue.runId,batchId:traced.batchId,requestId:traced.requestId,attempt:1,kind:'content'}) + ')')
    assert.ok(JSON.parse(fs.readFileSync(exported,'utf8')).books.length > 0)
  } finally { dialog.showSaveDialog=originalSaveDialog }
  await evaluate('window.auditApi.aiTrace.open(' + JSON.stringify({runId:autoQueue.runId,batchId:traced.batchId}) + ')')
  assert.equal(BrowserWindow.getAllWindows().filter(win=>win.webContents.getURL().includes('ai-inspector.html')).length,1)
  inspector.setContentSize(1320,900)
  await wait(250)
  fs.writeFileSync(path.join(outputRoot,'ai-electron-inspector.png'),(await inspector.webContents.capturePage()).toPNG())

  requestDelay = 15000
  const requestCount = calls.length
  await evaluate("window.auditApi.ai.start({task:'series',force:true})")
  await waitUntil(() => calls.length > requestCount, 'in-flight AI request')
  inspector.destroy()
  assert.equal((await evaluate('window.auditApi.ai.getState()')).status,'running','Closing the observer does not cancel AI')
  await assert.rejects(mainEvaluate('window.aiApi.importOAuthJson(' + JSON.stringify({ json: JSON.stringify(oauthImport) }) + ')'), /LIBRARY_AUDIT_LOCKED/)
  await assert.rejects(mainEvaluate('window.aiApi.logout({provider:"chatgpt-json"})'), /LIBRARY_AUDIT_LOCKED/)
  await assert.rejects(mainEvaluate('window.aiApi.saveConfig(' + JSON.stringify({ config: jsonConfig }) + ')'), /LIBRARY_AUDIT_LOCKED/)
  assert.equal((await mainEvaluate('window.aiApi.getConfig()')).config.provider, 'compatible', 'An active batch cannot switch credential source')
  await evaluate('window.auditApi.ai.cancel()')
  await waitUntil(async () => await evaluate("window.auditApi.ai.getState().then(value=>value.status==='cancelled')"), 'AI cancellation')
  const cancelledTrace=await evaluate('window.auditApi.aiTrace.snapshot()')
  assert.ok(cancelledTrace.batches.some(batch=>batch.status==='cancelled' && !batch.failedCount),'Cancelled work is not counted as failed analysis')
  await evaluate('window.auditApi.aiTrace.open(' + JSON.stringify({runId:autoQueue.runId,batchId:traced.batchId}) + ')')
  inspector=await waitUntil(async()=>{
    const win=BrowserWindow.getAllWindows().find(item=>item.webContents.getURL().includes('ai-inspector.html'))
    return win && await win.webContents.executeJavaScript('Boolean(document.querySelector(".raw-viewer")?.value)') ? win : null
  },'reopened AI inspector')
  assert.match(await inspect('document.querySelector(".raw-viewer").value'),/messages/)
  inspector.destroy()
  requestDelay = 0
  const oldId = audit.id
  audit.destroy()
  await mainEvaluate("window.ipcRenderer.invoke('audit:open-window')")
  audit = await waitUntil(async () => {
    const win = BrowserWindow.getAllWindows().find(item => item.id !== oldId && item.webContents.getURL().includes('audit.html'))
    return win && await win.webContents.executeJavaScript('Boolean(window.auditApi?.ai)') ? win : null
  }, 'reopened audit window')
  assert.equal((await evaluate('window.auditApi.ai.getConfig()')).hasApiKey, true)
  assert.ok((await evaluate("window.auditApi.ai.getResults({task:'series'})")).some(value => value.series?.groups.length))
  await evaluate('document.querySelector("#tab-ai-series").click()')
  await waitUntil(async () => await evaluate('Boolean(document.querySelector(".ai-series-group"))'), 'series UI rendering')
  audit.setContentSize(1320, 900)
  await wait(200)
  fs.writeFileSync(path.join(outputRoot, 'ai-electron-series.png'), (await audit.webContents.capturePage()).toPNG())

  const diagnosticGroup = autoReport.groups.find(value => value.items.some(book => book.id === 'a') && value.items.some(book => book.id === 'b'))
  const diagnosticReview = await evaluate("window.auditApi.getReview('dedupe')")
  await evaluate('window.auditApi.ai.saveConfig(' + JSON.stringify({ config: { ...config, model: 'fixture-invalid-result' } }) + ')')
  await evaluate('window.auditApi.ai.start(' + JSON.stringify({ task: 'dedupe', reportId: autoReport.reportId, groupIds: [diagnosticGroup.id], force: true }) + ')')
  const diagnosticState = await waitUntil(async () => {
    const state = await evaluate('window.auditApi.ai.getState()')
    const workspace = await evaluate('window.auditApi.getWorkspaceState()')
    return state.status === 'failed' && !workspace.lock?.locked ? state : null
  }, 'validation rejection through real IPC')
  assert.deepEqual(diagnosticState.errorDetail, { reason: 'INVALID_VALUE', path: 'relations[0].relation' })
  assert.equal(diagnosticState.classificationSucceeded, 0)
  assert.deepEqual(await evaluate("window.auditApi.getReview('dedupe')"), diagnosticReview, 'Rejected AI output preserves review choices')
  await evaluate('document.querySelector("#tab-dedupe").click()')
  await waitUntil(async () => await evaluate('Boolean(document.querySelector(".queue-item"))'), 'duplicate queue')
  assert.ok(await evaluate('(() => { const item = Array.from(document.querySelectorAll(".queue-item")).find(item => item.querySelector(".queue-item-title")?.textContent === ' + JSON.stringify(diagnosticGroup.items[0].title) + '); if (!item) return false; item.click(); return true })()'), 'Select the group with the rejected result')
  await waitUntil(async () => await evaluate('Boolean(document.querySelector("[data-ai-task=dedupe] .ai-results"))'), 'dedupe analysis panel')
  await evaluate('(() => { const details = document.querySelector("[data-ai-task=dedupe] .ai-results"); if (!details.open) details.querySelector("summary").click() })()')
  await waitUntil(async () => await evaluate('Boolean(document.querySelector(".ai-error")?.textContent.includes("relations[0].relation"))'), 'localized validation diagnostic in review UI')
  const diagnosticText = await evaluate('document.querySelector(".ai-error").textContent')
  assert.ok(diagnosticText.includes('返回字段的类型、取值或长度不符合要求'))
  assert.ok(!diagnosticText.includes('更换模型'))
  audit.show()
  audit.focus()
  for (const width of [1320, 1050]) {
    audit.setContentSize(width, 900)
    await evaluate('document.querySelector(".ai-error").scrollIntoView({block:"center"})')
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await wait(500)
    assert.ok(await evaluate('document.querySelector("#tab-dedupe").getAttribute("aria-selected") === "true" && document.querySelector(".ai-error").getClientRects().length > 0'), 'Diagnostics are visible in the selected tab')
    assert.ok(await evaluate('Array.from(document.querySelectorAll(".ai-error")).every(el => el.scrollWidth <= el.clientWidth + 1)'), 'Diagnostic text wraps within its container')
    fs.writeFileSync(path.join(outputRoot, `ai-electron-validation-${width}.png`), (await audit.webContents.capturePage()).toPNG())
  }
  assert.ok(!JSON.stringify(broadcasts).includes(secret), 'Broadcasts do not contain the credential')
  assert.ok(!JSON.stringify(broadcasts).includes(draftSecret), 'Broadcasts do not contain the unsaved credential')
  assert.ok(!JSON.stringify(broadcasts).includes(oauthSecret), 'Broadcasts do not contain OAuth credentials')
  assert.ok(!fs.readFileSync(path.join(fixtureRoot, 'setting.json'), 'utf8').includes(secret), 'General settings on disk exclude the credential')
  assert.ok(!fs.readFileSync(path.join(fixtureRoot, 'setting.json'), 'utf8').includes(draftSecret), 'General settings on disk exclude the unsaved credential')
  assert.equal(rendererErrors.length, 0, 'Renderer errors: ' + rendererErrors.join('; '))
  const terminalLogSummary = inspectTerminalLogs()
  fs.writeFileSync(path.join(outputRoot, 'ai-electron-validation.json'), JSON.stringify({ success: true, fixtureRoot, dedupeState, seriesState, discoveryState,
    seriesMembers: moon.members.map(book => book.id), candidateGroupId: candidateGroup.id, encryptedCredential: true,
    preservedReview: true, cancelled: true, reopened: true, diagnosticState, diagnosticText, modelLists, formatErrors, frontendOrigin,
    oauthCalls, oauthLoginAndInference: true, nativeLoginMigration: true, usageQuota: true, reasoningEfforts, publicationEvidence: true,
    unknownSemanticResult: unknownInterpretation.analysisBooks, localIsolationGate: unknownCandidateGroup.eligible, terminalLogSummary,
    credentialMutationsBlockedWhileRunning: true, requests: calls, broadcasts: broadcasts.length }, null, 2))
  console.log('ELECTRON_AI_SMOKE_OK')
  closeServers(); app.quit()
}
run().catch(async error => {
  if (audit && !audit.isDestroyed()) fs.writeFileSync(path.join(outputRoot, 'ai-electron-failure.png'), (await audit.webContents.capturePage()).toPNG())
  const message = String(error.stack || error).split(secret || '\0').join('[redacted]').split(draftSecret || '\0').join('[redacted]').split(oauthSecret || '\0').join('[redacted]')
  console.error(message)
  try { fs.writeFileSync(path.join(outputRoot, 'ai-electron-error.txt'), message) } catch {}
  closeServers(); app.exit(1)
})

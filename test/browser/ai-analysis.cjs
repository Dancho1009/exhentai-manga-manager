const assert = require('node:assert/strict')
const path = require('node:path')

module.exports = async ({ chromium, executablePath, baseUrl, screenshotDir }) => {
  const browser = await chromium.launch({ headless: true, executablePath })
  const page = await browser.newPage({ viewport: { width: 1320, height: 900 }, timezoneId: 'America/Los_Angeles' })
  const errors = [], screenshots = []
  page.on('pageerror', error => errors.push(error.message))
  page.setDefaultTimeout(15000)
  await page.addInitScript(() => {
    const config = { enabled: true, provider: 'compatible', baseUrl: 'http://localhost:1234/v1', model: 'fixture-model', chatgptJsonModel: '', chatgptAccountModel: '', reasoningEffort: 'medium', chatgptJsonReasoningEffort: 'medium', chatgptAccountReasoningEffort: 'medium', responseMode: 'json_schema', timeoutMs: 30000, concurrency: 1, dedupeEnabled: true, seriesEnabled: true }
    let hasApiKey = false, results = [], state = { status: 'idle' }, credentialRevision = 0
    const listeners = new Set(), authListeners = new Set()
    const authStates = {
      'chatgpt-json': { provider: 'chatgpt-json', status: 'signed-out', hasCredential: false, usable: false, account: null, loginPending: false },
      'chatgpt-account': { provider: 'chatgpt-account', status: 'signed-out', hasCredential: false, usable: false, account: null, loginPending: false }
    }
    const activeModel = value => value.provider === 'chatgpt-json' ? value.chatgptJsonModel : value.provider === 'chatgpt-account' ? value.chatgptAccountModel : value.model
    const authSummary = provider => ({ ...authStates[provider] })
    const configSummary = () => ({ config: { ...config }, hasApiKey, ready: window.fixtureReadinessOverride ?? Boolean(activeModel(config) && (config.provider === 'compatible' ? config.baseUrl : authStates[config.provider]?.usable)), ...(config.provider !== 'compatible' ? { auth: authSummary(config.provider) } : {}) })
    const publishAuth = value => { authStates[value.provider] = value; for (const listener of authListeners) listener(value); return authSummary(value.provider) }
    const fixtureAccount = { label: 'fixture-account', email: 'fixture@example.test', identityVerified: true, kind: 'codex', expiresAt: '2099-01-01T00:00:00Z', canRefresh: true, loggedInAt: Date.now() - 86400000, importedAt: null }
    const fixtureUsage = () => ({ status: 'ready', fetchedAt: Date.now(), primary: { remainingPercent: 83, resetsAt: Date.now() + 265 * 60000, windowSeconds: 18000 }, secondary: { remainingPercent: 97, resetsAt: Date.now() + 9500 * 60000, windowSeconds: 604800 } })
    window.fixtureConfig = config
    window.fixtureAuthStates = authStates
    window.fixtureCompleteLogin = () => publishAuth({ provider: 'chatgpt-account', credentialId: `fixture-${++credentialRevision}`, status: 'signed-in', hasCredential: true, usable: true, account: fixtureAccount, usage: { status: 'unavailable', fetchedAt: null, primary: null, secondary: null }, loginPending: false })
    window.fixturePublishAuth = publishAuth
    const books = [
      { id: 'a', title: '月花 (コミックメガストア Vol.13)', title_jpn: '月花', filepath: 'C:/fixture/a.zip', actualPageCount: 3, size: 100, contentProof: 'proof', aiSemantic: { chapter: null, volume: null, publication: { kind: 'embedded', name: 'コミックメガストア', issue: '13' } } },
      { id: 'b', title: '月花 第3話 (コミックメガストア Vol.16)', title_jpn: '月花 第3話', filepath: 'C:/fixture/b.zip', actualPageCount: 3, size: 100, contentProof: 'proof', aiSemantic: { chapter: { start: 3, end: null }, volume: null, publication: { kind: 'embedded', name: 'コミックメガストア', issue: '16' } } }
    ]
    const group = { id: 'g1', kind: 'strict-content', eligible: true, actionable: true, items: books, evidenceRevision: 'rev1', suggestedKeepId: 'a', reasons: [], verification: { status: 'verified' }, equivalenceClasses: [{ id: 'eq1', memberIds: ['a', 'b'], suggestedKeepId: 'a', eligible: true, kind: 'strict-content', keepReasons: [] }] }
    const report = { reportId: 'r1', schemaVersion: 4, dedupeVersion: 2, executable: true, groups: [group], summary: { mangaRows: 2, checkedItems: 2, eligibleDuplicateGroups: 1 } }
    const workspace = { activeTask: null, channels: { dedupe: { status: 'completed', latestReportId: 'r1' } }, lock: { locked: false } }
    const publish = value => { state = value; for (const listener of listeners) listener(value) }
    window.fixturePublishAi = publish
    window.fixtureCalls = []
    window.fixtureModels = ['fixture-fast', 'fixture-pro']
    window.fixtureFinish = (options = {}) => {
      if (options.failed) {
        results = [{ id: 'failed', task: state.task, reportId: 'r1', groupId: 'g1', status: 'failed', books, error: 'AI_AUTH_FAILED' }]
        publish({ ...state, status: 'failed', error: 'AI_AUTH_FAILED', failed: 1 }); return
      }
      const relation = { leftId: 'a', rightId: 'b', relation: state.task === 'series' ? 'same_series_different_part' : 'same_work_same_part', reason: '模型建议，请结合本地内容证据审核。', evidenceRefs: [] }
      const result = { id: state.task + '-result', task: state.task, reportId: state.task === 'dedupe' ? 'r1' : undefined, groupId: state.task === 'dedupe' ? 'g1' : undefined, evidenceRevision: 'rev1', createdAt: new Date().toISOString(), status: 'completed', stale: Boolean(options.stale), books, relations: [relation] }
      if (options.conflict) result.conflicts = [{ leftId: 'a', rightId: 'b', code: 'local-content-conflict' }]
      if (state.task === 'series') result.series = { groups: [{ id: 'series1', title: '月花', members: books, relations: [relation], uncertainties: ['第一本未标注话数'] }], publicationRelations: [{ ...relation, relation: 'same_publication_different_issue', reason: '杂志第35期与第38期属于不同刊物期次。' }], uncertainRelations: [] }
      results = results.filter(item => item.task !== state.task).concat(result)
      publish({ ...state, status: 'completed', phase: 'completed', completed: 1, total: 1, cached: 1, failed: 0, limited: Boolean(options.limited), candidateLimit: Boolean(options.candidateLimit), partial: Boolean(options.partial), error: null })
    }
    window.auditApi = {
      aiTrace: {
        snapshot: async () => ({seq:1,runId:'trace-fixture',runs:[{runId:'trace-fixture',status:'completed'}],run:{runId:'trace-fixture',task:'discovery',status:'completed',phase:'queue_ready',totalBooks:30,cachedBooks:0,savedBooks:30,normalizationFirstPassSaved:29,normalizationRetrySaved:1,normalizationRetryPending:0,normalizationSubmitted:30,candidateCount:1,classificationSucceeded:1,queueGroups:1},events:[],
          batches:[{runId:'trace-fixture',batchId:'normalize-1',batchIndex:1,batchTotal:1,phase:'normalizing',status:'completed',bookCount:30,pairCount:0,returnedCount:30,validatedCount:30,savedCount:30,members:[{id:'a',title:'测试批次作品'}]}]}),
        onEvents: callback => {window.fixtureTraceEvents=callback;return()=>{}},
        open: async request => {window.fixtureCalls.push({type:'openTrace',request});return{ok:true}}
      },
      loadSetting: async () => ({ language: 'zh-CN', theme: 'dark', library: 'C:/fixture' }), getLocale: async () => 'zh-CN', getWorkspaceState: async () => workspace,
      getReport: async type => type === 'dedupe' ? report : null, getReview: async type => type === 'dedupe' ? { reportId: 'r1', selections: {}, decisions: {} } : { reportId: null, actionIds: [] },
      getLogs: async () => [
        { at: '2026-10-16T23:03:34.861Z', taskType: 'dedupe', jobId: 'time-fixture', level: 'info', message: '北京时间校验：旧 UTC 日志' },
        { at: '2026-10-17T07:03:33.861+08:00', taskType: 'dedupe', jobId: 'time-fixture', level: 'info', message: '北京时间校验：新日志' }
      ], onState: () => () => {}, onLog: () => () => {}, pageRecovery: { listLatest: async () => [] }, cleanupDedupePreview: async () => {}, getDedupeHistory: async () => [],
      ai: {
        getConfig: async () => configSummary(),
        saveConfig: async request => { window.fixtureCalls.push({ type: 'saveConfig', request }); Object.assign(config, request.config); if (request.clearKey) hasApiKey = false; else if (request.apiKey) hasApiKey = true; return configSummary() },
        getAuthState: async ({ provider }) => authSummary(provider),
        onAuthState: callback => { authListeners.add(callback); return () => authListeners.delete(callback) },
        importOAuthJson: async request => {
          window.fixtureCalls.push({ type: 'importOAuthJson', request })
          if (window.fixtureOAuthError) { const code = window.fixtureOAuthError; window.fixtureOAuthError = null; throw new Error(code + ': sensitive-fixture-do-not-render') }
          return publishAuth({ provider: 'chatgpt-json', credentialId: `fixture-${++credentialRevision}`, status: 'imported', hasCredential: true, usable: true, account: { ...fixtureAccount, loggedInAt: null, importedAt: Date.now() }, usage: { status: 'unavailable', fetchedAt: null, primary: null, secondary: null }, loginPending: false })
        },
        startLogin: async request => { window.fixtureCalls.push({ type: 'startLogin', request }); return publishAuth({ ...authStates['chatgpt-account'], provider: 'chatgpt-account', status: 'waiting', usable: false, loginPending: true }) },
        reopenLogin: async () => { window.fixtureCalls.push({ type: 'reopenLogin' }); return authSummary('chatgpt-account') },
        cancelLogin: async () => { window.fixtureCalls.push({ type: 'cancelLogin' }); return publishAuth({ ...authStates['chatgpt-account'], status: 'cancelled', loginPending: false }) },
        logout: async ({ provider }) => { window.fixtureCalls.push({ type: 'logout', provider }); return publishAuth({ provider, status: 'signed-out', hasCredential: false, usable: false, account: null, loginPending: false, ...(window.fixtureRevokeWarning ? { warning: 'AI_REVOCATION_UNCONFIRMED' } : {}) }) },
        refreshUsage: async ({ provider }) => {
          window.fixtureCalls.push({ type: 'refreshUsage', provider })
          if (window.fixtureUsageError) { const error = window.fixtureUsageError; window.fixtureUsageError = null; throw new Error(error + ': sensitive-fixture-do-not-render') }
          return publishAuth({ ...authStates[provider], usage: window.fixtureUsageUnavailable ? { status: 'unavailable', error: 'AI_USAGE_UNAVAILABLE', fetchedAt: null, primary: null, secondary: null } : fixtureUsage() })
        },
        openUsagePage: async ({ provider }) => { window.fixtureCalls.push({ type: 'openUsagePage', provider }); return { ok: true } },
        testConnection: async request => {
          window.fixtureCalls.push({ type: 'test', request })
          if (window.fixtureTestError) {
            const code = window.fixtureTestError; window.fixtureTestError = null
            throw new Error("Error invoking remote method 'ai:test-connection': Error: " + code + ': Request failed')
          }
          return { ok: true, model: activeModel(request.config) }
        },
        listModels: async request => {
          window.fixtureCalls.push({ type: 'listModels', request })
          if (window.fixtureRefreshDuringModels) {
            window.fixtureRefreshDuringModels = false
            const provider = request.config.provider
            publishAuth({ ...authStates[provider], account: { ...authStates[provider].account, expiresAt: Date.parse('2099-01-02T00:00:00Z') } })
          }
          const models = request.config.provider === 'compatible' ? [...window.fixtureModels] : ['gpt-fixture'], error = window.fixtureModelError
          window.fixtureModelError = null
          if (window.fixtureHoldModels) {
            window.fixtureHoldModels = false
            await new Promise(resolve => { window.fixtureReleaseModels = resolve })
          }
          if (error) throw new Error('Error invoking remote method: ' + error)
          return { models, ...(request.config.provider !== 'compatible' ? { modelOptions: [{ id: 'gpt-fixture', label: 'GPT Fixture', ...(window.fixtureReasoningEfforts ? { reasoningEfforts: window.fixtureReasoningEfforts } : {}) }] } : {}) }
        },
        getState: async () => state, getResults: async filter => results.filter(result => result.task === filter.task && (!filter.reportId || result.reportId === filter.reportId)),
        discoverAndQueue: async request => { window.fixtureCalls.push({type:'discoverAndQueue',request}); publish({status:'completed',task:'discovery',phase:'completed',partial:false});return{} },
        start: async request => { window.fixtureCalls.push({ type: 'start', request }); publish({ status: 'running', task: request.task, completed: 0, total: 1, phase: request.task === 'dedupe' ? 'classifying' : 'normalizing' }); return state },
        cancel: async () => { publish({ ...state, status: 'cancelled' }); return state },
        onState: callback => { listeners.add(callback); return () => listeners.delete(callback) },
      }
    }
    window.aiApi = window.auditApi.ai
    window.ipcRenderer = {
      on: () => {}, removeAllListeners: () => {}, sendSync: () => '/',
      invoke: async channel => {
        if (channel === 'load-setting') return { language: 'zh-CN', theme: 'dark', library: 'C:/fixture', pageSize: 12, autoCheckUpdates: false, showTranslation: false, disableRandomTag: true, loadOnStart: false }
        if (channel === 'load-book-list' || channel === 'load-collection-list' || channel === 'get-folder-tree') return []
        if (channel === 'get-locale') return 'zh-CN'
        return null
      }
    }
    window.electronFunction = { 'get-zoom-level': () => 0, 'set-zoom-level': () => {}, 'insert-css': () => {} }
  })
  try {
    await page.goto(baseUrl + '/audit.html')
    await page.locator('.log-header').click()
    await page.locator('.ai-trace-panel').waitFor({state:'visible'})
    await page.locator('.ai-trace-panel .el-table__body-wrapper tbody tr').waitFor({state:'visible'})
    assert.match(await page.locator('.ai-trace-panel').innerText(),/30 \/ 30 \/ 30/)
    assert.match(await page.locator('.trace-summary').innerText(),/首次保存 29/)
    assert.match(await page.locator('.trace-summary').innerText(),/补试保存 1/)
    assert.match(await page.locator('.trace-summary').innerText(),/待补试 0/)
    assert.match(await page.locator('.trace-summary').innerText(),/尚未请求 0/)
    await page.locator('.ai-trace-panel').getByRole('button',{name:'查看请求',exact:true}).click()
    assert.deepEqual(await page.evaluate(()=>window.fixtureCalls.find(call=>call.type==='openTrace').request),{runId:'trace-fixture',batchId:'normalize-1'})
    await page.locator('.ai-trace-panel').scrollIntoViewIfNeeded()
    const batchScreenshot=path.join(screenshotDir,'ai-audit-batches-1320.png')
    await page.screenshot({path:batchScreenshot,animations:'disabled'});screenshots.push(batchScreenshot)
    const oldTimeLog = page.locator('.log-line').filter({ hasText: '北京时间校验：旧 UTC 日志' })
    const newTimeLog = page.locator('.log-line').filter({ hasText: '北京时间校验：新日志' })
    assert.equal(await oldTimeLog.locator('span').first().innerText(), '2026-10-17 07:03:34')
    assert.equal(await newTimeLog.locator('span').first().innerText(), '2026-10-17 07:03:33')
    const timeLogs = await page.locator('.log-line').filter({ hasText: '北京时间校验：' }).allTextContents()
    assert.ok(timeLogs[0].includes('新日志') && timeLogs[1].includes('旧 UTC 日志'))
    await page.getByRole('tab', { name: '重复检查', exact: true }).click()
    await page.evaluate(() => window.fixturePublishAi({status:'completed',task:'discovery',phase:'normalizing',partial:true,total:30,completed:29,normalizationSucceeded:29,normalizationMissing:1}))
    await page.getByRole('button',{name:'继续未完成分析',exact:true}).waitFor()
    assert.match(await page.locator('.ai-task-band').innerText(),/部分分析完成/)
    const continuationScreenshot=path.join(screenshotDir,'ai-analysis-continue.png')
    await page.screenshot({path:continuationScreenshot,animations:'disabled'});screenshots.push(continuationScreenshot)
    await page.getByRole('button',{name:'继续未完成分析',exact:true}).click()
    await page.waitForFunction(()=>window.fixtureCalls.some(call=>call.type==='discoverAndQueue'))
    assert.deepEqual(await page.evaluate(()=>window.fixtureCalls.find(call=>call.type==='discoverAndQueue').request),{force:false})
    await page.locator('.ai-task-band').waitFor({state:'hidden'})
    const panel = page.locator('[data-ai-task="dedupe"]')
    await panel.waitFor()
    const keeper = page.locator('.member-card[data-book-id="b"]').getByRole('checkbox', { name: '保留这本', exact: true })
    await page.locator('.member-card[data-book-id="b"] .member-selection .el-checkbox').click()
    assert.equal(await keeper.isChecked(), false)
    await panel.getByRole('button', { name: 'AI 分析本组', exact: true }).click()
    await page.waitForFunction(() => window.fixtureCalls.some(call => call.type === 'start'))
    assert.equal(await page.locator('.dedupe-panel .task-toolbar').getByRole('button', { name: '开始重复检查', exact: true }).isDisabled(), true)
    assert.equal(await keeper.isDisabled(), false)
    assert.deepEqual(await page.evaluate(() => window.fixtureCalls.find(call => call.type === 'start').request), { task: 'dedupe', reportId: 'r1', groupIds: ['g1'], force: false })
    const before = await page.evaluate(() => { const element = document.querySelector('.comparison-scroll'); element.scrollTop = 65; return element.scrollTop })
    await page.evaluate(() => window.fixtureFinish())
    await panel.getByText('分析结果（1）', { exact: false }).waitFor()
    assert.equal(await keeper.isChecked(), false)
    assert.equal(await page.locator('.comparison-scroll').evaluate(element => element.scrollTop), before)
    assert.equal(await page.locator('.queue-item.selected').count(), 1)
    await panel.locator('summary').click()
    await panel.getByText('同作品同一话', { exact: true }).waitFor()
    await panel.getByRole('button', { name: '重新请求 AI', exact: true }).click()
    await page.evaluate(() => window.fixtureFinish({ conflict: true }))
    await panel.getByText('AI 语义判断与本地已验证的相同内容冲突，本地重复证据仍保留。', { exact: true }).waitFor()
    assert.equal(await keeper.isChecked(), false)
    await panel.getByRole('button', { name: '重新请求 AI', exact: true }).click()
    await page.evaluate(() => window.fixtureFinish({ failed: true }))
    await panel.getByText('服务鉴权失败，请检查 Key 和模型访问权限。', { exact: true }).first().waitFor()
    await panel.getByRole('button', { name: 'AI 分析本组', exact: true }).click()
    await panel.getByRole('button', { name: '停止 AI 分析', exact: true }).click()
    await panel.getByText('已停止', { exact: true }).waitFor()
    assert.equal(await keeper.isChecked(), false)

    await panel.getByRole('button', { name: 'AI 辅助判断', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'AI 辅助判断' })
    assert.equal(await dialog.getByText('单轮请求上限', { exact: true }).count(), 0)
    const modelPicker = dialog.getByTestId('ai-model')
    const getModels = dialog.getByRole('button', { name: '获取模型', exact: true })
    const selectModel = async name => {
      await modelPicker.locator('input').fill(name)
      await page.getByRole('option', { name, exact: true }).click()
      await modelPicker.getByText(name, { exact: true }).waitFor()
    }
    assert.equal(await page.evaluate(() => window.fixtureCalls.some(call => call.type === 'listModels')), false)
    await dialog.getByTestId('ai-base-url').fill('http://localhost:4321/v1')
    await dialog.getByTestId('ai-key').fill('fixture-key')
    await dialog.getByTestId('ai-enabled').click()
    await modelPicker.hover()
    await modelPicker.locator('.el-select__clear').click()
    await getModels.click()
    await dialog.getByText('已获取 2 个模型，选择后保存即可使用。', { exact: true }).waitFor()
    const modelRequest = await page.evaluate(() => window.fixtureCalls.find(call => call.type === 'listModels').request)
    assert.equal(modelRequest.config.baseUrl, 'http://localhost:4321/v1')
    assert.equal(modelRequest.apiKey, 'fixture-key')
    assert.equal(modelRequest.config.enabled, false)
    assert.equal(Boolean(modelRequest.config.model), false)
    assert.equal(await page.evaluate(() => window.fixtureCalls.some(call => call.type === 'saveConfig')), false)
    await selectModel('fixture-fast')
    await dialog.getByRole('button', { name: '测试连接', exact: true }).click()
    await dialog.getByText('连接与返回格式验证成功：fixture-fast').waitFor()
    await dialog.getByTestId('ai-enabled').click()
    assert.equal(await dialog.getByTestId('ai-stream').locator('input').isChecked(), false)
    const streamBounds = await dialog.getByTestId('ai-stream').boundingBox()
    const streamNoteBounds = await dialog.locator('.ai-stream-note').boundingBox()
    assert.ok(streamNoteBounds.y >= streamBounds.y + streamBounds.height, 'Streaming help appears below the switch')
    await dialog.getByTestId('ai-stream').click()
    await dialog.getByTestId('ai-batch-size').locator('input').fill('3')
    await dialog.getByTestId('ai-concurrency').locator('input').fill('25')
    assert.match(await dialog.getByTestId('ai-thinking-mode').innerText(),/跟随上游/)
    await dialog.getByTestId('ai-thinking-mode').click()
    await page.getByRole('option',{name:'开启思考',exact:true}).click()
    assert.match(await dialog.getByTestId('ai-compatible-effort').innerText(),/低/)
    await dialog.getByTestId('ai-thinking-protocol').click()
    await page.getByRole('option',{name:'OpenAI Chat Completions',exact:true}).click()
    await dialog.getByTestId('ai-max-output-tokens').locator('input').fill('32768')
    await dialog.getByTestId('ai-max-output-tokens').locator('input').blur()
    await dialog.getByTestId('ai-output-token-field').click()
    await page.getByRole('option',{name:'max_completion_tokens',exact:true}).click()
    await dialog.getByTestId('ai-thinking-protocol').click()
    await page.getByRole('option',{name:'DeepSeek',exact:true}).click()
    await dialog.getByTestId('ai-thinking-mode').click()
    await page.getByRole('option',{name:'关闭思考',exact:true}).click()
    assert.equal(await dialog.getByTestId('ai-compatible-effort').count(),0)
    await dialog.getByTestId('ai-output-token-field').click()
    await page.getByRole('option',{name:'max_tokens',exact:true}).click()
    await dialog.getByRole('button', { name: '保存 AI 设置', exact: true }).click()
    await dialog.getByText('AI 设置已保存', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.fixtureConfig.normalizationBatchSize), 3)
    assert.equal(await page.evaluate(() => window.fixtureConfig.concurrency), 25)
    assert.equal(await page.evaluate(() => window.fixtureConfig.stream), true)
    assert.deepEqual(await page.evaluate(()=>({mode:window.fixtureConfig.compatibleThinkingMode,protocol:window.fixtureConfig.compatibleReasoningProtocol,max:window.fixtureConfig.compatibleMaxOutputTokens,field:window.fixtureConfig.compatibleOutputTokenField})),{mode:'disabled',protocol:'deepseek',max:32768,field:'max_tokens'})
    assert.equal(await page.evaluate(() => Object.hasOwn(window.fixtureCalls.filter(call => call.type === 'saveConfig').at(-1).request.config, 'maxRequests')), false)
    assert.equal(await dialog.getByTestId('ai-key').inputValue(), '')
    assert.match(await dialog.getByTestId('ai-key').getAttribute('placeholder'), /已加密保存/)
    await dialog.locator('.el-dialog__headerbtn').click()
    await dialog.waitFor({ state: 'hidden' })
    await panel.getByRole('button', { name: 'AI 辅助判断', exact: true }).click()
    await modelPicker.getByText('fixture-fast', { exact: true }).waitFor()
    assert.equal(await dialog.getByTestId('ai-batch-size').locator('input').inputValue(), '3')
    assert.equal(await dialog.getByTestId('ai-concurrency').locator('input').inputValue(), '25')
    assert.equal(await dialog.getByTestId('ai-stream').locator('input').isChecked(), true)
    assert.equal(await dialog.getByTestId('ai-key').inputValue(), '')
    await getModels.click()
    await dialog.getByText('已获取 2 个模型，选择后保存即可使用。', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => Object.hasOwn(window.fixtureCalls.filter(call => call.type === 'listModels').at(-1).request, 'apiKey')), false)
    await modelPicker.getByText('fixture-fast', { exact: true }).waitFor()
    for (const width of [1320, 520]) {
      await page.setViewportSize({ width, height: 900 })
      await modelPicker.click()
      await page.getByRole('option', { name: 'fixture-pro', exact: true }).waitFor()
      const filename = path.join(screenshotDir, `ai-model-picker-${width}.png`)
      await page.screenshot({ path: filename, animations: 'disabled' }); screenshots.push(filename)
      const bounds = await dialog.boundingBox()
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, 'Model settings fit the viewport')
      await modelPicker.locator('input').press('Escape')
      await dialog.getByTestId('ai-thinking-mode').scrollIntoViewIfNeeded()
      const controlsShot=path.join(screenshotDir,`ai-compatible-controls-${width}.png`)
      await page.screenshot({path:controlsShot,animations:'disabled'});screenshots.push(controlsShot)
      for(const testId of ['ai-thinking-protocol','ai-thinking-mode','ai-max-output-tokens','ai-output-token-field']){
        const bounds=await dialog.getByTestId(testId).boundingBox()
        assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width,'Compatible controls fit the viewport')
      }
      await dialog.getByTestId('ai-batch-size').scrollIntoViewIfNeeded()
      const settingsShot = path.join(screenshotDir, `ai-request-settings-${width}.png`)
      await page.screenshot({ path: settingsShot, animations: 'disabled' }); screenshots.push(settingsShot)
      for (const testId of ['ai-batch-size', 'ai-concurrency']) {
        const inputBounds = await dialog.getByTestId(testId).boundingBox()
        assert.ok(inputBounds.x >= 0 && inputBounds.x + inputBounds.width <= width, 'Request settings fit the viewport')
      }
    }
    await page.setViewportSize({ width: 1320, height: 900 })
    await page.evaluate(() => { window.fixtureHoldModels = true })
    await getModels.click()
    await page.waitForFunction(() => typeof window.fixtureReleaseModels === 'function')
    assert.equal(await getModels.isDisabled(), true)
    await dialog.getByTestId('ai-base-url').fill('http://localhost:9876/v1')
    await page.evaluate(() => window.fixtureReleaseModels())
    await page.waitForFunction(() => !document.querySelector('.ai-model-picker .el-button').disabled)
    assert.equal(await dialog.getByText('已获取 2 个模型，选择后保存即可使用。', { exact: true }).count(), 0)
    await modelPicker.click()
    assert.equal(await page.getByRole('option', { name: 'fixture-pro', exact: true }).count(), 0)
    await modelPicker.locator('input').press('Escape')
    await page.evaluate(() => { window.fixtureModels = [] })
    await getModels.click()
    await dialog.getByText('服务未返回可用模型，可手动输入模型名称。', { exact: true }).waitFor()
    await modelPicker.getByText('fixture-fast', { exact: true }).waitFor()
    await page.evaluate(() => { window.fixtureModelError = 'AI_INVALID_MODEL_LIST' })
    await getModels.click()
    await dialog.getByText('服务返回的模型列表格式无效，可检查服务地址或手动输入模型名称。', { exact: true }).waitFor()
    await page.evaluate(() => { window.fixtureModels = ['fixture-fast', 'fixture-pro'] })
    await getModels.click()
    await dialog.getByText('已获取 2 个模型，选择后保存即可使用。', { exact: true }).waitFor()
    const requestsBeforeKeyEdit = await page.evaluate(() => window.fixtureCalls.filter(call => call.type === 'listModels').length)
    await dialog.getByTestId('ai-key').fill('updated-fixture-key')
    assert.equal(await dialog.getByText('已获取 2 个模型，选择后保存即可使用。', { exact: true }).count(), 0)
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(call => call.type === 'listModels').length), requestsBeforeKeyEdit)
    await selectModel('manual-model')
    await dialog.getByRole('button', { name: '保存 AI 设置', exact: true }).click()
    await dialog.getByText('AI 设置已保存', { exact: true }).waitFor()
    await dialog.locator('.el-dialog__headerbtn').click()
    await dialog.waitFor({ state: 'hidden' })
    await panel.getByRole('button', { name: 'AI 辅助判断', exact: true }).click()
    await modelPicker.getByText('manual-model', { exact: true }).waitFor()
    const responseMode = dialog.getByTestId('ai-response-mode')
    const callsBeforeAddressEdit = await page.evaluate(() => window.fixtureCalls.length)
    await dialog.getByTestId('ai-base-url').fill('https://api.deepseek.com/v1')
    await dialog.getByText('DeepSeek 的对话接口支持 JSON 对象模式，已自动选择。', { exact: true }).waitFor()
    await responseMode.getByText('JSON 对象（json_object）', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.fixtureCalls.length), callsBeforeAddressEdit, 'Provider changes never send a request automatically')
    await responseMode.click()
    assert.equal(await page.getByRole('option', { name: '结构化 JSON（json_schema）', exact: true }).getAttribute('aria-disabled'), 'true')
    await responseMode.locator('input').press('Escape')
    await dialog.getByRole('button', { name: '测试连接', exact: true }).click()
    await dialog.getByText('连接与返回格式验证成功：manual-model', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(call => call.type === 'test').at(-1).request.config.responseMode), 'json_object')
    await dialog.getByRole('button', { name: '保存 AI 设置', exact: true }).click()
    await dialog.getByText('AI 设置已保存', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(call => call.type === 'saveConfig').at(-1).request.config.responseMode), 'json_object')
    await dialog.locator('.el-dialog__headerbtn').click()
    await dialog.waitFor({ state: 'hidden' })
    await panel.getByRole('button', { name: 'AI 辅助判断', exact: true }).click()
    await responseMode.getByText('JSON 对象（json_object）', { exact: true }).waitFor()
    for (const width of [1320, 520]) {
      await page.setViewportSize({ width, height: 900 })
      await responseMode.click()
      const filename = path.join(screenshotDir, `ai-deepseek-format-${width}.png`)
      await page.screenshot({ path: filename, animations: 'disabled' }); screenshots.push(filename)
      const bounds = await dialog.boundingBox()
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, 'Provider note fits the viewport')
      assert.equal(await dialog.locator('.ai-settings').evaluate(node => node.scrollWidth > node.clientWidth), false)
      await responseMode.locator('input').press('Escape')
    }
    await page.setViewportSize({ width: 1320, height: 900 })
    await dialog.getByTestId('ai-base-url').fill('https://api.deepseek.com.example.org/v1')
    assert.equal(await dialog.getByText('DeepSeek 的对话接口支持 JSON 对象模式，已自动选择。', { exact: true }).count(), 0)
    await responseMode.click()
    assert.notEqual(await page.getByRole('option', { name: '结构化 JSON（json_schema）', exact: true }).getAttribute('aria-disabled'), 'true')
    await page.getByRole('option', { name: '结构化 JSON（json_schema）', exact: true }).click()
    await responseMode.getByText('结构化 JSON（json_schema）', { exact: true }).waitFor()
    await page.evaluate(() => { window.fixtureTestError = 'AI_RESPONSE_FORMAT_UNSUPPORTED' })
    await dialog.getByRole('button', { name: '测试连接', exact: true }).click()
    await dialog.getByText('服务或当前模型不支持所选返回格式，请切换为 JSON 对象模式，或选择支持该格式的模型。', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(call => call.type === 'test').at(-1).request.config.responseMode), 'json_schema')
    await dialog.getByRole('button', { name: '清除已存 Key', exact: true }).click()
    await dialog.getByText('已清除保存的 Key', { exact: true }).waitFor()

    const providerPicker = dialog.getByTestId('ai-provider')
    const chooseProvider = async name => { await providerPicker.click(); await page.getByRole('option', { name, exact: true }).click() }
    await dialog.getByTestId('ai-key').fill('unsaved-compatible-key')
    const oldAddress = await dialog.getByTestId('ai-base-url').inputValue()
    const oldModel = await modelPicker.innerText()
    await chooseProvider('ChatGPT (JSON)')
    assert.equal(await dialog.getByTestId('ai-base-url').count(), 0)
    assert.equal(await dialog.getByTestId('ai-key').count(), 0)
    assert.equal(await dialog.getByTestId('ai-response-mode').count(), 0)
    const reasoningPicker = dialog.getByTestId('ai-reasoning-effort')
    const chooseReasoning = async name => { await reasoningPicker.click(); await page.getByRole('option', { name, exact: true }).click() }
    await reasoningPicker.getByText('中', { exact: true }).waitFor()
    assert.equal(await getModels.isDisabled(), true)
    assert.equal(await dialog.getByRole('button', { name: '测试连接', exact: true }).isDisabled(), true)
    const jsonInput = dialog.getByTestId('ai-oauth-json')
    await jsonInput.fill('{invalid-json}')
    await page.evaluate(() => { window.fixtureOAuthError = 'AI_OAUTH_JSON_INVALID' })
    await dialog.getByRole('button', { name: '校验并导入', exact: true }).click()
    await dialog.getByText('JSON 格式或必需字段不正确，请粘贴完整凭据。', { exact: true }).waitFor()
    assert.equal(await jsonInput.inputValue(), '{invalid-json}')
    assert.equal((await dialog.innerText()).includes('sensitive-fixture-do-not-render'), false)
    await jsonInput.fill('{"access_token":"fixture-access","refresh_token":"fixture-refresh","account_id":"fixture-account"}')
    await dialog.getByRole('button', { name: '校验并导入', exact: true }).click()
    await dialog.getByText('凭据已加密导入，请获取模型并测试连接。', { exact: true }).waitFor()
    assert.equal(await dialog.getByTestId('ai-oauth-json').count(), 0)
    await dialog.getByText('fixture@example.test', { exact: true }).waitFor()
    assert.match(await dialog.getByTestId('ai-account-date').innerText(), /导入/)
    assert.equal(await dialog.getByTestId('ai-usage-primary').getByRole('progressbar').getAttribute('aria-valuenow'), null)
    assert.equal(await dialog.getByTestId('ai-usage-primary').getByText('未获取', { exact: true }).count(), 1)
    assert.equal(await dialog.getByTestId('ai-usage-secondary').getByText('未获取', { exact: true }).count(), 1)
    assert.equal(await dialog.getByText('此登录方式未提供额度查询，额度状态暂不可用。', { exact: true }).count(), 0, 'Not-yet-fetched usage is not reported as unsupported')
    await dialog.getByTestId('ai-refresh-usage').click()
    await dialog.getByTestId('ai-usage-primary').getByText('剩余 83%', { exact: true }).waitFor()
    await dialog.getByTestId('ai-usage-secondary').getByText('剩余 97%', { exact: true }).waitFor()
    assert.match(await dialog.getByTestId('ai-usage-primary').innerText(), /4小时\s*25分钟 后重置/)
    assert.match(await dialog.getByTestId('ai-usage-secondary').innerText(), /6天/)
    assert.match(await dialog.getByTestId('ai-usage-updated').innerText(), /刚刚/)
    await page.evaluate(() => { window.fixtureUsageError = 'AI_USAGE_FETCH_FAILED' })
    await dialog.getByTestId('ai-refresh-usage').click()
    await dialog.getByText('额度获取失败，可稍后重试；已获取的额度仍保留。', { exact: true }).waitFor()
    assert.equal(await dialog.getByTestId('ai-usage-primary').getByRole('progressbar').getAttribute('aria-valuenow'), '83')
    assert.equal((await dialog.innerText()).includes('sensitive-fixture-do-not-render'), false)
    await dialog.getByTestId('ai-refresh-usage').click()
    await dialog.getByTestId('ai-usage-primary').getByText('剩余 83%', { exact: true }).waitFor()
    await dialog.getByText('已导入，尚未测试', { exact: true }).waitFor()
    assert.equal((await dialog.innerText()).includes('fixture-access'), false)
    await page.evaluate(() => { window.fixtureRefreshDuringModels = true })
    await getModels.click()
    await dialog.getByText('已获取 1 个模型，选择后保存即可使用。', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => Object.hasOwn(window.fixtureCalls.filter(call => call.type === 'listModels').at(-1).request, 'apiKey')), false)
    await modelPicker.locator('input').fill('invented-model')
    assert.equal(await page.getByRole('option', { name: 'invented-model', exact: true }).count(), 0)
    await modelPicker.locator('input').fill('GPT Fixture')
    await page.getByRole('option', { name: 'GPT Fixture', exact: true }).click()
    for (const level of ['低', '中', '高', '极高', 'Max', 'Ultra']) {
      await chooseReasoning(level)
      await reasoningPicker.getByText(level, { exact: true }).waitFor()
    }
    await page.evaluate(() => { window.fixtureReasoningEfforts = ['low', 'medium', 'high', 'xhigh'] })
    await getModels.click()
    await dialog.getByText('当前模型不支持已选思考程度，请选择可用档位。', { exact: true }).waitFor()
    await reasoningPicker.click()
    assert.equal(await page.getByRole('option', { name: 'Max', exact: true }).getAttribute('aria-disabled'), 'true')
    assert.equal(await page.getByRole('option', { name: 'Ultra', exact: true }).getAttribute('aria-disabled'), 'true')
    await page.getByRole('option', { name: '高', exact: true }).click()
    await dialog.getByRole('button', { name: '测试连接', exact: true }).click()
    await dialog.getByText('连接与返回格式验证成功：gpt-fixture', { exact: true }).waitFor()
    await dialog.getByText('连接正常', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '保存 AI 设置', exact: true }).click()
    await dialog.getByText('AI 设置已保存', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(call => call.type === 'saveConfig').at(-1).request.config.chatgptJsonModel), 'gpt-fixture')
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(call => call.type === 'test').at(-1).request.config.chatgptJsonReasoningEffort), 'high')
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(call => call.type === 'saveConfig').at(-1).request.config.chatgptJsonReasoningEffort), 'high')
    assert.equal(await page.evaluate(() => Object.hasOwn(window.fixtureCalls.filter(call => call.type === 'saveConfig').at(-1).request, 'apiKey')), false)
    await dialog.getByText('连接正常', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '重新导入', exact: true }).click()
    assert.equal(await jsonInput.inputValue(), '')
    await jsonInput.fill('{bad-replacement}')
    await page.evaluate(() => { window.fixtureOAuthError = 'AI_OAUTH_UNSUPPORTED' })
    await dialog.getByRole('button', { name: '校验并导入', exact: true }).click()
    await dialog.getByText('暂不支持此凭据类型，请使用网页登录或导入支持的 OAuth JSON。', { exact: true }).waitFor()
    await dialog.getByText('fixture@example.test', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '取消替换', exact: true }).click()
    await page.evaluate(() => {
      const current = window.fixtureAuthStates['chatgpt-json']
      window.fixtureAccountBeforeMissing = current.account
      window.fixturePublishAuth({ ...current, account: { ...current.account, email: null, loggedInAt: null, importedAt: null } })
    })
    await dialog.getByText('邮箱未提供', { exact: true }).waitFor()
    await dialog.getByTestId('ai-account-date').getByText('登录日期未记录', { exact: true }).waitFor()
    await page.evaluate(() => window.fixturePublishAuth({ ...window.fixtureAuthStates['chatgpt-json'], account: window.fixtureAccountBeforeMissing }))
    await chooseProvider('兼容 API（现有方式）')
    assert.equal(await dialog.getByTestId('ai-key').inputValue(), 'unsaved-compatible-key')
    assert.equal(await dialog.getByTestId('ai-base-url').inputValue(), oldAddress)
    assert.equal(await modelPicker.innerText(), oldModel)
    await chooseProvider('ChatGPT (JSON)')
    await modelPicker.getByText('gpt-fixture', { exact: true }).waitFor()
    await reasoningPicker.getByText('高', { exact: true }).waitFor()
    for (const width of [1320, 520]) {
      await page.setViewportSize({ width, height: 900 })
      const filename = path.join(screenshotDir, `ai-chatgpt-json-${width}.png`)
      await dialog.getByTestId('ai-auth-panel').scrollIntoViewIfNeeded()
      await dialog.evaluate(node => { for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) ancestor.scrollTop = 0 })
      await page.screenshot({ path: filename, animations: 'disabled' }); screenshots.push(filename)
      assert.equal(await dialog.locator('.ai-settings').evaluate(node => node.scrollWidth > node.clientWidth), false)
    }
    await page.setViewportSize({ width: 1320, height: 900 })
    await dialog.getByRole('button', { name: '清除凭据', exact: true }).click()
    await dialog.getByText('已清除本地凭据', { exact: true }).waitFor()
    assert.equal(await jsonInput.inputValue(), '')
    assert.equal(await getModels.isDisabled(), true)

    await chooseProvider('ChatGPT (Account)')
    await reasoningPicker.getByText('中', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '通过网页登录', exact: true }).click()
    await dialog.getByText('等待浏览器授权', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '重新打开浏览器', exact: true }).click()
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(call => call.type === 'reopenLogin').length), 1)
    assert.equal(await getModels.isDisabled(), true)
    await dialog.locator('.el-dialog__headerbtn').click()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(call => call.type === 'cancelLogin').length), 0, 'Closing settings does not cancel application-wide login')
    await panel.getByRole('button', { name: 'AI 辅助判断', exact: true }).click()
    await chooseProvider('ChatGPT (Account)')
    await dialog.getByText('等待浏览器授权', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '取消登录', exact: true }).click()
    await dialog.getByText('已取消登录', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '通过网页登录', exact: true }).click()
    await page.evaluate(() => window.fixtureCompleteLogin())
    await dialog.getByText('已登录', { exact: true }).waitFor()
    assert.match(await dialog.getByTestId('ai-account-date').innerText(), /登录/)
    await dialog.getByTestId('ai-refresh-usage').click()
    await dialog.getByTestId('ai-usage-primary').getByText('剩余 83%', { exact: true }).waitFor()
    await dialog.getByTestId('ai-usage-secondary').getByText('剩余 97%', { exact: true }).waitFor()
    await page.evaluate(() => { window.fixtureReasoningEfforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] })
    await getModels.click()
    await dialog.getByText('已获取 1 个模型，选择后保存即可使用。', { exact: true }).waitFor()
    await modelPicker.locator('input').fill('GPT Fixture')
    await page.getByRole('option', { name: 'GPT Fixture', exact: true }).click()
    await chooseReasoning('Ultra')
    await dialog.getByRole('button', { name: '测试连接', exact: true }).click()
    await dialog.getByText('连接与返回格式验证成功：gpt-fixture', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '保存 AI 设置', exact: true }).click()
    await dialog.getByText('AI 设置已保存', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.fixtureConfig.chatgptAccountModel), 'gpt-fixture')
    assert.equal(await page.evaluate(() => window.fixtureConfig.chatgptAccountReasoningEffort), 'ultra')
    await chooseProvider('ChatGPT (JSON)')
    await reasoningPicker.getByText('高', { exact: true }).waitFor()
    await chooseProvider('ChatGPT (Account)')
    await reasoningPicker.getByText('Ultra', { exact: true }).waitFor()
    for (const width of [1320, 520]) {
      await page.setViewportSize({ width, height: 900 })
      await dialog.getByTestId('ai-auth-panel').scrollIntoViewIfNeeded()
      await dialog.evaluate(node => { for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) ancestor.scrollTop = 0 })
      const filename = path.join(screenshotDir, `ai-chatgpt-account-${width}.png`)
      await page.screenshot({ path: filename, animations: 'disabled' }); screenshots.push(filename)
      assert.equal(await dialog.locator('.ai-settings').evaluate(node => node.scrollWidth > node.clientWidth), false)
    }
    await page.setViewportSize({ width: 1320, height: 900 })
    await page.evaluate(() => {
      const current = window.fixtureAuthStates['chatgpt-account']
      window.fixturePublishAuth({ ...current, usage: { ...current.usage, primary: { remainingPercent: 0, resetsAt: Date.now() - 1000, windowSeconds: 7200 }, secondary: null } })
    })
    await dialog.getByTestId('ai-usage-primary').getByText('2小时', { exact: true }).waitFor()
    await dialog.getByTestId('ai-usage-primary').getByText('剩余 0%', { exact: true }).waitFor()
    await dialog.getByTestId('ai-usage-primary').getByText('等待额度更新', { exact: true }).waitFor()
    assert.equal(await dialog.getByTestId('ai-usage-secondary').getByText('未获取', { exact: true }).count(), 1)
    await page.evaluate(() => { window.fixtureUsageUnavailable = true })
    await dialog.getByTestId('ai-refresh-usage').click()
    await dialog.getByText('此登录方式未提供额度查询，额度状态暂不可用。', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '打开 ChatGPT 用量页', exact: true }).click()
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(call => call.type === 'openUsagePage').at(-1).provider), 'chatgpt-account')
    await page.evaluate(() => { window.fixtureUsageUnavailable = false })
    await dialog.getByTestId('ai-refresh-usage').click()
    await dialog.getByTestId('ai-usage-primary').getByText('剩余 83%', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '切换账户', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.fixtureCalls.filter(call => call.type === 'startLogin').at(-1).request), { newAccount: true })
    await page.evaluate(() => window.fixtureCompleteLogin())
    await dialog.getByText('已登录', { exact: true }).waitFor()
    await page.evaluate(() => { window.fixtureRevokeWarning = true })
    await dialog.getByRole('button', { name: '退出登录', exact: true }).click()
    await dialog.getByText('本地已退出登录，服务端凭据撤销尚未确认。', { exact: true }).waitFor()
    assert.equal(await dialog.getByTestId('ai-account-label').count(), 0)
    await page.evaluate(() => { window.fixtureRevokeWarning = false; window.fixtureCompleteLogin() })
    await dialog.getByText('已登录', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '保存 AI 设置', exact: true }).click()
    await dialog.getByText('AI 设置已保存', { exact: true }).waitFor()
    await dialog.locator('.el-dialog__headerbtn').click()
    await dialog.waitFor({ state: 'hidden' })
    await page.evaluate(() => { window.fixtureReadinessOverride = true; window.fixtureConfig.baseUrl = ''; window.fixtureConfig.model = '' })
    const startsBeforeAccountAnalysis = await page.evaluate(() => window.fixtureCalls.filter(call => call.type === 'start').length)
    await panel.getByRole('button', { name: 'AI 分析本组', exact: true }).click()
    await page.waitForFunction(count => window.fixtureCalls.filter(call => call.type === 'start').length > count, startsBeforeAccountAnalysis)
    await page.evaluate(() => window.fixtureFinish())
    await panel.getByText('分析完成', { exact: true }).waitFor()
    await page.evaluate(() => { window.fixtureReadinessOverride = false })
    await panel.getByRole('button', { name: 'AI 分析本组', exact: true }).click()
    await dialog.waitFor()
    await panel.getByText('请在 AI 设置中填写服务和模型，并启用当前检查类型。', { exact: true }).waitFor()
    await page.evaluate(() => { delete window.fixtureReadinessOverride })
    await chooseProvider('兼容 API（现有方式）')
    await dialog.getByTestId('ai-base-url').fill(oldAddress)
    await selectModel('manual-model')
    await dialog.getByRole('button', { name: '保存 AI 设置', exact: true }).click()
    await dialog.getByText('AI 设置已保存', { exact: true }).waitFor()
    await dialog.locator('.el-dialog__headerbtn').click()

    await page.getByRole('tab', { name: '系列检查', exact: true }).click()
    const series = page.locator('[data-ai-task="series"]')
    await series.getByRole('button', { name: '检查全库系列', exact: true }).click()
    await page.evaluate(() => window.fixtureFinish())
    await series.locator('.ai-series-group').waitFor()
    assert.ok((await series.locator('.ai-series-group').innerText()).includes('第 3 话'))
    assert.ok((await series.locator('.ai-series-group').innerText()).includes('未标注'))
    assert.ok((await series.locator('.ai-series-group').innerText()).includes('コミックメガストア · 13'))
    assert.equal(await series.getByRole('button', { name: /核验/ }).count(), 0)
    for (const width of [1320, 900]) {
      await page.setViewportSize({ width, height: 900 })
      const filename = path.join(screenshotDir, `ai-series-${width}.png`)
      await page.screenshot({ path: filename, animations: 'disabled' }); screenshots.push(filename)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
    }
    await page.getByRole('tab', { name: '重复检查', exact: true }).click()
    assert.equal(await keeper.isChecked(), false)
    await page.goto(baseUrl)
    await page.getByTitle('设置', { exact: true }).click()
    const mainSettings = page.locator('.setting-dialog')
    await mainSettings.getByRole('tab', { name: '高级', exact: true }).click()
    await mainSettings.getByText('关闭时最小化到托盘', { exact: true }).scrollIntoViewIfNeeded()
    assert.equal(await mainSettings.getByText('最小化到托盘', { exact: true }).count(), 1)
    assert.equal(await mainSettings.getByText('关闭时最小化到托盘', { exact: true }).count(), 1)
    const settingScreenshot = path.join(screenshotDir, 'settings-close-main.png')
    await page.screenshot({ path: settingScreenshot, animations: 'disabled' }); screenshots.push(settingScreenshot)
    await mainSettings.getByRole('tab', { name: 'AI 辅助判断', exact: true }).click()
    await mainSettings.getByTestId('ai-key').waitFor()
    assert.equal(await page.evaluate(() => window.fixtureCalls.some(call => call.type === 'listModels')), false)
    await mainSettings.getByRole('button', { name: '获取模型', exact: true }).click()
    await mainSettings.getByText('已获取 2 个模型，选择后保存即可使用。', { exact: true }).waitFor()
    const mainPicker = mainSettings.getByTestId('ai-model')
    await mainPicker.locator('input').fill('fixture-pro')
    await page.getByRole('option', { name: 'fixture-pro', exact: true }).click()
    await mainSettings.getByRole('button', { name: '保存 AI 设置', exact: true }).click()
    await mainSettings.getByText('AI 设置已保存', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.fixtureCalls.find(call => call.type === 'saveConfig').request.config.model), 'fixture-pro')
    await mainSettings.getByTestId('ai-base-url').fill('https://API.DEEPSEEK.COM')
    await mainSettings.getByTestId('ai-response-mode').getByText('JSON 对象（json_object）', { exact: true }).waitFor()
    await mainSettings.getByRole('button', { name: '测试连接', exact: true }).click()
    await mainSettings.getByText('连接与返回格式验证成功：fixture-pro', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(call => call.type === 'test').at(-1).request.config.responseMode), 'json_object')
    assert.deepEqual(errors, [])
    return { screenshots, checks: 'ChatGPT account email/login and import dates; 5-hour/weekly remaining percentages and reset countdown, real zero versus missing usage, refresh time/error data retention/unavailable state and official usage page, actual nonstandard window labels; six reasoning levels and provider-specific persistence, model capability disabled levels without downgrading; JSON and Account authentication, provider model persistence, API draft preservation, ready-based analysis gate, desktop/narrow ChatGPT layouts, API and analysis regressions' }
  } catch (error) {
    await page.screenshot({ path: path.join(screenshotDir, 'ai-analysis-failure.png') })
    throw error
  } finally { await browser.close() }
}

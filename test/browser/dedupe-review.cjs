const assert = require('node:assert/strict')
const path = require('node:path')
const { parseBookSemantics, DEDUPE_REPORT_RULES_VERSION } = require('../../modules/audit/dedupe_title.js')

module.exports = async ({ chromium, executablePath, baseUrl, imageDataUrl, screenshotDir }) => {
  const browser = await chromium.launch({ headless: true, executablePath })
  const page = await browser.newPage({ viewport: { width: 1320, height: 860 } })
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const fixtureTitles = ['[ぐすたふ] 君は輝く月花のように (コミックメガストア Vol.13) [中国翻訳]',
    '[ぐすたふ] 君は輝く月花のように 第3話 (コミックメガストア Vol.16) [中国翻訳]', 'Dascomi Vol.35 [Chinese] [Colorized] [Decensored] [Digital]']
  const semantics = fixtureTitles.map(title => parseBookSemantics({ raw: { filepath: 'C:/fixture/' + title + '.zip' }, effective: { title, tags: { artist: ['作者と社団'] } } }))
  await page.addInitScript(({ image, semantics, titles, rulesVersion }) => {
    const sourceEvidence = { status: 'known', key: 'ehentai:123456:abcdef1234', sources: [
      { source: 'database', value: 'https://e-hentai.org/g/123456/abcdef1234/' },
      { source: 'effective', value: 'https://exhentai.org/g/123456/abcdef1234/' },
      { source: 'ehviewer', value: '.ehviewer', identity: { provider: 'ehentai', id: '123456', token: 'abcdef1234' } }
    ] }
    const groups = Array.from({ length: 33 }, (_, index) => {
      const prefixes = index === 0 ? ['a', 'b', 'c', 'd', 'e'] : index === 2 ? ['a', 'b'] : index === 3 ? Array.from({ length: 20 }, (_, i) => String.fromCharCode(97 + i)) : ['a', 'b', 'c']
      const items = prefixes.map((prefix, position) => ({ id: prefix + index,
        title: `Group ${String(index).padStart(2, '0')} ${prefix} ${titles[position % titles.length]}`, title_jpn: titles[position % titles.length],
        filepath: `\\\\fixture-nas\\Library\\非常长的目录名称\\${prefix}${index}.zip`, coverPath: image, type: 'zip', size: 1000 + position, transferBytes: 1000 + position,
         posted: position < 2 ? Date.parse('2026-10-08T12:34:56Z') / 1000 + position * 86400 : null,
         mtime: position < 2 ? new Date(Date.parse('2026-10-09T01:02:03Z') + position * 86400000).toISOString() : null,
         mtimeMs: position === 3 ? Date.parse('2026-10-12T01:02:03Z') : null,
        readCount: position, mark: position === 0, sourceEvidence, actualPageCount: 3, declaredPageCount: position === 2 ? 4 : 3,
        semantic: semantics[position % semantics.length],
        contentProof: 'verified', imageFormats: ['png'], uncoveredEntries: [] }))
      return { id: 'group-' + index, kind: 'version-review', eligible: true, actionable: true, items, evidenceRevision: 'revision-' + index,
        suggestedKeepId: 'a' + index, reasons: [{ code: 'source', memberIds: items.map(item => item.id) }],
        relations: index === 0 ? [{ leftId: 'a0', rightId: 'b0', declaredRelation: 'left_contains_right', contentRelation: 'overlap',
          category: 'coverage', verified: true, matchedPages: 2, leftPages: 3, rightPages: 3, leftUniquePages: 1, rightUniquePages: 1 }] : [],
        verification: { status: 'verified', checkedAt: '2026-10-08T10:00:00Z' }, equivalenceClasses: [{ id: 'class-' + index, memberIds: ['a' + index, 'b' + index], suggestedKeepId: 'a' + index, eligible: true, kind: 'strict-content', keepReasons: ['readable-content', 'marked'] }] }
    })
    let report = JSON.parse(sessionStorage.getItem('dedupe-report') || 'null') || { reportId: 'dedupe:browser', dedupeVersion: 2, dedupeRulesVersion: rulesVersion, schemaVersion: 4, executable: true, groups,
      coverageRelations: [{ leftId: 'collection', rightId: 'chapter', leftTitle: 'Collection Ch.1-3', rightTitle: 'Chapter Ch.2',
        relation: 'left_contains_right', verified: true, matchedPages: 2, leftPages: 3, rightPages: 2 }],
      summary: { mangaRows: 99, checkedItems: 99, eligibleDuplicateGroups: 33, coverageRelations: 1 } }
    let review = JSON.parse(sessionStorage.getItem('dedupe-review') || 'null') || { reportId: report.reportId, selections: {}, decisions: {}, quarantineRoot: 'C:/fixture/Quarantine' }
    const workspace = { activeTask: null, channels: { dedupe: { status: 'completed', latestReportId: report.reportId } }, lock: { locked: false } }
    window.fixtureCalls = []
    window.auditApi = {
      loadSetting: async () => ({ language: 'zh-CN', theme: 'dark', library: 'C:/fixture/Library' }), getLocale: async () => 'zh-CN',
      ai: {
        getState: async () => ({ status: 'idle' }), getResults: async () => [],
        onState: () => () => {},
        getConfig: async () => ({ config: { enabled: true, dedupeEnabled: true, baseUrl: 'http://fixture/v1', model: 'fixture-model' }, ready: true }),
        discoverAndQueue: async request => {
          window.fixtureCalls.push({ type: 'ai-start', request })
          const dedupeState = await window.auditApi.startDedupe({ scanMode: 'full', forceRecompute: request.force })
          return { runId: 'fixture-ai-run', pairCount: 1, aiState: { status: 'completed' }, dedupeState }
        }
      },
      getWorkspaceState: async () => workspace, getReport: async type => type === 'dedupe' ? report : null,
      getBookPreview: async bookId => bookId === 'c0' ? { posted: Date.parse('2026-10-10T12:34:56Z') / 1000, mtime: '2026-10-11T01:02:03.000Z' } : null,
      getReview: async type => {
        if (type === 'dedupe' && sessionStorage.getItem('hold-dedupe-review')) await new Promise(resolve => { window.releaseReview = resolve })
        return type === 'dedupe' ? review : { reportId: null, actionIds: [] }
      },
      getLogs: async () => [], onState: () => () => {}, onLog: () => () => {}, pageRecovery: { listLatest: async () => [] },
      saveReview: async (_type, value) => { if (window.holdNextSave) { window.holdNextSave = false; await new Promise(resolve => { window.releaseSave = resolve }) } if (window.failNextSave) { window.failNextSave = false; throw new Error('fixture save failed') } review = value; sessionStorage.setItem('dedupe-review', JSON.stringify(value)); window.fixtureCalls.push({ type: 'save', value }); return value },
      getDedupeComparison: async request => {
        window.fixtureCalls.push({ type: 'comparison', request })
        await new Promise(resolve => setTimeout(resolve, request.rightId.startsWith('c') ? 120 : 15))
        const images = ['one', 'two', 'two'].map((sha256, index) => ({ sha256, size: 100, path: `0${index + 1}.png` }))
        const inspection = { images, ancillary: [{ path: 'note.txt', size: 15, sha256: 'notes' }], ehviewer: { fields: { gid: '123456', token: 'abcdef1234', title: 'Fixture title', startPage: request.rightId.startsWith('c') ? 1 : 0 } } }
        return { groupId: request.groupId, left: inspection, right: inspection, comparison: { verified: true, matchedCount: 3, leftPageCount: 3, rightPageCount: 3, coverage: { left: 1, right: 1 }, firstDifference: null, matched: images.map((_, index) => ({ leftIndex: index, rightIndex: index })), onlyLeft: [], onlyRight: [], ordinalDifferences: [], ancillary: [{ path: 'note.txt', left: { size: 15 }, right: { size: 20 }, status: 'changed' }] } }
      },
      getDedupePreview: async request => {
        window.fixtureCalls.push({ type: 'preview', request })
        await new Promise(resolve => setTimeout(resolve, request.groupId === 'group-0' ? 90 : 10))
        if (request.textPath) return [{ key: 'left', text: 'original notes' }, { key: 'right', text: 'revised notes' }]
        return ['left', 'right'].map(side => ({ key: `${side}-${request[side + 'Index']}`, url: image, width: 240, height: 320, format: 'png', bytes: 100 }))
      },
      cleanupDedupePreview: async () => {},
      getExecutionPreview: async () => {
        const files = groups.flatMap(group => {
          const decision = review.decisions[group.id]
          if (decision?.disposition !== 'duplicate') return []
          const removed = decision.selectionMode === 'checkbox'
            ? group.items.filter(item => !decision.keepIds.includes(item.id))
            : group.items.filter(item => decision.quarantineToKeep?.[item.id])
          return removed.map(item => {
            const keepId = decision.quarantineToKeep?.[item.id] || group.equivalenceClasses.find(entry => entry.eligible && entry.memberIds.includes(item.id) && decision.keepIds.includes(entry.suggestedKeepId))?.suggestedKeepId || null
            const keep = group.items.find(book => book.id === keepId)
            return { groupId: group.id, bookId: item.id, title: item.title, source: item.filepath, target: review.quarantineRoot + '/batch/' + item.id + '.zip', keepId, keepTitle: keep?.title || null, keepPath: keep ? 'Keeper' : null, referenceTitle: keep?.title || group.items.find(book => decision.keepIds.includes(book.id))?.title, size: 1000, mode: 'move', equivalent: Boolean(keep), verified: true, matchedPages: 2, keepPages: 3, removedPages: 3, uniquePages: 1, keepUniquePages: 1, ancillaryLoss: [] }
          })
        })
        return { taskType: 'dedupe', reportId: report.reportId, quarantineFileCount: files.length, recordOnlyCount: 0, selectedGroupCount: new Set(files.map(file => file.groupId)).size, potentialBytes: files.length * 1000, manualReviewGroupCount: new Set(files.filter(file => !file.equivalent).map(file => file.groupId)).size, quarantineRoot: review.quarantineRoot, files }
      },
      selectQuarantine: async () => 'D:/chosen-quarantine', getDedupeHistory: async () => [],
      openBookDetail: async request => window.fixtureCalls.push({ type: 'detail', request }), showFile: async request => window.fixtureCalls.push({ type: 'locate', request }), openUrl: async request => window.fixtureCalls.push({ type: 'url', request }),
      startDedupe: async request => {
        window.fixtureCalls.push({ type: 'start', request })
        const groupIds = new Set(request.groupIds || [])
        report = { ...report, reportId: report.reportId + ':next', options: { scope: groupIds.size ? 'groups' : 'library' },
          executable: window.verificationChange !== 'outdated', outdatedRules: window.verificationChange === 'outdated',
          groups: report.groups.flatMap(group => {
            if (!groupIds.has(group.id)) return [group]
            if (window.verificationChange === 'remove') return []
            return [{ ...group, id: window.verificationChange === 'split' ? group.id + '-split' : group.id,
              items: window.verificationChange === 'split' ? group.items.slice(0, 2) : group.items,
              evidenceRevision: group.evidenceRevision + ':next' }]
          }) }
        review = { ...review, reportId: report.reportId }
        sessionStorage.setItem('dedupe-report', JSON.stringify(report))
        sessionStorage.setItem('dedupe-review', JSON.stringify(review))
        workspace.channels.dedupe.latestReportId = report.reportId
        return workspace
      }
    }
  }, { image: imageDataUrl, semantics, titles: fixtureTitles, rulesVersion: DEDUPE_REPORT_RULES_VERSION })
  const screenshots = []
  try {
    await page.goto(baseUrl + '/audit.html')
    await page.getByRole('tab', { name: '重复检查', exact: true }).click()
    const panel = page.locator('.dedupe-panel')
    const card = id => panel.locator('.member-card[data-book-id="' + id + '"]')
    const keep = id => card(id).getByRole('checkbox', { name: '保留这本', exact: true })
    const setKeep = async (id, checked) => {
      if (await keep(id).isChecked() !== checked) await card(id).locator('.member-selection .el-checkbox').click()
      assert.equal(await keep(id).isChecked(), checked)
    }
    const save = panel.getByRole('button', { name: '确认重复并保存', exact: true })
    const execute = panel.getByRole('button', { name: '查看隔离清单', exact: true })
    const overview = () => panel.getByRole('tab', { name: '概览', exact: true }).click()
    const selected = prefix => page.waitForFunction(prefix => document.querySelector('.queue-item.selected')?.textContent.includes(prefix), prefix)
    await card('e0').waitFor()
    await panel.getByRole('button', { name: '包含／交叠审核组 1 组' }).click()
    assert.equal(await panel.locator('.queue-item').count(), 1)
    assert.ok((await panel.locator('.relations-list').innerText()).includes('双方独有页 1 / 1'))
    await panel.locator('.relation-row').first().click()
    await page.waitForFunction(() => window.fixtureCalls.some(call => call.type === 'comparison' && call.request.leftId === 'a0' && call.request.rightId === 'b0'))
    await overview()
    await panel.locator('.filters .el-select').nth(1).click()
    await page.locator('.el-select-dropdown__item:visible').filter({ hasText: '全部关系' }).click()
    assert.equal(await panel.locator('.queue-item').count(), 30)
    await panel.locator('.scan-mode').click()
    await page.locator('.el-select-dropdown__item:visible').filter({ hasText: 'AI 全库分析并查重' }).click()
    await panel.getByRole('button', { name: '开始 AI 查重', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.fixtureCalls.find(call => call.type === 'ai-start').request), { force: false })
    await page.waitForFunction(() => document.querySelector('.dedupe-panel')?.dataset.reportId?.endsWith(':next'))
    await panel.locator('.scan-mode').click()
    await page.locator('.el-select-dropdown__item:visible').filter({ hasText: '日常检查' }).click()
    assert.equal(await panel.locator('.member-card').count(), 5)
    assert.equal(await panel.locator('.member-strip').count(), 0)
    assert.ok(await page.evaluate(() => window.fixtureCalls.filter(call => call.type === 'comparison').length) >= 1)
    assert.equal(await card('a0').locator('[data-field="work-ordinal"]').innerText(), '未标注')
    assert.ok((await card('a0').locator('[data-field="posted"]').innerText()).includes('20:34:56'))
    assert.ok((await card('a0').locator('[data-field="mtime"]').innerText()).includes('09:02:03'))
    assert.ok(await card('b0').locator('[data-field="posted"]').evaluate(node => node.classList.contains('difference')))
    await page.waitForFunction(() => document.querySelector('.member-card[data-book-id="c0"] [data-field="posted"]')?.textContent.includes('20:34:56'))
    assert.ok((await card('c0').locator('[data-field="mtime"]').innerText()).includes('09:02:03'))
    assert.equal(await card('d0').locator('[data-field="posted"]').innerText(), '未知')
    assert.ok((await card('d0').locator('[data-field="mtime"]').innerText()).includes('09:02:03'))
    assert.ok((await card('a0').locator('[data-field="publication"]').innerText()).includes('Vol.13'))
    assert.equal(await card('b0').locator('[data-field="work-ordinal"]').innerText(), '第 3 话')
    assert.ok((await card('c0').locator('[data-field="version"]').innerText()).includes('彩色版'))
    await setKeep('b0', false)
    assert.ok((await card('b0').innerText()).includes('拟隔离'))
    assert.equal(await card('b0').locator('.keep-target').count(), 0)
    assert.ok(await save.isEnabled())
    assert.ok(await page.evaluate(() => window.fixtureCalls.filter(call => call.type === 'comparison').length) >= 1)
    await panel.getByRole('button', { name: '下一组', exact: true }).click()
    await selected('Group 01')
    await panel.getByRole('button', { name: '上一组', exact: true }).click()
    await selected('Group 00')
    assert.equal(await keep('b0').isChecked(), false)
    assert.ok(await execute.isDisabled())
    await panel.getByRole('button', { name: '恢复已保存选择', exact: true }).click()
    assert.ok(await keep('b0').isChecked())
    await card('b0').getByRole('button', { name: '仅保留此副本', exact: true }).click()
    assert.equal(await keep('a0').isChecked(), false)
    assert.ok(await keep('b0').isChecked())
    assert.ok(await keep('c0').isChecked())
    assert.ok(await save.isEnabled())
    await panel.getByRole('button', { name: '恢复已保存选择', exact: true }).click()
    await card('b0').getByRole('button', { name: '设为对照基准', exact: true }).click()
    assert.ok(await keep('b0').isChecked())
    await card('c0').getByRole('button', { name: '与基准对照', exact: true }).click()
    await panel.locator('.page-card .el-image').nth(1).waitFor()
    assert.ok((await panel.locator('.page-card').nth(0).innerText()).includes('Group 00 b'))
    assert.ok((await panel.locator('.page-card').nth(1).innerText()).includes('Group 00 c'))
    await panel.locator('.member-strip .el-select').nth(1).click()
    await page.locator('.el-select-dropdown__item:visible').filter({ hasText: 'Group 00 a' }).click()
    await page.waitForFunction(() => window.fixtureCalls.filter(call => call.type === 'preview').at(-1)?.request.rightId === 'a0')
    await panel.getByRole('tab', { name: '附属文件', exact: true }).click()
    await panel.getByRole('button', { name: '查看文本', exact: true }).click()
    const textDialog = page.locator('.text-comparison-dialog')
    await textDialog.getByText('revised notes', { exact: true }).waitFor()
    await textDialog.locator('.el-dialog__headerbtn').click()
    await overview()
    assert.equal(await panel.locator('.member-card details').count(), 0)
    assert.ok(await card('a0').locator('.member-details').getByText('作者と社団', { exact: true }).isVisible())
    await card('a0').getByRole('button', { name: 'https://exhentai.org/g/123456/abcdef1234/', exact: true }).click()
    await card('a0').getByRole('button', { name: '定位文件', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.fixtureCalls.filter(call => ['url', 'locate'].includes(call.type)).map(call => call.type)), ['url', 'locate'])
    await page.evaluate(() => { window.failNextSave = true })
    await panel.getByRole('button', { name: '不是重复', exact: true }).click()
    await page.getByText('fixture save failed', { exact: true }).waitFor()
    assert.ok((await panel.locator('.queue-item.selected').innerText()).includes('Group 00'))
    await panel.getByRole('button', { name: '保留不同版本', exact: true }).click()
    await selected('Group 01')
    await panel.getByText('保存成功后下一待审组', { exact: true }).click()
    await setKeep('b1', false)
    await page.evaluate(() => { window.holdNextSave = true })
    await save.click()
    await page.waitForFunction(() => typeof window.releaseSave === 'function')
    await panel.getByRole('button', { name: '下一组', exact: true }).click()
    await selected('Group 02')
    await page.evaluate(() => { window.releaseSave() })
    await page.waitForFunction(() => window.fixtureCalls.some(call => call.type === 'save' && call.value.decisions['group-1']?.selectionMode === 'checkbox' && call.value.decisions['group-1']?.keepIds.includes('a1') && !call.value.decisions['group-1']?.keepIds.includes('b1')))
    await page.waitForFunction(() => !document.querySelector('.review-action-bar .draft-state'))
    assert.ok((await panel.locator('.queue-item.selected').innerText()).includes('Group 02'))
    await panel.getByRole('button', { name: '上一组', exact: true }).click()
    await selected('Group 01')
    const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('dedupe-review')))
    assert.ok(saved.decisions['group-1'].keepIds.includes('c1'))
    assert.equal(await panel.locator('.keep-target').count(), 0)
    await setKeep('b1', true)
    assert.ok(await execute.isDisabled())
    await panel.getByRole('button', { name: '恢复已保存选择', exact: true }).click()
    assert.equal(await keep('b1').isChecked(), false)
    await page.evaluate(() => { window.holdNextSave = true })
    await panel.getByRole('button', { name: '撤销审核选择', exact: true }).click()
    await page.waitForFunction(() => typeof window.releaseSave === 'function')
    await panel.getByRole('button', { name: '下一组', exact: true }).click()
    await selected('Group 02')
    await page.evaluate(() => { window.releaseSave() })
    await page.waitForFunction(() => !JSON.parse(sessionStorage.getItem('dedupe-review')).decisions['group-1'])
    await panel.getByRole('button', { name: '上一组', exact: true }).click()
    await selected('Group 01')
    assert.ok(await keep('b1').isChecked())
    await setKeep('b1', false)
    await setKeep('c1', false)
    assert.ok(await save.isEnabled())
    await panel.getByText('保存成功后下一待审组', { exact: true }).click()
    await save.click()
    await page.waitForFunction(() => JSON.stringify(JSON.parse(sessionStorage.getItem('dedupe-review')).decisions['group-1']?.keepIds) === '["a1"]')
    await selected('Group 02')
    await execute.click()
    const executionDialog = page.locator('.el-dialog:visible').filter({ hasText: '同盘隔离不会释放磁盘空间' })
    await executionDialog.waitFor()
    assert.equal(await executionDialog.locator('.execution-files .el-table__row').count(), 2)
    await executionDialog.getByText('不自动归并', { exact: true }).waitFor()
    await executionDialog.getByRole('button', { name: '选择目录', exact: true }).click()
    await executionDialog.getByText('D:/chosen-quarantine', { exact: true }).waitFor()
    await executionDialog.locator('.el-dialog__headerbtn').click()
    await panel.locator('.queue-item').nth(2).click()
    await selected('Group 02')
    assert.equal(await panel.locator('.member-card').count(), 2)
    const pairLayout = await panel.locator('.member-grid').evaluate(grid => {
      const rect = grid.getBoundingClientRect(), cards = [...grid.querySelectorAll('.member-card')].map(node => node.getBoundingClientRect())
      return { columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length, width: rect.width, cardWidth: cards[0].width, gapRight: rect.right - cards[1].right }
    })
    assert.equal(pairLayout.columns, 2)
    assert.ok(pairLayout.cardWidth >= pairLayout.width * .48 && Math.abs(pairLayout.gapRight) < 1, 'Pair leaves an empty column: ' + JSON.stringify(pairLayout))
    await setKeep('b2', false)
    assert.ok(await keep('a2').isDisabled())
    assert.ok(await keep('a2').isChecked())
    await panel.getByRole('button', { name: '恢复已保存选择', exact: true }).click()
    await panel.locator('.queue-item').nth(3).click()
    await selected('Group 03')
    assert.equal(await panel.locator('.member-card').count(), 20)
    const previousComparisons = await page.evaluate(() => window.fixtureCalls.filter(call => call.type === 'comparison').length)
    await card('t3').scrollIntoViewIfNeeded()
    assert.ok(await keep('t3').isChecked())
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(call => call.type === 'comparison').length), previousComparisons)
    await panel.locator('.queue-item').first().click()
    await selected('Group 00')
    await panel.getByRole('button', { name: '使用建议保留项', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.el-message').length === 0)
    const viewports = [{ width: 1920, height: 1080 }, { width: 1320, height: 860 }, { width: 1024, height: 768 }, { width: 760, height: 600 }]
    for (const viewport of viewports) {
      await page.setViewportSize(viewport)
      await page.waitForTimeout(100)
      const dimensions = await panel.evaluate(node => ({
        width: node.clientWidth, scroll: node.scrollWidth,
        footerBottom: node.querySelector('.review-action-bar').getBoundingClientRect().bottom,
        decisionBottom: node.querySelector('.decision-editor').getBoundingClientRect().bottom,
        areaBottom: node.querySelector('.comparison-area').getBoundingClientRect().bottom,
        columns: getComputedStyle(node.querySelector('.member-grid')).gridTemplateColumns.split(' ').length,
        scrollHeight: node.querySelector('.comparison-scroll').clientHeight
      }))
      assert.ok(dimensions.scroll <= dimensions.width + 1, 'Horizontal overflow: ' + JSON.stringify({ viewport, dimensions }))
      assert.ok(dimensions.footerBottom <= viewport.height, 'Footer outside window: ' + JSON.stringify({ viewport, dimensions }))
      assert.ok(dimensions.decisionBottom <= dimensions.areaBottom + 1, 'Review controls outside workspace: ' + JSON.stringify({ viewport, dimensions }))
      assert.ok(dimensions.scrollHeight > 120, 'No usable overview scroll area: ' + JSON.stringify({ viewport, dimensions }))
      assert.equal(dimensions.columns, viewport.width >= 1320 ? 3 : viewport.width >= 1024 ? 2 : 1)
      await card('a0').locator('.cover-button').scrollIntoViewIfNeeded()
      const coverLayout = await card('a0').evaluate(node => {
        const cover = node.querySelector('.cover-button').getBoundingClientRect()
        const facts = node.querySelector('.member-facts').getBoundingClientRect()
        const title = node.querySelector('.member-title').getBoundingClientRect()
        const image = node.querySelector('.el-image__inner')
        return { width: cover.width, height: cover.height, coverRight: cover.right, factsLeft: facts.left,
          factsTop: facts.top, titleTop: title.top, imageFit: image ? getComputedStyle(image).objectFit : null }
      })
      assert.ok(coverLayout.width >= 100 && coverLayout.height >= 140,
        'Overview cover stayed thumbnail-sized: ' + JSON.stringify({ viewport, coverLayout }))
      assert.ok(Math.abs(coverLayout.height / coverLayout.width - 707 / 500) < .02,
        'Overview cover lost its portrait ratio: ' + JSON.stringify({ viewport, coverLayout }))
      assert.ok(coverLayout.factsLeft >= coverLayout.coverRight + 8 && coverLayout.factsTop >= coverLayout.titleTop,
        'Book facts no longer share the cover row: ' + JSON.stringify({ viewport, coverLayout }))
      if (coverLayout.imageFit) assert.equal(coverLayout.imageFit, 'contain')
      const scroll = panel.locator('.comparison-scroll')
      await scroll.evaluate(node => { node.scrollTop = 0 })
      if (viewport.width === 760) {
        await scroll.evaluate(node => { node.scrollTop += node.querySelector('.member-card').getBoundingClientRect().top - node.getBoundingClientRect().top })
        const more = panel.getByRole('button', { name: '其他审核操作 ▾', exact: true })
        await more.click()
        await page.locator('.el-dropdown-menu:visible').getByRole('menuitem', { name: '不是重复', exact: true }).waitFor()
        await panel.locator('.queue-heading').click()
        await page.locator('.el-dropdown-menu:visible').waitFor({ state: 'hidden' })
      }
      const screenshot = path.join(screenshotDir, 'dedupe-keep-' + viewport.width + '.png')
      await page.screenshot({ path: screenshot }); screenshots.push(screenshot)
      await card('e0').scrollIntoViewIfNeeded()
      assert.ok(await card('e0').locator('.member-selection').isVisible())
      await panel.locator('.queue-item').nth(2).click()
      await selected('Group 02')
      const pairColumns = await panel.locator('.member-grid').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length)
      assert.equal(pairColumns, Math.min(2, dimensions.columns))
      assert.equal(await panel.locator('.member-card details').count(), 0)
      const pairScreenshot = path.join(screenshotDir, 'dedupe-pair-' + viewport.width + '.png')
      await page.screenshot({ path: pairScreenshot }); screenshots.push(pairScreenshot)
      await panel.locator('.queue-item').first().click()
      await selected('Group 00')
    }
    // A checkbox choice remains saveable even in the narrow overview.
    await setKeep('c0', false)
    assert.ok(await save.isEnabled())
    assert.ok(await panel.locator('.comparison-scroll').evaluate(node => node.clientHeight > 120))
    await panel.getByRole('button', { name: '恢复已保存选择', exact: true }).click()
    await page.setViewportSize({ width: 1320, height: 860 })
    await panel.locator('.queue .btn-next').click()
    await panel.locator('.queue-item').nth(1).click()
    await selected('Group 31')
    await setKeep('b31', false)
    const verifyGroup = panel.getByRole('button', { name: '深入验证本组', exact: true })
    const verify = async () => {
      const oldReport = await panel.getAttribute('data-report-id')
      await verifyGroup.click()
      await page.waitForFunction(old => document.querySelector('.dedupe-panel')?.dataset.reportId !== old, oldReport)
    }
    await verify()
    assert.ok((await panel.locator('.queue-item.selected').innerText()).includes('Group 31'))
    assert.ok(await keep('b31').isChecked())
    assert.equal(await panel.locator('.queue .el-pager .is-active').innerText(), '2')
    await page.evaluate(() => { window.verificationChange = 'split' })
    await verify()
    assert.equal(await panel.locator('.member-card').count(), 2)
    assert.equal(await panel.locator('.queue .el-pager .is-active').innerText(), '2')
    await card('b31').getByRole('button', { name: '与基准对照', exact: true }).click()
    await panel.locator('.page-card .el-image').nth(1).waitFor()
    assert.ok((await panel.locator('.page-card').nth(0).innerText()).includes('Group 31'))
    await overview()
    await card('a31').locator('.cover-button').click()
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(call => call.type === 'detail').at(-1).request.navigationIds.length), 2)
    await page.evaluate(() => { window.verificationChange = 'remove' })
    await verify()
    await selected('Group 32')
    assert.equal(await panel.locator('.queue .el-pager .is-active').innerText(), '2')
    await panel.getByRole('button', { name: '开始重复检查', exact: true }).click()
    await selected('Group 00')
    assert.equal(await panel.locator('.queue .el-pager .is-active').innerText(), '1')
    await page.evaluate(() => { window.verificationChange = 'outdated' })
    await panel.getByRole('button', { name: '开始重复检查', exact: true }).click()
    await panel.getByText(/此报告使用旧分组规则/).waitFor()
    assert.ok(await verifyGroup.isDisabled())
    assert.ok(await save.isDisabled())
    assert.ok(await keep('a0').isDisabled())
    await page.evaluate(() => { window.verificationChange = 'current' })
    await panel.getByRole('button', { name: '开始重复检查', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.dedupe-panel').textContent.includes('此报告使用旧分组规则'))
    await page.reload()
    await page.getByRole('tab', { name: '重复检查', exact: true }).click()
    await panel.locator('.queue-item').nth(1).click()
    await selected('Group 01')
    assert.equal(await keep('b1').isChecked(), false)
    assert.equal(await keep('c1').isChecked(), false)
    assert.ok((await panel.locator('.review-action-bar').innerText()).includes('2 本'))

    // Entering the tab focuses the earliest pending group after the matching review has loaded.
    await page.evaluate(() => {
      sessionStorage.removeItem('dedupe-report')
      const decisions = Object.fromEntries(Array.from({ length: 31 }, (_, index) => [
        'group-' + index, { disposition: 'not-duplicate', evidenceRevision: 'revision-' + index }
      ]))
      sessionStorage.setItem('dedupe-review', JSON.stringify({ reportId: 'dedupe:browser', selections: {}, decisions, quarantineRoot: 'C:/fixture/Quarantine' }))
      sessionStorage.setItem('hold-dedupe-review', '1')
    })
    await page.reload()
    await page.waitForFunction(() => typeof window.releaseReview === 'function')
    await page.getByRole('tab', { name: '重复检查', exact: true }).click()
    assert.equal(await panel.locator('.queue-item').count(), 0)
    await page.evaluate(() => { sessionStorage.removeItem('hold-dedupe-review'); window.releaseReview() })
    await selected('Group 31')
    assert.equal(await panel.locator('.queue .el-pager .is-active').innerText(), '2')
    await panel.locator('.queue-item').nth(2).click()
    await selected('Group 32')
    const reportBeforeVerify = await panel.getAttribute('data-report-id')
    await panel.getByRole('button', { name: '深入验证本组', exact: true }).click()
    await page.waitForFunction(previous => document.querySelector('.dedupe-panel')?.dataset.reportId !== previous, reportBeforeVerify)
    await selected('Group 32')
    await page.getByRole('tab', { name: '异常检查', exact: true }).click()
    await page.getByRole('tab', { name: '重复检查', exact: true }).click()
    await selected('Group 31')
    await panel.getByRole('button', { name: '不是重复', exact: true }).click()
    await selected('Group 32')
    await panel.getByRole('button', { name: '不是重复', exact: true }).click()
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('dedupe-review')).decisions['group-32']?.disposition === 'not-duplicate')
    await page.getByRole('tab', { name: '异常检查', exact: true }).click()
    await page.getByRole('tab', { name: '重复检查', exact: true }).click()
    await selected('Group 32')
    assert.deepEqual(errors, [])
    return { screenshots, errors, savedDecisions: Object.keys(saved.decisions), viewports: viewports.map(item => item.width), testedMembers: [2, 3, 5, 20] }
  } catch (error) {
    await page.screenshot({ path: path.join(screenshotDir, 'dedupe-keep-failure.png') })
    throw error
  } finally { await browser.close() }
}

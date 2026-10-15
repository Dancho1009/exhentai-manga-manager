const assert = require('node:assert/strict')
const path = require('node:path')
const { parseBookSemantics, DEDUPE_RULES_VERSION } = require('../../modules/audit/dedupe_title.js')

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
        readCount: position, mark: position === 0, sourceEvidence, actualPageCount: 3, declaredPageCount: position === 2 ? 4 : 3,
        semantic: semantics[position % semantics.length],
        contentProof: 'verified', imageFormats: ['png'], uncoveredEntries: [] }))
      return { id: 'group-' + index, kind: 'version-review', eligible: true, actionable: true, items, evidenceRevision: 'revision-' + index,
        suggestedKeepId: 'a' + index, reasons: [{ code: 'source', memberIds: items.map(item => item.id) }],
        verification: { status: 'verified', checkedAt: '2026-10-08T10:00:00Z' }, equivalenceClasses: [{ id: 'class-' + index, memberIds: ['a' + index, 'b' + index], suggestedKeepId: 'a' + index, eligible: true, kind: 'strict-content', keepReasons: ['readable-content', 'marked'] }] }
    })
    let report = JSON.parse(sessionStorage.getItem('dedupe-report') || 'null') || { reportId: 'dedupe:browser', dedupeVersion: 2, dedupeRulesVersion: rulesVersion, schemaVersion: 4, executable: true, groups, summary: { mangaRows: 99, checkedItems: 99, eligibleDuplicateGroups: 33 } }
    let review = JSON.parse(sessionStorage.getItem('dedupe-review') || 'null') || { reportId: report.reportId, selections: {}, decisions: {}, quarantineRoot: 'C:/fixture/Quarantine' }
    const workspace = { activeTask: null, channels: { dedupe: { status: 'completed', latestReportId: report.reportId } }, lock: { locked: false } }
    window.fixtureCalls = []
    window.auditApi = {
      loadSetting: async () => ({ language: 'zh-CN', theme: 'dark', library: 'C:/fixture/Library' }), getLocale: async () => 'zh-CN',
      getWorkspaceState: async () => workspace, getReport: async type => type === 'dedupe' ? report : null,
      getReview: async type => type === 'dedupe' ? review : { reportId: null, actionIds: [] },
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
        const files = groups.flatMap(group => group.items.filter(item => review.decisions[group.id]?.quarantineToKeep?.[item.id]).map(item => ({ title: item.title, source: item.filepath, target: review.quarantineRoot + '/batch/' + item.id + '.zip', keepTitle: group.items.find(book => book.id === review.decisions[group.id].quarantineToKeep[item.id]).title, keepPath: 'Keeper', size: 1000, ancillaryLoss: [] })))
        return { taskType: 'dedupe', reportId: report.reportId, quarantineFileCount: files.length, selectedGroupCount: files.length, potentialBytes: files.length * 1000, manualReviewGroupCount: 0, quarantineRoot: review.quarantineRoot, files }
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
  }, { image: imageDataUrl, semantics, titles: fixtureTitles, rulesVersion: DEDUPE_RULES_VERSION })
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
    assert.equal(await panel.locator('.member-card').count(), 5)
    assert.equal(await panel.locator('.member-strip').count(), 0)
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(call => call.type === 'comparison').length), 0)
    assert.equal(await card('a0').locator('[data-field="work-ordinal"]').innerText(), '未标注')
    assert.ok((await card('a0').locator('[data-field="publication"]').innerText()).includes('Vol.13'))
    assert.equal(await card('b0').locator('[data-field="work-ordinal"]').innerText(), '第 3 话')
    assert.ok((await card('c0').locator('[data-field="version"]').innerText()).includes('彩色版'))
    await setKeep('b0', false)
    assert.ok((await card('b0').innerText()).includes('拟隔离'))
    assert.ok((await card('b0').locator('.keep-target .el-select').innerText()).includes('副本 1'))
    assert.ok(await save.isEnabled())
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(call => call.type === 'comparison').length), 0)
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
    assert.ok((await card('a0').locator('.keep-target').innerText()).includes('副本 2'))
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
    await page.waitForFunction(() => window.fixtureCalls.some(call => call.type === 'save' && call.value.decisions['group-1']?.quarantineToKeep.b1 === 'a1'))
    await page.waitForFunction(() => !document.querySelector('.review-action-bar .draft-state'))
    assert.ok((await panel.locator('.queue-item.selected').innerText()).includes('Group 02'))
    await panel.getByRole('button', { name: '上一组', exact: true }).click()
    await selected('Group 01')
    const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('dedupe-review')))
    assert.ok(saved.decisions['group-1'].keepIds.includes('c1'))
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
    await save.click()
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('dedupe-review')).decisions['group-1']?.quarantineToKeep.b1 === 'a1')
    await execute.click()
    const executionDialog = page.locator('.el-dialog:visible').filter({ hasText: '同盘隔离不会释放磁盘空间' })
    await executionDialog.waitFor()
    assert.equal(await executionDialog.locator('.execution-files .el-table__row').count(), 1)
    await executionDialog.getByRole('button', { name: '选择目录', exact: true }).click()
    await executionDialog.getByText('D:/chosen-quarantine', { exact: true }).waitFor()
    await executionDialog.locator('.el-dialog__headerbtn').click()
    // An independent version never receives an inferred cross-version mapping.
    await setKeep('c1', false)
    assert.ok(await save.isDisabled())
    await card('c1').locator('.keep-target .el-select').click()
    await page.locator('.el-select-dropdown__item:visible').filter({ hasText: '副本 1' }).click()
    assert.ok(await save.isDisabled())
    await panel.locator('.decision-editor .el-input input').fill('已核对不同版本')
    await panel.getByText('已查看页面、来源、附属文件和未检查范围，并确认这次人工隔离选择', { exact: true }).click()
    assert.ok(await save.isEnabled())
    await panel.getByRole('button', { name: '恢复已保存选择', exact: true }).click()
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
    // Manual decisions remain reachable without squeezing out the narrow overview.
    await setKeep('c0', false)
    await card('c0').locator('.keep-target .el-select').click()
    await page.locator('.el-select-dropdown__item:visible').filter({ hasText: '副本 1' }).click()
    await panel.locator('.decision-editor .el-input input').fill('已核对不同版本')
    await panel.getByText('已查看页面、来源、附属文件和未检查范围，并确认这次人工隔离选择', { exact: true }).click()
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
    await panel.getByText('此报告使用旧候选规则。请重新运行日常或完整检查以移除纯系列关联；可继续复用内容缓存。', { exact: true }).waitFor()
    assert.ok(await verifyGroup.isDisabled())
    assert.ok(await save.isDisabled())
    assert.ok(await keep('a0').isDisabled())
    await page.evaluate(() => { window.verificationChange = 'current' })
    await panel.getByRole('button', { name: '开始重复检查', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.dedupe-panel').textContent.includes('此报告使用旧候选规则'))
    await page.reload()
    await page.getByRole('tab', { name: '重复检查', exact: true }).click()
    await panel.locator('.queue-item').nth(1).click()
    await selected('Group 01')
    assert.equal(await keep('b1').isChecked(), false)
    assert.ok(await keep('c1').isChecked())
    assert.ok((await panel.locator('.review-action-bar').innerText()).includes('1 个文件'))
    assert.deepEqual(errors, [])
    return { screenshots, errors, savedDecisions: Object.keys(saved.decisions), viewports: viewports.map(item => item.width), testedMembers: [2, 3, 5, 20] }
  } catch (error) {
    await page.screenshot({ path: path.join(screenshotDir, 'dedupe-keep-failure.png') })
    throw error
  } finally { await browser.close() }
}

const assert = require('node:assert/strict')
const path = require('node:path')

module.exports = async ({ chromium, channel, executablePath, baseUrl, imageDataUrl, screenshotDir }) => {
  const browser = await chromium.launch({ headless: true, channel, executablePath })
  const context = await browser.newContext({ viewport: { width: 1320, height: 860 } })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(({ image }) => {
    const cacheKey = 'page-recovery-offset-browser-fixture'
    const sourceUrl = 'https://exhentai.org/g/1234567/abcdef1234/'
    const report = {
      reportId: 'offset-browser-report', executable: true, stale: false,
      summary: { libraryItems: 2, databaseRecords: 2, anomalyBooks: 2, batchSafeAnomalies: 0, manualReviewAnomalies: 0, reportOnlyAnomalies: 2 },
      anomalies: ['one', 'two'].map((id, index) => ({
        id: `gap-${id}`, bookId: `book-${id}`, filepath: `C:/fixture/${id}.cbz`,
        type: 'archive-image-sequence-gap', severity: 'high', reason: `Local missing page ${index ? 5 : 19}`,
        recommendedAction: 'review', actionPolicy: 'report-only',
        evidence: { currentUrl: sourceUrl, pageCount: 21, imageSequence: { gaps: [{ first: 1, last: 22, missingNumbers: [index ? 5 : 19] }] } }
      }))
    }
    let cached = JSON.parse(localStorage.getItem(cacheKey) || 'null')
    window.fixtureCalls = []
    window.auditApi = {
      loadSetting: async () => ({ language: 'zh-CN', theme: 'dark', library: 'C:/fixture/Library' }),
      getLocale: async () => 'zh-CN',
      getWorkspaceState: async () => ({ activeTask: null, channels: { anomaly: { status: 'completed', latestReportId: report.reportId } }, lock: { locked: false } }),
      getReport: async type => type === 'anomaly' ? report : null,
      getReview: async () => ({ reportId: report.reportId, actionIds: [], manualActions: {}, selections: {} }),
      getLogs: async () => [], onState: () => () => {}, onLog: () => () => {},
      getBookPreview: async id => ({ id, title: `Offset fixture ${id}`, searchTitle: 'Fixture', type: 'zip', coverPath: image, url: sourceUrl, filecount: 22 }),
      pageRecovery: {
        listLatest: async () => cached ? [{ ...cached, candidateCount: cached.candidates.length, candidatePages: cached.candidates.map(item => item.pageNumber) }] : [],
        getLatest: async ({ anomalyId }) => cached?.anomalyId === anomalyId ? JSON.parse(JSON.stringify(cached)) : null,
        fetch: async request => {
          window.fixtureCalls.push({ type: 'fetch', request })
          const offset = Number(request.sourceOffset || 0)
          const localPage = request.pageNumbers[0]
          const sourcePage = localPage + offset
          if (sourcePage > 100) throw new Error(`Error invoking remote method 'audit:page-recovery-fetch': Error: PAGE_RECOVERY_SOURCE_PAGE_UNAVAILABLE:${localPage}:${sourcePage}`)
          cached = {
            recoveryId: `fixture-${offset}`, reportId: report.reportId, anomalyId: request.anomalyId, sourceOffset: offset,
            source: { type: 'ehentai', url: sourceUrl }, local: { pageCount: 21 }, online: { pageCount: 22 + offset, localPageCount: 22, sourceOffset: offset },
            status: 'awaiting-confirmation', writeBackSupported: true, batchWriteBackSupported: true,
            availablePages: [localPage], selectedPages: [localPage], leadingPages: [], trailingPages: [],
            candidates: [{ id: `fixture:${localPage}`, pageNumber: localPage, sourcePageNumber: sourcePage, targetPath: `page-${String(localPage).padStart(4, '0')}.png`, status: 'downloaded', previewDataUrl: image,
              localContext: { previous: { pageNumber: localPage - 1, path: 'previous.png', status: 'available', previewDataUrl: image }, next: { pageNumber: localPage + 1, path: 'next.png', status: 'available', previewDataUrl: image } } }]
          }
          localStorage.setItem(cacheKey, JSON.stringify(cached))
          return JSON.parse(JSON.stringify(cached))
        },
        apply: async request => {
          window.fixtureCalls.push({ type: 'apply', request })
          return { session: { ...cached, status: 'completed' }, resolved: false }
        },
        applyBatch: async request => {
          window.fixtureCalls.push({ type: 'apply-batch', request })
          return { results: [{ anomalyId: 'gap-one', status: 'completed', recoveryId: cached.recoveryId }], completedCount: 1, appliedCount: 1 }
        }
      }
    }
  }, { image: imageDataUrl })

  const offsetInput = page.locator('#page-recovery-offset')
  const fetchButton = page.getByRole('button', { name: '获取选中页', exact: true })
  const applyButton = page.locator('.page-recovery-actions button').first()
  const candidateCheckbox = page.locator('.page-recovery-candidate-select input')
  const candidateLabel = page.locator('.page-recovery-candidate-select')
  const setOffset = async value => {
    await offsetInput.fill(String(value))
    await offsetInput.press('Tab')
  }
  const openFirst = async () => {
    await page.locator('.el-table__body-wrapper .el-table__row').first().click()
    await offsetInput.waitFor({ state: 'visible' })
  }
  try {
    await page.goto(`${baseUrl}/audit.html`)
    await openFirst()
    assert.equal(await offsetInput.inputValue(), '0')
    await setOffset(2)
    await page.locator('.page-recovery-offset-mapping').filter({ hasText: '来源第 21 页' }).waitFor()
    await fetchButton.click()
    await page.locator('.page-recovery-candidate-select').waitFor()
    assert.match(await page.locator('.page-recovery-context.is-target').innerText(), /本地第 19 页 · 来源第 21 页[\s\S]*page-0019.png/)
    assert.equal((await page.evaluate(() => window.fixtureCalls[0].request)).sourceOffset, 2)
    await candidateLabel.click()
    assert.equal(await applyButton.isEnabled(), true)

    await setOffset(-2)
    assert.equal(await applyButton.isDisabled(), true)
    assert.equal(await candidateCheckbox.isDisabled(), true)
    assert.equal(await candidateCheckbox.isChecked(), false)
    assert.match(await page.locator('.page-recovery-candidates .el-alert').first().innerText(), /来源或偏移已改变/)
    await fetchButton.click()
    await page.locator('.page-recovery-context.is-target').filter({ hasText: '来源第 17 页' }).waitFor()
    await page.locator('.el-drawer:visible .el-drawer__close-btn').click()
    await page.locator('.el-drawer:visible').waitFor({ state: 'hidden' })
    await openFirst()
    assert.equal(await offsetInput.inputValue(), '-2')
    assert.match(await page.locator('.page-recovery-context.is-target').innerText(), /来源第 17 页/)

    await page.getByRole('button', { name: '下一条', exact: true }).click()
    await page.locator('.anomaly-navigation-count').filter({ hasText: '第 2 / 2 条' }).waitFor()
    assert.equal(await offsetInput.inputValue(), '0')
    assert.equal(await page.locator('.page-recovery-candidates').count(), 0)
    await page.getByRole('button', { name: '上一条', exact: true }).click()
    await page.locator('.page-recovery-context.is-target').waitFor()
    assert.equal(await offsetInput.inputValue(), '-2')

    await page.reload()
    await openFirst()
    await page.locator('.page-recovery-context.is-target').waitFor()
    assert.equal(await offsetInput.inputValue(), '-2')
    assert.equal(await page.locator('.page-recovery-context-image').evaluateAll(images => images.every(image => { const img = image.querySelector('img'); return img?.complete && img.naturalWidth > 0 })), true)

    const screenshots = []
    for (const viewport of [{ width: 1320, height: 860 }, { width: 760, height: 960 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      await offsetInput.scrollIntoViewIfNeeded()
      const rectangles = await page.locator('.page-recovery-offset').evaluate(element => {
        const parent = element.getBoundingClientRect()
        return { parent: { left: parent.left, right: parent.right }, children: [...element.children].map(child => { const rect = child.getBoundingClientRect(); return { left: rect.left, right: rect.right } }) }
      })
      assert.equal(rectangles.children.every(rect => rect.left >= rectangles.parent.left - 1 && rect.right <= rectangles.parent.right + 1), true, JSON.stringify({ viewport, rectangles }))
      if (viewport.width <= 900) {
        const headingsOverlap = await page.locator('.page-recovery-comparison-heading').evaluate(element => {
          const title = element.querySelector('strong').getBoundingClientRect()
          const description = element.querySelector('span').getBoundingClientRect()
          return title.bottom > description.top + 1
        })
        assert.equal(headingsOverlap, false)
      }
      const filename = path.join(screenshotDir, `offset-${viewport.width}.png`)
      await page.screenshot({ path: filename })
      screenshots.push(filename)
    }
    await page.setViewportSize({ width: 1320, height: 860 })
    await candidateLabel.click()
    await applyButton.click()
    await page.locator('.el-message-box').getByRole('button', { name: '确定', exact: true }).click()
    await page.waitForFunction(() => window.fixtureCalls.some(item => item.type === 'apply'))
    const apply = await page.evaluate(() => window.fixtureCalls.find(item => item.type === 'apply'))
    assert.deepEqual(apply.request.candidateIds, ['fixture:19'])
    assert.equal(apply.request.confirmPageMapping, true)

    await page.locator('.el-drawer:visible .el-drawer__close-btn').click()
    await page.locator('.el-drawer:visible').waitFor({ state: 'hidden' })
    await page.locator('.el-table__body-wrapper .el-table__row .el-checkbox').first().click()
    const fetchCount = await page.evaluate(() => window.fixtureCalls.filter(item => item.type === 'fetch').length)
    await page.getByRole('button', { name: /批量获取缺漏页/ }).click()
    await page.getByRole('button', { name: /批量写回待确认页.*1 本/ }).waitFor()
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(item => item.type === 'fetch').length), fetchCount)
    await page.getByRole('button', { name: /批量写回待确认页.*1 本/ }).click()
    await page.locator('.el-message-box').getByRole('button', { name: '批量写回', exact: true }).click()
    await page.waitForFunction(() => window.fixtureCalls.some(item => item.type === 'apply-batch'))
    assert.deepEqual(await page.evaluate(() => window.fixtureCalls.find(item => item.type === 'apply-batch').request.anomalyIds), ['gap-one'])

    for (const source of [{ type: 'nhentai', url: 'https://nhentai.net/g/615436/', galleryId: '615436' }, { type: 'jmcomic', url: 'https://18comic.vip/album/567890/', galleryId: '567890' }]) {
      await page.evaluate(source => {
        const key = 'page-recovery-offset-browser-fixture'
        const cached = JSON.parse(localStorage.getItem(key))
        cached.source = source
        cached.sourceOffset = 2
        cached.online.pageCount = 24
        cached.online.sourceOffset = 2
        cached.candidates[0].sourcePageNumber = 21
        localStorage.setItem(key, JSON.stringify(cached))
      }, source)
      await page.reload()
      await openFirst()
      await page.locator('.page-recovery-context.is-target').filter({ hasText: '来源第 21 页' }).waitFor()
      assert.equal(await offsetInput.inputValue(), '2')
      assert.match(await page.locator('.page-recovery-nhentai-source').filter({ hasText: source.url }).innerText(), /页数: 24/)
      await candidateLabel.click()
      assert.equal(await applyButton.isEnabled(), true)
    }
    await setOffset(1000)
    await fetchButton.click()
    await page.locator('.el-message--error').filter({ hasText: '本地第 19 页对应的来源第 1019 页不存在' }).waitFor()
    assert.equal(await applyButton.isDisabled(), true)
    assert.deepEqual(errors, [])
    return { screenshots, errors, result: 'offset controls, selection invalidation, local targets, cache restoration, navigation and responsive layout passed' }
  } finally {
    await browser.close()
  }
}

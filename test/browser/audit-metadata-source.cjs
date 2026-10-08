const assert = require('node:assert/strict')
const path = require('node:path')

module.exports = async ({ chromium, executablePath, baseUrl, imageDataUrl, screenshotDir }) => {
  const browser = await chromium.launch({ headless: true, executablePath })
  const page = await browser.newPage({ viewport: { width: 1320, height: 860 } })
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(({ image }) => {
    const nhUrl = 'https://nhentai.net/g/599555/'
    const ehUrl = 'https://exhentai.org/g/3981890/533feb3a94/'
    const availability = { sites: { ehentai: { status: 'available' }, exhentai: { status: 'available' } } }
    const report = {
      reportId: 'metadata-source-report', executable: true, stale: false,
      summary: { libraryItems: 3, mangaRows: 3, anomalyBooks: 3, manualReviewAnomalies: 3 },
      anomalies: [
        { id: 'nh-incomplete', bookId: 'nh-book', filepath: 'C:/fixture/nh.zip', type: 'metadata-incomplete', severity: 'low', reason: 'NH metadata fields missing', actionPolicy: 'manual', evidence: { currentUrl: nhUrl } },
        { id: 'legacy-conflict', bookId: 'legacy-book', filepath: 'C:/fixture/legacy.zip', type: 'ehviewer-url-conflict-online', severity: 'critical', reason: 'Legacy source conflict', actionPolicy: 'manual', evidence: { currentUrl: nhUrl, currentAvailability: availability, ehviewer: { gid: '3981890', token: '533feb3a94' }, ehviewerAvailability: availability }, action: { type: 'repair-url', repairKind: 'identity-replacement', currentUrl: nhUrl, newUrl: ehUrl } },
        { id: 'unsupported', bookId: 'other-book', filepath: 'C:/fixture/other.zip', type: 'metadata-incomplete', severity: 'low', reason: 'Other metadata fields missing', actionPolicy: 'report-only', evidence: { currentUrl: 'https://example.com/book/1' } }
      ]
    }
    let review = { reportId: report.reportId, actionIds: [], manualActions: {}, selections: {} }
    window.fixtureCalls = []
    window.auditApi = {
      loadSetting: async () => ({ language: 'zh-CN', theme: 'dark', library: 'C:/fixture/Library' }),
      getLocale: async () => 'zh-CN',
      getWorkspaceState: async () => ({ activeTask: null, channels: { anomaly: { status: 'completed', latestReportId: report.reportId } }, lock: { locked: false } }),
      getReport: async type => type === 'anomaly' ? report : null,
      getReview: async () => review,
      getLogs: async () => [], onState: () => () => {}, onLog: () => () => {},
      getBookPreview: async id => ({ id, title: 'Metadata source fixture', coverPath: image, url: id === 'other-book' ? 'https://example.com/book/1' : nhUrl, filecount: 59 }),
      pageRecovery: { listLatest: async () => [], getLatest: async () => null },
      buildManualSourceAction: async request => {
        window.fixtureCalls.push({ type: 'build', request })
        const item = report.anomalies.find(value => value.id === request.anomalyId)
        return { type: 'repair-url', repairKind: 'manual-source-selection', source: request.source, anomalyId: item.id, bookId: item.bookId, filepath: item.filepath,
          expectedSize: 123, expectedMtimeMs: 456, currentUrl: item.evidence.currentUrl, newUrl: request.source === 'current' ? nhUrl : ehUrl }
      },
      saveReview: async (taskType, value) => { review = value; window.fixtureCalls.push({ type: 'save', taskType, review: value }); return value }
    }
  }, { image: imageDataUrl })
  const screenshots = []
  try {
    await page.goto(`${baseUrl}/audit.html`)
    const rows = page.locator('.el-table__body-wrapper .el-table__row')
    await rows.nth(0).click()
    const drawer = page.locator('.el-drawer:visible')
    const currentRadio = drawer.getByRole('radio', { name: /使用当前 URL 来源.*nHentai/ })
    assert.equal(await currentRadio.isDisabled(), false)
    assert.equal(await drawer.locator('.metadata-source-tag').innerText(), 'nHentai')
    assert.equal(await drawer.getByText('非 EH/EX 来源', { exact: true }).count(), 1)
    if (await drawer.locator('.auto-next-selection input').isChecked()) await drawer.locator('.auto-next-selection').click()
    await currentRadio.locator('..').click()
    await drawer.locator('.manual-source-alert').waitFor()
    await page.waitForFunction(() => window.fixtureCalls.some(call => call.type === 'save' && call.review.manualActions['nh-incomplete']?.newUrl === 'https://nhentai.net/g/599555/'))
    for (const viewport of [{ width: 1320, height: 860 }, { width: 820, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      await drawer.locator('.manual-source-selection').scrollIntoViewIfNeeded()
      const bounds = await drawer.locator('.manual-source-selection').evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth }))
      assert.ok(bounds.scroll <= bounds.width + 1, `Source controls overflow at ${viewport.width}: ${JSON.stringify(bounds)}`)
      const screenshot = path.join(screenshotDir, `metadata-source-${viewport.width}.png`)
      await page.screenshot({ path: screenshot })
      screenshots.push(screenshot)
    }
    await page.setViewportSize({ width: 1320, height: 860 })
    await drawer.locator('.el-drawer__close-btn').click()
    await rows.nth(1).click()
    assert.equal(await drawer.locator('.manual-source-alert').count(), 0)
    assert.equal(await drawer.getByText('非 EH/EX 来源', { exact: true }).count(), 1)
    await page.setViewportSize({ width: 390, height: 844 })
    await drawer.locator('.manual-source-selection').scrollIntoViewIfNeeded()
    const dualSourceBounds = await drawer.locator('.manual-source-selection').evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth }))
    assert.ok(dualSourceBounds.scroll <= dualSourceBounds.width + 1, `Dual source controls overflow: ${JSON.stringify(dualSourceBounds)}`)
    const descriptionBounds = await drawer.locator('.anomaly-description').evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth }))
    assert.ok(descriptionBounds.scroll <= descriptionBounds.width + 1, `Source URL details overflow: ${JSON.stringify(descriptionBounds)}`)
    const dualSourceScreenshot = path.join(screenshotDir, 'metadata-source-dual-390.png')
    await page.screenshot({ path: dualSourceScreenshot })
    screenshots.push(dualSourceScreenshot)
    await page.setViewportSize({ width: 1320, height: 860 })
    await drawer.getByRole('radio', { name: '使用 .ehviewer 来源', exact: true }).locator('..').click()
    await page.waitForFunction(() => window.fixtureCalls.some(call => call.type === 'save' && call.review.manualActions['legacy-conflict']?.source === 'ehviewer'))
    assert.equal(await drawer.getByRole('radio', { name: /使用当前 URL 来源.*nHentai/ }).isDisabled(), false)
    await drawer.locator('.el-drawer__close-btn').click()
    await rows.nth(2).click()
    assert.equal(await drawer.getByRole('radio', { name: /使用当前 URL 来源.*未支持的来源/ }).isDisabled(), true)
    assert.deepEqual(errors, [])
    return { result: 'NH source can be selected and persisted; legacy availability is not applied to NH; explicit EH source selection works; unsupported sources are disabled', screenshots, errors }
  } finally {
    await browser.close()
  }
}

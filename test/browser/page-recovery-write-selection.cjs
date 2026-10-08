const assert = require('node:assert/strict')
const path = require('node:path')

module.exports = async ({ chromium, executablePath, baseUrl, imageDataUrl, screenshotDir }) => {
  const browser = await chromium.launch({ headless: true, executablePath })
  const page = await browser.newPage({ viewport: { width: 1320, height: 860 } })
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(({ image }) => {
    const url = 'https://exhentai.org/g/1234567/abcdef1234/'
    let remaining = [19, 22, 29]
    let session = null
    let report = {
      reportId: 'write-selection-report', executable: true, stale: false,
      summary: { libraryItems: 1, databaseRecords: 1, anomalyBooks: 1, batchSafeAnomalies: 0, manualReviewAnomalies: 0, reportOnlyAnomalies: 1 },
      anomalies: [{
        id: 'gap-one', bookId: 'book-one', filepath: 'C:/fixture/one.cbz',
        type: 'archive-image-sequence-gap', severity: 'high', reason: 'Missing pages 19, 22, 29',
        recommendedAction: 'review', actionPolicy: 'report-only',
        evidence: { currentUrl: url, pageCount: 36, imageSequence: { gaps: [{ first: 1, last: 39, missingNumbers: [...remaining] }] } }
      }]
    }
    window.fixtureCalls = []
    window.fixtureApplyFailure = false
    window.auditApi = {
      loadSetting: async () => ({ language: 'zh-CN', theme: 'dark', library: 'C:/fixture/Library' }),
      getLocale: async () => 'zh-CN',
      getWorkspaceState: async () => ({ activeTask: null, channels: { anomaly: { status: 'completed', latestReportId: report.reportId } }, lock: { locked: false } }),
      getReport: async type => type === 'anomaly' ? report : null,
      getReview: async () => ({ reportId: report.reportId, actionIds: [], manualActions: {}, selections: {} }),
      getLogs: async () => [], onState: () => () => {}, onLog: () => () => {},
      getBookPreview: async id => ({ id, title: 'Write selection fixture', type: 'zip', coverPath: image, url, filecount: 39 }),
      pageRecovery: {
        listLatest: async () => [],
        getLatest: async () => session,
        fetch: async request => {
          window.fixtureCalls.push({ type: 'fetch', request })
          for (const number of request.pageNumbers) {
            if (!remaining.includes(number) || number + request.sourceOffset < 1) throw new Error('fixture-invalid-page-selection')
          }
          session = {
            recoveryId: 'write-selection-session', reportId: report.reportId, anomalyId: request.anomalyId,
            sourceOffset: request.sourceOffset, source: { type: 'ehentai', url },
            local: { pageCount: 39 - remaining.length }, online: { pageCount: 39 },
            status: 'awaiting-confirmation', writeBackSupported: true, availablePages: [...remaining],
            candidates: request.pageNumbers.map(number => ({
              id: `candidate:${number}`, pageNumber: number, sourcePageNumber: number + request.sourceOffset,
              targetPath: `page-${number}.png`, status: 'downloaded', previewDataUrl: image,
              localContext: { previous: { pageNumber: number - 1, status: 'available', previewDataUrl: image }, next: { pageNumber: number + 1, status: 'available', previewDataUrl: image } }
            }))
          }
          return session
        },
        apply: async request => {
          window.fixtureCalls.push({ type: 'apply', request })
          if (window.fixtureApplyFailure) throw new Error('fixture-write-failed')
          const written = session.candidates.filter(candidate => request.candidateIds.includes(candidate.id)).map(candidate => candidate.pageNumber)
          remaining = remaining.filter(number => !written.includes(number))
          session = { ...session, status: remaining.length ? 'awaiting-confirmation' : 'completed', candidates: [], availablePages: [...remaining], remainingMissingPages: [...remaining] }
          if (!remaining.length) report = { ...report, anomalies: [] }
          return { session, resolved: !remaining.length }
        }
      }
    }
  }, { image: imageDataUrl })

  const missingCheckboxes = page.locator('.page-recovery-pages .el-checkbox')
  const fetchButton = page.getByRole('button', { name: '获取选中页', exact: true })
  const applyButton = page.locator('.page-recovery-actions button').first()
  const apply = async () => {
    await applyButton.click()
    await page.locator('.el-message-box').getByRole('button', { name: '确定', exact: true }).click()
  }
  try {
    await page.goto(`${baseUrl}/audit.html`)
    await page.locator('.el-table__body-wrapper .el-table__row').first().click()
    await missingCheckboxes.filter({ hasText: /^\s*29\s*$/ }).click()
    await fetchButton.click()
    await page.waitForFunction(() => document.querySelectorAll('.page-recovery-candidate-select').length === 2)
    await page.locator('.page-recovery-candidate-select').nth(0).click()
    await page.locator('.page-recovery-candidate-select').nth(1).click()

    await page.evaluate(() => { window.fixtureApplyFailure = true })
    await apply()
    await page.locator('.el-message--error').filter({ hasText: 'fixture-write-failed' }).waitFor()
    assert.deepEqual(await page.locator('.page-recovery-pages input').evaluateAll(inputs => inputs.map(input => input.checked)), [true, true, false])
    assert.deepEqual(await page.locator('.page-recovery-candidate-select input').evaluateAll(inputs => inputs.map(input => input.checked)), [true, true])

    await page.evaluate(() => { window.fixtureApplyFailure = false })
    await apply()
    await page.waitForFunction(() => document.querySelectorAll('.page-recovery-pages .el-checkbox').length === 1)
    assert.equal((await missingCheckboxes.innerText()).trim(), '29')
    assert.equal(await missingCheckboxes.locator('input').isChecked(), false)
    assert.equal(await page.locator('.page-recovery-offset-mapping').innerText(), '')
    assert.equal(await fetchButton.isDisabled(), true)
    assert.equal(await page.locator('.page-recovery-candidates').count(), 0)

    const offset = page.locator('#page-recovery-offset')
    await offset.fill('-25')
    await offset.press('Tab')
    await missingCheckboxes.click()
    assert.match(await page.locator('.page-recovery-offset-mapping').innerText(), /本地第 29 页 · 来源第 4 页/)
    await fetchButton.click()
    await page.locator('.page-recovery-context.is-target').filter({ hasText: '来源第 4 页' }).waitFor()
    const requests = await page.evaluate(() => window.fixtureCalls.filter(call => call.type === 'fetch').map(call => call.request))
    assert.deepEqual(requests.map(request => request.pageNumbers), [[19, 22], [29]])
    assert.equal(requests[1].sourceOffset, -25)
    assert.equal(await page.locator('.page-recovery-candidate-select input').isChecked(), false)
    assert.equal(await applyButton.isDisabled(), true)

    const screenshots = []
    for (const viewport of [{ width: 1320, height: 860 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      await offset.scrollIntoViewIfNeeded()
      const filename = path.join(screenshotDir, `write-selection-${viewport.width}.png`)
      await page.screenshot({ path: filename })
      screenshots.push(filename)
    }
    await page.locator('.page-recovery-candidate-select').click()
    await apply()
    await page.locator('.el-drawer:visible').waitFor({ state: 'hidden' })
    assert.deepEqual(await page.evaluate(() => window.fixtureCalls.filter(call => call.type === 'apply').map(call => call.request.candidateIds)), [['candidate:19', 'candidate:22'], ['candidate:19', 'candidate:22'], ['candidate:29']])
    assert.deepEqual(errors, [])
    return { result: 'Failed writes keep selections; successful writes clear old selections; subsequent fetch only requests remaining selected pages; complete recovery closes the resolved drawer', screenshots, errors }
  } finally {
    await browser.close()
  }
}

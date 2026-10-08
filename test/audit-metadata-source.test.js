const test = require('node:test')
const assert = require('node:assert/strict')
const {
  extractMetadataSourceIdentity,
  isSameMetadataSource,
  isAutomaticSourceReplacementBlocked
} = require('../modules/audit/utils.js')
const { buildManualSourceAction, verifyNhentaiSourceAction } = require('../modules/audit/manual_source_action.js')
const { normalizeAnomalyReview } = require('../modules/audit/review_validator.js')
const { getBatchSafeActionIds, classifyAnomalyAction } = require('../modules/audit/action_policy.js')

const nhUrl = 'https://nhentai.net/g/599555/'
const ehUrl = 'https://exhentai.org/g/599555/abcdef1234/'
const anomaly = {
  id: 'nh-source', type: 'metadata-incomplete', bookId: 'nh-book', filepath: 'C:/Library/book.zip',
  evidence: { currentUrl: nhUrl, ehviewer: { gid: '599555', token: 'abcdef1234' } }
}
const build = (source = 'current', item = anomaly) => buildManualSourceAction({
  anomaly: item, source, actual: { filepath: item.filepath, bundleSize: 123, mtimeMs: 456 }
})

test('metadata source identities keep provider namespaces separate', () => {
  const nh = extractMetadataSourceIdentity(nhUrl)
  const eh = extractMetadataSourceIdentity(ehUrl)
  assert.deepEqual(nh, { provider: 'nhentai', id: '599555', token: null })
  assert.deepEqual(eh, { provider: 'ehentai', id: '599555', token: 'abcdef1234' })
  assert.equal(isSameMetadataSource(nh, eh), false)
  assert.equal(isSameMetadataSource(eh, extractMetadataSourceIdentity('https://e-hentai.org/g/599555/ABCDEF1234/')), true)
  assert.equal(isSameMetadataSource(nh, extractMetadataSourceIdentity('https://www.nhentai.net/g/599555/?x=1')), true)
  for (const url of ['https://nhentai.net.evil.test/g/599555/', 'https://example.com/?url=' + nhUrl,
    'file://nhentai.net/g/599555/', 'https://nhentai.net/g/599555/1/', 'https://exhentai.org/g/599555/', 'not a URL']) {
    assert.equal(extractMetadataSourceIdentity(url), null, url)
  }
})

test('nHentai current sources can be approved without accepting a forged cross-provider target', () => {
  const action = build()
  const report = { reportId: 'anomaly:nh', executable: true, anomalies: [anomaly] }
  const review = { reportId: report.reportId, actionIds: [anomaly.id], manualActions: { [anomaly.id]: action } }
  assert.equal(normalizeAnomalyReview(report, review).manualActions[anomaly.id].newUrl, nhUrl)
  assert.equal(classifyAnomalyAction(anomaly).actionPolicy, 'manual')
  assert.throws(() => normalizeAnomalyReview(report, {
    ...review, manualActions: { [anomaly.id]: { ...action, newUrl: ehUrl } }
  }), /INVALID_MANUAL_SOURCE_TARGET/)
  const ehAction = build('ehviewer')
  assert.equal(normalizeAnomalyReview(report, { ...review, manualActions: { [anomaly.id]: ehAction } }).manualActions[anomaly.id].newUrl, ehUrl)
})

test('source selection distinguishes missing, invalid and unsupported URLs', () => {
  for (const [currentUrl, code] of [[null, 'MANUAL_SOURCE_URL_MISSING'], ['https://nhentai.net/g/not-an-id/', 'MANUAL_SOURCE_URL_INVALID'], ['https://example.com/book/1', 'MANUAL_SOURCE_PROVIDER_UNSUPPORTED']]) {
    assert.throws(() => build('current', { ...anomaly, evidence: { currentUrl } }), new RegExp(code))
  }
})

test('legacy automatic cross-source replacements are not batch-safe, but explicit choices remain valid', () => {
  const action = { ...build('ehviewer'), repairKind: 'identity-replacement' }
  const legacy = { ...anomaly, type: 'ehviewer-url-conflict-online', action }
  assert.equal(isAutomaticSourceReplacementBlocked(action), true)
  assert.deepEqual(getBatchSafeActionIds({ anomalies: [legacy] }), [])
  assert.equal(classifyAnomalyAction(legacy).actionPolicy, 'manual')
  assert.equal(isAutomaticSourceReplacementBlocked(build('ehviewer')), false)
  assert.equal(isAutomaticSourceReplacementBlocked({ ...action, currentUrl: null, repairKind: 'source-recovery' }), false)
  assert.equal(isAutomaticSourceReplacementBlocked({ ...action, currentUrl: ehUrl }), false)
  assert.equal(isAutomaticSourceReplacementBlocked({ ...action, currentUrl: 'https://example.com/book/1' }), true)
})

test('nHentai approval verification reuses the metadata fetcher and validates the selected gallery', async () => {
  const action = build()
  const setting = { nhentaiApiKey: 'fixture-key', proxy: 'http://fixture-proxy:1234' }
  let request
  const metadata = { title: 'Fresh NH title', url: nhUrl, filecount: 59, status: 'tagged' }
  const result = await verifyNhentaiSourceAction({ action, setting, storePath: 'C:/fixture', fetchMetadata: async value => { request = value; return metadata } })
  assert.deepEqual(result, { valid: true, newUrl: nhUrl, metadata })
  assert.deepEqual(request, { id: '599555', url: nhUrl, setting, storePath: 'C:/fixture' })
  for (const invalid of [null, { ...metadata, title: '' }, { ...metadata, url: 'https://nhentai.net/g/1/' }, { ...metadata, url: ehUrl }]) {
    assert.equal((await verifyNhentaiSourceAction({ action, fetchMetadata: async () => invalid })).error, 'NHENTAI_METADATA_INVALID')
  }
  assert.equal((await verifyNhentaiSourceAction({ action: { ...action, repairKind: 'identity-replacement' } })).error, 'INVALID_REPAIR_CANDIDATE_URL')
})

test('nHentai approval verification reports API key and network failures without credentials', async () => {
  const action = build()
  const setting = { nhentaiApiKey: 'fixture-secret' }
  for (const [message, code] of [['NHENTAI_API_KEY_MISSING', 'NHENTAI_API_KEY_MISSING'], ['socket hang up', 'NHENTAI_METADATA_UNAVAILABLE']]) {
    const result = await verifyNhentaiSourceAction({ action, setting, fetchMetadata: async () => { throw new Error(message) } })
    assert.equal(result.valid, false)
    assert.equal(result.error, code)
    assert.equal(JSON.stringify(result).includes(setting.nhentaiApiKey), false)
  }
})

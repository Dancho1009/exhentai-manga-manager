const test = require('node:test')
const assert = require('node:assert/strict')
const { checkRepairCandidate, describeAvailabilityFailure } = require('../modules/audit/repair_availability.js')

const url = 'https://exhentai.org/g/3379429/156e2a74f0/'
const availability = (eh, ex) => ({
  sites: { ehentai: { status: eh, httpStatus: 404 }, exhentai: { status: ex, httpStatus: ex === 'available' ? 200 : null } }
})

test('approval accepts either accessible site, retrying transient failure only once', async () => {
  let calls = 0
  const waits = []
  const requests = []
  const result = await checkRepairCandidate({ url, setting: { requireGap: 1500 }, wait: async ms => waits.push(ms), checkSites: async request => {
    requests.push(request)
    return ++calls === 1 ? availability('generic-unavailable', 'network-error') : availability('generic-unavailable', 'available')
  } })
  assert.equal(result.valid, true)
  assert.equal(result.candidate.sites.ehentai.status, 'generic-unavailable')
  assert.equal(calls, 2)
  assert.deepEqual(waits, [1000])
  assert.equal(requests.every(value => value.force && value.strategy === 'both' && value.setting.requireGap === 1500), true)
  calls = 0
  const fallback = await checkRepairCandidate({ url, checkSites: async () => { calls++; return availability('available', 'network-error') } })
  assert.equal(fallback.valid, true)
  assert.equal(calls, 1)
})

test('approval failure preserves both site evidence and does not equate access failures with copyright', async () => {
  for (const [status, code, count] of [
    ['network-error', 'REPAIR_CANDIDATE_NETWORK_ERROR', 2],
    ['service-unavailable', 'REPAIR_CANDIDATE_SERVICE_UNAVAILABLE', 2],
    ['unknown', 'REPAIR_CANDIDATE_STATUS_UNKNOWN', 2],
    ['auth-required', 'REPAIR_CANDIDATE_AUTH_REQUIRED', 1],
    ['ip-banned', 'REPAIR_CANDIDATE_IP_BANNED', 1],
    ['copyright', 'REPAIR_CANDIDATE_COPYRIGHT', 1],
    ['geo-blocked', 'REPAIR_CANDIDATE_GEO_BLOCKED', 1],
    ['gallery-not-found', 'REPAIR_CANDIDATE_NOT_FOUND', 1]
  ]) {
    let calls = 0
    const result = await checkRepairCandidate({ url, wait: async () => {}, checkSites: async () => {
      calls++
      return { sites: { ehentai: { status, httpStatus: 404, claimant: 'A.B. Comics', html: 'secret html', headers: { cookie: 'secret-cookie' } },
        exhentai: { status, error: 'socket hang up' } } }
    } })
    assert.equal(result.valid, false)
    assert.equal(result.error, code)
    assert.equal(calls, count)
    assert.equal(result.detail.sites.ehentai.httpStatus, 404)
    assert.equal(result.detail.sites.exhentai.error, 'socket hang up')
    assert.equal(JSON.stringify(result).includes('secret'), false)
  }
  assert.equal(describeAvailabilityFailure(availability('copyright', 'unknown')).error, 'REPAIR_CANDIDATE_STATUS_UNKNOWN')
  assert.equal((await checkRepairCandidate({ url: 'invalid' })).error, 'INVALID_REPAIR_CANDIDATE_URL')
})

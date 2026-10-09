const assert = require('node:assert/strict')
const test = require('node:test')
const { shouldOfferUpdate } = require('../src/update-version.cjs')

test('offers only a strictly newer release', () => {
  assert.equal(shouldOfferUpdate('1.0.9', '1.0.10'), true)
  assert.equal(shouldOfferUpdate('1.0.9', '1.1.0'), true)
  assert.equal(shouldOfferUpdate('1.0.9', '2.0.0'), true)
})

test('ignores stale, equal, or unidentified releases', () => {
  assert.equal(shouldOfferUpdate('1.0.9', '1.0.8'), false)
  assert.equal(shouldOfferUpdate('1.0.9', '1.0.9'), false)
  assert.equal(shouldOfferUpdate('1.0.9', undefined), false)
  assert.equal(shouldOfferUpdate('1.0.9', 'invalid'), false)
})

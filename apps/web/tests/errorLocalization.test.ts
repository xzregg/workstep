import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { translateErrorText } from '../../../packages/gateway-ui/src/errorText'
import { ApiError, request } from '../src/api/transport'
import { useLocaleStore } from '../src/i18n'

test('known English errors use the active locale and keep their original detail', () => {
  const previous = useLocaleStore.getState().locale
  try {
    useLocaleStore.getState().setLocale('zh-CN')
    const error = new ApiError('Provider not found: my-provider', 404)
    assert.equal(error.message, '供应商不存在：my-provider')
    assert.equal(error.rawMessage, 'Provider not found: my-provider')
    assert.equal(error.status, 404)
    useLocaleStore.getState().setLocale('en-US')
    assert.equal(new ApiError(error.rawMessage, 404).message, error.rawMessage)
  } finally {
    useLocaleStore.getState().setLocale(previous)
  }
})

test('historical errors and custom language packs retain dynamic details', () => {
  assert.equal(translateErrorText('供应商不存在：my-provider', 'en-US'), 'Provider not found: my-provider')
  assert.equal(translateErrorText('Provider not found: my-provider', 'fr-FR',
    { 'errors.providerNotFoundWithId': 'Le fournisseur {p0} est introuvable' }), 'Le fournisseur my-provider est introuvable')
})

test('all non-English built-in languages translate provider errors with their details', () => {
  for (const locale of ['zh-CN', 'zh-TW', 'ja-JP', 'fr-FR', 'de-DE', 'ar']) {
    const english = 'Provider not found: my-provider'
    const localized = translateErrorText(english, locale)
    assert.notEqual(localized, english, locale)
    assert.match(localized, /my-provider/, locale)
  }
})

test('unknown upstream errors remain readable and embedded text does not match', () => {
  const upstream = 'Upstream said: Provider not found'
  assert.equal(translateErrorText(upstream, 'zh-CN'), upstream)
})

test('REST failure shapes translate known errors and preserve ordinary response content', async (t) => {
  const previous = useLocaleStore.getState().locale
  useLocaleStore.getState().setLocale('zh-CN')
  t.after(() => useLocaleStore.getState().setLocale(previous))
  const fetch = t.mock.method(globalThis, 'fetch')
  fetch.mock.mockImplementation(async () => Response.json({
    detail: [{ msg: 'Provider not found' }, { type: 'value_error', msg: 'Value error, Select a provider' }],
  }, { status: 422 }))
  await assert.rejects(request('/provider/failure'), (error: ApiError) => {
    assert.equal(error.status, 422)
    assert.equal(error.rawMessage, 'Provider not found; Value error, Select a provider')
    assert.equal(error.message, '供应商不存在; 请选择供应商')
    return true
  })
  fetch.mock.mockImplementation(async () => Response.json({
    saved: false, message: 'Provider not found', content: 'Provider not found',
  }))
  assert.deepEqual(await request('/provider/result'), {
    saved: false, message: '供应商不存在', content: 'Provider not found',
  })
})

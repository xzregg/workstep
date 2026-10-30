import assert from 'node:assert/strict'
import test from 'node:test'
import { contentLocale, templateLocale, visibleTemplates } from '../src/utils/contentLocale'
import { useLocaleStore } from '../src/i18n'

for (const locale of ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'es-ES']) {
  test(`template selection for ${locale} preserves custom assets`, () => {
    const templates = [
      {id: 'zh', default: true, locale: 'zh-CN'},
      {id: 'en', default: true, locale: 'en-US'},
      {id: 'custom'},
    ]
    const chinese = locale.startsWith('zh')
    assert.equal(templateLocale(locale), chinese ? 'zh-CN' : 'en-US')
    assert.deepEqual(visibleTemplates(templates, locale).map(t => t.id), [chinese ? 'zh' : 'en', 'custom'])
  })
}

test('output uses selected locale including a custom language', () => {
  const previous = useLocaleStore.getState().locale
  try {
    useLocaleStore.setState({locale: 'es-ES'})
    assert.equal(contentLocale(), 'es-ES')
  } finally { useLocaleStore.setState({locale: previous}) }
})


test('language changes retain an explicitly selected template in the creation dropdown', () => {
  const templates = [{id: 'flow', default: true, locale: 'zh-CN'}, {id: 'flow-en', default: true, locale: 'en-US'}]
  assert.deepEqual(visibleTemplates(templates, 'zh-CN', 'flow-en').map(t => t.id), ['flow', 'flow-en'])
})

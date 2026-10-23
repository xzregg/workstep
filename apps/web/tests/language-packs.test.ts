import test from 'node:test'
import assert from 'node:assert/strict'
import { validateLanguage, languageCatalog } from '../src/i18n/languagePack.ts'
import { flatten } from '../src/i18n/index.tsx'
import { zhCN } from '../src/i18n/locales/zh-CN.ts'
import { languagesApi } from '../src/api/languages.ts'
import { createLanguageT, useLocaleStore } from '../src/i18n/index.tsx'
const document = () => ({manifest: {schema_version: 1, id: 'spanish', locale: 'es-ES', name: '西班牙语', native_name: 'Español', version: '1.0.0', direction: 'ltr', fallback_locale: 'en-US', catalog_revision: languageCatalog.revision}, revision: 'a'.repeat(64), messages: {...Object.fromEntries(languageCatalog.required_keys.map(key => [key, languageCatalog.messages[key]])), 'nav.settings': 'Ajustes'}})
test('runtime translations fall back to declared builtin and preserve placeholders', () => {
 const pack = validateLanguage(document())
 const t = createLanguageT(pack)
 assert.equal(t('nav.settings'), 'Ajustes')
 assert.equal(t('common.save'), 'Save')
 assert.equal(t('taskDetail.artifactNotFound', {name:'x'}), 'No artifact file found for "x"')
})
test('new builtins can be fallbacks but cannot be replaced by runtime packs', () => {
 for (const [locale, save] of [['fr-FR', 'Enregistrer'], ['de-DE', 'Speichern'], ['ar', 'حفظ']]) {
  const pack = document(); pack.manifest.fallback_locale = locale
  assert.equal(createLanguageT(validateLanguage(pack))('common.save'), save)
  pack.manifest.locale = locale
  assert.throws(() => validateLanguage(pack))
 }
})
test('invalid cached or downloaded language cannot replace active language', () => {
 for (const mutate of [p => delete p.messages['interaction.deny'], p => p.messages['common.confirm'] = '{bad}', p => p.messages['common.cancel'] = '<script>x</script>', p => p.manifest.locale = 'zh-CN']) {
  const p = document(); mutate(p); assert.throws(() => validateLanguage(p))
 }
})
test('preview cancellation restores language and confirmation retains it', () => {
 const store = useLocaleStore.getState()
 store.setLocale('zh-CN'); store.previewLanguage(validateLanguage(document()))
 assert.equal(useLocaleStore.getState().locale, 'es-ES')
 store.cancelPreview(); assert.equal(useLocaleStore.getState().locale, 'zh-CN')
 store.previewLanguage(validateLanguage(document())); store.confirmPreview()
 assert.equal(useLocaleStore.getState().locale, 'es-ES')
 store.setLocale('zh-CN')
})

test('generated catalog exactly matches nonempty source translations', () => {
 assert.deepEqual(languageCatalog.messages, Object.fromEntries(Object.entries(flatten(zhCN)).filter(([,text]) => text.trim())))
})
test('failed or late downloads preserve the newer selection; catalog loads are deduplicated', async () => {
 const oldGet=languagesApi.get, oldList=languagesApi.list
 try {
  const store=useLocaleStore.getState(); store.setLocale('zh-CN')
  languagesApi.get=async () => { throw new Error('offline') }
  store.setLocale('pack:spanish')
  await new Promise(resolve => setTimeout(resolve,20))
  assert.equal(useLocaleStore.getState().locale,'zh-CN'); assert.match(useLocaleStore.getState().error,/offline/)
  let finish; languagesApi.get=() => new Promise(resolve => { finish=resolve })
  store.setLocale('pack:spanish'); await new Promise(resolve => setTimeout(resolve,20)); store.setLocale('ja-JP'); finish(document())
  await new Promise(resolve => setTimeout(resolve,20)); assert.equal(useLocaleStore.getState().locale,'ja-JP')
  let calls=0; languagesApi.list=async () => { calls++; await new Promise(resolve => setTimeout(resolve,5)); return [] }
  await Promise.all([store.refresh(),store.refresh()]); assert.equal(calls,1)
  store.previewLanguage(validateLanguage(document())); store.confirmPreview(); await store.refresh()
  assert.equal(useLocaleStore.getState().locale,'en-US')
 } finally { languagesApi.get=oldGet; languagesApi.list=oldList; useLocaleStore.getState().setLocale('zh-CN') }
})

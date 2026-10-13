import { installDomEnvironment } from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { languagesApi } from '../src/api/languages'
import { languageCatalog } from '../src/i18n/languagePack'
import LanguageDraftPanel from '../src/components/LanguageDraftPanel'
test('ordinary conversation completion reloads language draft once; install previews without altering skins', async () => {
 const {window}=installDomEnvironment()
 useLocaleStore.getState().setLocale('zh-CN')
 const pack={manifest:{schema_version:1,id:'spanish',locale:'es-ES',name:'西班牙语',native_name:'Español',version:'1.0.0',fallback_locale:'en-US',direction:'ltr',catalog_revision:languageCatalog.revision},revision:'a'.repeat(64),messages:{...Object.fromEntries(languageCatalog.required_keys.map(key=>[key,languageCatalog.messages[key]])),'nav.settings':'Ajustes'}}
 const original={...languagesApi}; let reads=0, registrations=0
 languagesApi.validate=async path=>{ assert.equal(path,'/tmp/runtime/language'); reads++; return {package:pack,coverage:{total:2963,translated:6,missing:['nav.projects']}} }
 languagesApi.register=async ()=>{registrations++; return pack}
 languagesApi.list=async()=>[pack]
 const root=createRoot(document.body.appendChild(document.createElement('div')))
 const render=(running:boolean)=>root.render(<I18nProvider><LanguageDraftPanel workspacePath="/tmp/runtime" running={running}/></I18nProvider>)
 try {
  await act(async()=>render(false)); assert.equal(reads,1)
  await act(async()=>render(true)); assert.equal(reads,1)
  await act(async()=>render(false)); assert.equal(reads,2)
  await act(async()=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='安装并预览')!.click())
  assert.equal(registrations,1); assert.equal(useLocaleStore.getState().locale,'es-ES')
  assert.ok(document.querySelector('.language-preview-notice'))
  assert.equal(reads,2,'changing preview locale must not reload drafts')
  await act(async()=>[...document.querySelectorAll<HTMLButtonElement>('.language-preview-notice button')].find(button=>button.textContent==='取消预览')!.click())
  assert.equal(useLocaleStore.getState().locale,'zh-CN')
 } finally { await act(async()=>root.unmount()); Object.assign(languagesApi,original); useLocaleStore.getState().setLocale('zh-CN'); await window.happyDOM.close() }
})

test('persisted cache is validated and preview persists only previous preference', () => {
 const options=useLocaleStore.persist.getOptions()
 const current=useLocaleStore.getState()
 assert.equal(options.merge!({locale:'es-ES',language:{manifest:{},messages:{}}},current).locale,current.locale)
 assert.equal(options.merge!({locale:'ja-JP'},current).locale,'ja-JP')
 const preview={...current,locale:'es-ES',previous:{locale:'zh-CN',language:null}}
 assert.deepEqual(options.partialize!(preview),{locale:'zh-CN',language:null})
})

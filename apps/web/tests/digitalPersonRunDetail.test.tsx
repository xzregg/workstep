import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {I18nProvider,useLocaleStore} from '../src/i18n'
import DigitalPersonRunDetail from '../src/components/digital-person/DigitalPersonRunDetail'
import {digitalRuntimeApi} from '../src/api/digitalPerson'

useLocaleStore.setState({locale:'zh-CN',language:null})

test('failed thoughts distinguish saved content from the failure reason and display zero affinity',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host),original=digitalRuntimeApi.runDetail
 digitalRuntimeApi.runDetail=async()=>({id:'failed',status:'failed',created_at:'2026-11-17',error:'检查结果来源无效',draft_summary:'我想跟进昨天的安排。',failure_reason:'未能确认思考内容对应的消息，本轮结果未采用。',outcome:{sent:0,failed:0,affinity_increased:0,affinity_decreased:0}})
 try{
  await act(async()=>root.render(<I18nProvider><DigitalPersonRunDetail id="failed" busy={false}/></I18nProvider>))
  assert.match(host.textContent!,/我想跟进昨天的安排。/)
  assert.match(host.textContent!,/本轮结果未采用/)
  assert.match(host.textContent!,/好感度 0/)
  assert.doesNotMatch(host.textContent!,/检查结果来源无效/)
  digitalRuntimeApi.runDetail=async()=>({id:'old',status:'failed',created_at:'2026-11-17',error:'检查结果来源无效'})
  await act(async()=>root.render(<I18nProvider><DigitalPersonRunDetail id="old" busy={false}/></I18nProvider>))
  assert.match(host.textContent!,/本轮未保存思考内容/)
 }finally{await act(async()=>root.unmount());digitalRuntimeApi.runDetail=original;await window.happyDOM.close()}
})

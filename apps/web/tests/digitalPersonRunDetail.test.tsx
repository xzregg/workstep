import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {I18nProvider,useLocaleStore} from '../src/i18n'
import DigitalPersonRunDetail from '../src/components/digital-person/DigitalPersonRunDetail'
import {DigitalPersonRunDelivery,DigitalPersonRunNotificationReasons} from '../src/components/digital-person/DigitalPersonRunOutcome'
import {digitalRuntimeApi} from '../src/api/digitalPerson'

useLocaleStore.setState({locale:'zh-CN',language:null})

test('notification reasons show only factual categories or nonblank model reasons',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 try{
  for(const [notification,expected] of [
   [{state:'silent',reason:'model_silent',model_reason:'相同阻塞已向用户报告，等待用户回复。'},/LLM.*相同阻塞已向用户报告/],
   [{state:'silent',reason:'model_silent'},/^$/],
   [{state:'silent',reason:'model_silent',model_reason:'  \n '},/^$/],
   [{state:'silent',reason:'unknown'},/^$/],
   [{state:'silent',reason:'unrecognized'},/^$/],
   [{state:'deferred',reason:'quiet_hours'},/免打扰/],
   [{state:'delivery_failed',reason:'delivery_failed'},/投递报错/],
   [{state:'suppressed',reason:'target_missing'},/无目标/],
   [undefined,/^$/],
  ] as const){
   await act(async()=>root.render(<I18nProvider><DigitalPersonRunNotificationReasons run={{id:'reason',status:'silent',created_at:'',notification}}/></I18nProvider>))
   assert.match(host.textContent!,expected)
   assert.doesNotMatch(host.textContent!,/未提供|未记录|·\s*$/)
   if(expected.source==='^$')assert.equal(host.childElementCount,0)
  }
 }finally{await act(async()=>root.unmount());await window.happyDOM.close()}
})

test('notification audit distinguishes silent thought from a deferred delegation and unknown history',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 try{
  await act(async()=>root.render(<I18nProvider><DigitalPersonRunDelivery run={{id:'audit',status:'silent',created_at:'',summary:'Android 验收受阻',notification:{state:'silent',reason:'model_silent'},delegation_notifications:[{state:'deferred',reason:'quiet_hours'}]}}/></I18nProvider>))
  assert.match(host.textContent!,/免打扰时段/)
  assert.match(host.textContent!,/委派通知/)
  assert.match(host.textContent!,/Android 验收受阻/)
  await act(async()=>root.render(<I18nProvider><DigitalPersonRunDelivery run={{id:'old',status:'silent',created_at:'',summary:'需要用户处理'}}/></I18nProvider>))
  assert.doesNotMatch(host.textContent!,/未提供|未记录|原因未知/)
  assert.equal(host.querySelectorAll('.digital-run-notification-reasons').length,0)
  assert.doesNotMatch(host.textContent!,/免打扰时段/)
 }finally{await act(async()=>root.unmount());await window.happyDOM.close()}
})

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

test('failed delivery without details keeps the failure label without a placeholder or separator',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 try{
  await act(async()=>root.render(<I18nProvider><DigitalPersonRunDelivery run={{id:'failed',status:'delivery_failed',created_at:''}}/></I18nProvider>))
  assert.match(host.querySelector('[role="alert"]')?.textContent??'',/通知发送失败/)
  assert.doesNotMatch(host.querySelector('[role="alert"]')?.textContent??'',/未提供|未记录|·/)
 }finally{await act(async()=>root.unmount());await window.happyDOM.close()}
})

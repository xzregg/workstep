import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { digitalRuntimeApi } from '../src/api/digitalPerson'
import DigitalPersonChannels from '../src/components/digital-person/DigitalPersonChannels'

test('binds a selected channel peer, requires explicit test send, and allows unbinding',async()=>{
 const {window}=installDomEnvironment(), original={...digitalRuntimeApi}
 useLocaleStore.setState({locale:'zh-CN'})
 const el=document.body.appendChild(document.createElement('div')),root=createRoot(el)
 const peer={id:'peer',conversation_type:'group' as const,conversation_id:'group',bot_id:'bot',bot_name:'机器人',title:'研发群',platform:'dingtalk'}
 let bindings:any[]=[{...peer,id:'existing',notify:true}], tests=0
 digitalRuntimeApi.channels=async()=>({available:[peer],bindings})
 digitalRuntimeApi.bind=async(p,notify,useMainSession)=>{bindings=[{...p,notify,use_main_session:useMainSession}]}
 digitalRuntimeApi.unbind=async()=>{bindings=[]}
 digitalRuntimeApi.test=async()=>{tests++;return {sent:true}}
 const click=async(text:string)=>act(async()=>{Array.from(el.querySelectorAll('button')).find(b=>b.textContent===text)!.click()})
 try {
  await act(async()=>root.render(<I18nProvider><DigitalPersonChannels name="小研"/></I18nProvider>))
  assert.match(el.querySelector('.digital-person-channel')!.textContent!,/研发群/)
  assert.equal(el.querySelectorAll('select').length,0,'channel choices stay hidden before adding')
  await click('编辑')
  assert.equal(el.querySelectorAll<HTMLInputElement>('.digital-person-channel-form input')[1].disabled,true,'group cannot share the main conversation')
  await click('取消')
  await click('添加')
  assert.ok(el.querySelector('.digital-person-channel')!.compareDocumentPosition(el.querySelector('select')!) & window.Node.DOCUMENT_POSITION_FOLLOWING,'bindings appear above choices')
  await click('取消')
  assert.equal(el.querySelectorAll('select').length,0)
  await click('添加')
  const selects=el.querySelectorAll('select')
  await act(async()=>{selects[0].value='bot';selects[0].dispatchEvent(new window.Event('change',{bubbles:true}))})
  await act(async()=>{selects[1].value='peer';selects[1].dispatchEvent(new window.Event('change',{bubbles:true}))})
  await click('绑定');assert.equal(bindings[0].id,'peer');assert.equal(bindings[0].notify,false)
  assert.equal(el.querySelectorAll('select').length,0,'successful binding closes channel choices')
  await click('测试发送');assert.equal(tests,0)
  await act(async()=>el.querySelector<HTMLButtonElement>('.confirm-dialog-confirm')!.click());assert.equal(tests,1)
  await click('解除绑定');assert.equal(bindings.length,0)
 } finally {await act(async()=>root.unmount());Object.assign(digitalRuntimeApi,original);await window.happyDOM.close()}
})

test('main conversation is opt-in per private peer and can be changed on an existing binding',async()=>{
 const {window}=installDomEnvironment(), original={...digitalRuntimeApi}
 useLocaleStore.setState({locale:'zh-CN'})
 const el=document.body.appendChild(document.createElement('div')),root=createRoot(el)
 const peer={id:'owner',conversation_type:'single' as const,conversation_id:'owner',bot_id:'bot',bot_name:'机器人',title:'本人',platform:'wecom'}
 const group={...peer,id:'group',conversation_type:'group' as const,conversation_id:'group',title:'研发群'}
 let bindings:any[]=[], calls:any[]=[]
 digitalRuntimeApi.channels=async()=>({available:[peer,group],bindings})
 digitalRuntimeApi.bind=async(p,notify,useMainSession)=>{calls.push({p,notify,useMainSession});bindings=[{...p,notify,use_main_session:useMainSession}]}
 const click=async(text:string)=>act(async()=>{Array.from(el.querySelectorAll('button')).find(b=>b.textContent===text)!.click()})
 const choose=async(index:number,value:string)=>act(async()=>{const select=el.querySelectorAll('select')[index];select.value=value;select.dispatchEvent(new window.Event('change',{bubbles:true}))})
 try {
  await act(async()=>root.render(<I18nProvider><DigitalPersonChannels name="小研"/></I18nProvider>))
  await click('添加');await choose(0,'bot');await choose(1,'owner')
  const check=()=>el.querySelectorAll<HTMLInputElement>('.digital-person-channel-form input[type=checkbox]')[1]
  assert.equal(check().checked,false)
  assert.equal(check().disabled,false)
  await act(async()=>check().click());assert.equal(check().checked,true)
  await choose(1,'group');assert.equal(check().checked,false);assert.equal(check().disabled,true)
  await choose(1,'owner');await act(async()=>check().click())
  await click('绑定')
  assert.equal(calls[0].useMainSession,true)
  await click('编辑')
  const bound=check()
  assert.equal(bound.checked,true)
  await act(async()=>bound.click())
  assert.equal(calls.length,1,'editing does not save until confirmed')
  await click('保存')
  assert.equal(calls[1].useMainSession,false)
  assert.equal(calls[1].p.id,'owner')
  await click('编辑');assert.equal(check().checked,false)
  await act(async()=>check().click());await click('取消')
  assert.equal(calls.length,2,'cancelling does not change the binding')
 } finally {await act(async()=>root.unmount());Object.assign(digitalRuntimeApi,original);await window.happyDOM.close()}
})

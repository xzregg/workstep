import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import { digitalRuntimeApi } from '../src/api/digitalPerson'
import DigitalPersonChannels from '../src/components/digital-person/DigitalPersonChannels'

test('binds a selected channel peer, requires explicit test send, and allows unbinding',async()=>{
 const {window}=installDomEnvironment(), original={...digitalRuntimeApi}
 const el=document.body.appendChild(document.createElement('div')),root=createRoot(el)
 const peer={id:'peer',conversation_type:'group' as const,conversation_id:'group',bot_id:'bot',bot_name:'机器人',title:'研发群',platform:'dingtalk'}
 let bindings:any[]=[], tests=0
 digitalRuntimeApi.channels=async()=>({available:[peer],bindings})
 digitalRuntimeApi.bind=async(p,notify)=>{bindings=[{...p,notify}]}
 digitalRuntimeApi.unbind=async()=>{bindings=[]}
 digitalRuntimeApi.test=async()=>{tests++;return {sent:true}}
 const click=async(text:string)=>act(async()=>{Array.from(el.querySelectorAll('button')).find(b=>b.textContent===text)!.click()})
 try {
  await act(async()=>root.render(<I18nProvider><DigitalPersonChannels name="小研"/></I18nProvider>))
  const selects=el.querySelectorAll('select')
  await act(async()=>{selects[0].value='bot';selects[0].dispatchEvent(new window.Event('change',{bubbles:true}))})
  await act(async()=>{selects[1].value='peer';selects[1].dispatchEvent(new window.Event('change',{bubbles:true}))})
  await click('绑定');assert.equal(bindings[0].id,'peer');assert.equal(bindings[0].notify,false)
  await click('测试发送');assert.equal(tests,0)
  await act(async()=>el.querySelector<HTMLButtonElement>('.confirm-dialog-confirm')!.click());assert.equal(tests,1)
  await click('解除绑定');assert.equal(bindings.length,0)
 } finally {await act(async()=>root.unmount());Object.assign(digitalRuntimeApi,original);await window.happyDOM.close()}
})

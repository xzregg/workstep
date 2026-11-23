import {installDomEnvironment} from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {I18nProvider,useLocaleStore} from '../src/i18n'
import FaceHomePanel from '../src/components/face-recognition/FaceHomePanel'
import DigitalPersonVisionSettings from '../src/components/face-recognition/DigitalPersonVisionSettings'
import {faceApi} from '../src/api/faces'

test('home face panel protects an unfinished enrollment and returns focus on close',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host),old={...faceApi}
 Object.assign(globalThis,{history:window.history,location:window.location})
 faceApi.people=async()=>({items:[]});faceApi.settings=async()=>({settings:{enabled:false,show_names:true,include_people:true,include_relationship:true,preset:'balanced',threshold:.65},revision:0,model_version:''})
 const trigger=document.body.appendChild(document.createElement('button'));trigger.focus();let closed=0
 const click=async(label:string)=>act(async()=>{const b=[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label||b.getAttribute('aria-label')===label);assert.ok(b,label);b.click()})
 try{
  await act(async()=>root.render(<I18nProvider><FaceHomePanel onClose={()=>closed++}/></I18nProvider>))
  await click('录入人脸')
  await act(async()=>{const input=document.querySelector<HTMLInputElement>('input[placeholder="例如：小张"]')!;Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(input,'小张');input.dispatchEvent(new window.Event('input',{bubbles:true}))})
  await act(async()=>document.querySelector<HTMLButtonElement>('.face-home-close')!.click())
  assert.equal(closed,0);assert.ok(document.querySelector('.confirm-dialog-panel'))
  await act(async()=>document.querySelector<HTMLButtonElement>('.confirm-dialog-confirm')!.click())
  assert.equal(closed,1)
  await act(async()=>root.unmount());assert.equal(document.activeElement,trigger)
 }finally{await act(async()=>root.unmount());Object.assign(faceApi,old);await window.happyDOM.close()}
})

test('home face panel cannot close during an in-flight settings save',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host),old={...faceApi}
 Object.assign(globalThis,{history:window.history,location:window.location})
 const settings={enabled:false,show_names:true,include_people:true,include_relationship:true,preset:'balanced' as const,threshold:.65}
 faceApi.people=async()=>({items:[]});faceApi.settings=async()=>({settings,revision:0,model_version:''})
 let complete!:(value:any)=>void,closed=0
 faceApi.saveSettings=value=>new Promise(resolve=>{assert.deepEqual(value,{...settings,enabled:true});complete=resolve})
 try{
  await act(async()=>root.render(<I18nProvider><FaceHomePanel onClose={()=>closed++}/></I18nProvider>))
  const toggle=document.querySelector<HTMLButtonElement>('[role="switch"]')
  assert.ok(toggle)
  const tabs=document.querySelector('.face-panel-tabs')
  assert.ok(tabs)
  assert.equal(tabs.nextElementSibling,toggle.parentElement)
  assert.equal(toggle.getAttribute('aria-checked'),'false')
  await act(async()=>toggle.click())
  assert.equal(toggle.disabled,true)
  assert.equal(toggle.getAttribute('aria-checked'),'false')
  assert.equal(document.querySelector<HTMLButtonElement>('.face-home-close')!.disabled,true)
  await act(async()=>document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
  assert.equal(closed,0)
  await act(async()=>complete({settings:{...settings,enabled:true},revision:1,model_version:''}))
  assert.equal(toggle.disabled,false)
  assert.equal(toggle.getAttribute('aria-checked'),'true')
  await act(async()=>document.querySelector<HTMLButtonElement>('.face-home-close')!.click());assert.equal(closed,1)
 }finally{await act(async()=>root.unmount());Object.assign(faceApi,old);await window.happyDOM.close()}
})

test('the home face entry saves welcome settings shared with Vision',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host),old={...faceApi}
 const locale=useLocaleStore.getState().locale
 useLocaleStore.setState({locale:'zh-CN'})
 Object.assign(globalThis,{history:window.history,location:window.location})
 const settings={enabled:true,show_names:true,include_people:true,include_relationship:true,preset:'balanced' as const,threshold:.65}
 faceApi.people=async()=>({items:[]});faceApi.settings=async()=>({settings,revision:0})
 let welcome={enabled:false,phrases:['欢迎回来，{name}。'],output:'text' as const,away_minutes:2,person_cooldown_minutes:60,interval_minutes:10,hourly_limit:2,daily_limit:4}
 faceApi.welcomeSettings=async()=>welcome
 faceApi.saveWelcome=async value=>{assert.equal(value.output,'text');welcome={...value,output:'text'};return welcome}
 const click=async(label:string)=>act(async()=>{
  const button=[...document.querySelectorAll<HTMLButtonElement>('button')].find(item=>item.textContent===label)
  assert.ok(button,label);button.click()
 })
 try{
  await act(async()=>root.render(<I18nProvider><FaceHomePanel onClose={()=>{}}/></I18nProvider>))
  await click('人脸唤醒')
  const form=document.querySelector('.face-welcome-settings')!
  assert.equal(form.querySelector('textarea')?.value,welcome.phrases[0])
  await act(async()=>form.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
  await click('保存')
  assert.equal(welcome.enabled,true)
  await act(async()=>root.render(<I18nProvider><DigitalPersonVisionSettings/></I18nProvider>))
  await click('人脸唤醒')
  assert.equal(document.querySelector<HTMLInputElement>('.face-welcome-settings input[type="checkbox"]')?.checked,true)
 }finally{await act(async()=>root.unmount());useLocaleStore.setState({locale});Object.assign(faceApi,old);await window.happyDOM.close()}
})

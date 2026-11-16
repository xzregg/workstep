import {installDomEnvironment} from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {I18nProvider} from '../src/i18n'
import FaceHomePanel from '../src/components/face-recognition/FaceHomePanel'
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
 faceApi.saveSettings=()=>new Promise(resolve=>{complete=resolve})
 try{
  await act(async()=>root.render(<I18nProvider><FaceHomePanel onClose={()=>closed++}/></I18nProvider>))
  await act(async()=>document.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
  assert.equal(document.querySelector<HTMLButtonElement>('.face-home-close')!.disabled,true)
  await act(async()=>document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
  assert.equal(closed,0)
  await act(async()=>complete({settings:{...settings,enabled:true},revision:1,model_version:''}))
  await act(async()=>document.querySelector<HTMLButtonElement>('.face-home-close')!.click());assert.equal(closed,1)
 }finally{await act(async()=>root.unmount());Object.assign(faceApi,old);await window.happyDOM.close()}
})

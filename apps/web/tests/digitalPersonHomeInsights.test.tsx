import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {MemoryRouter} from 'react-router-dom'
import {I18nProvider} from '../src/i18n'
import DigitalPersonHomeInsights from '../src/components/digital-person/DigitalPersonHomeInsights'
import {digitalRuntimeApi,type DigitalActivityRecords} from '../src/api/digitalPerson'
import {DIGITAL_ACTIVITY_CHANGED} from '../src/components/digital-person/useDigitalActivity'
test('home records coalesce refreshes and do not poll hidden or inactive views',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host),original=digitalRuntimeApi.records
 let calls=0,resolve:(data:DigitalActivityRecords)=>void=()=>{}
 digitalRuntimeApi.records=()=>{calls++;return new Promise(done=>{resolve=done})}
 const render=(active:boolean)=>root.render(<I18nProvider><DigitalPersonHomeInsights active={active} name="小研" state="idle" activity={null} affect={null} messages={[]} chatShown={false} onInspect={()=>{}} onWork={()=>{}} onConversation={()=>{}}/></I18nProvider>)
 try{
  await act(async()=>render(true));assert.equal(calls,1)
  assert.match(host.querySelector('.digital-home-affinity')!.textContent!,/—/)
  await act(async()=>{window.dispatchEvent(new window.Event(DIGITAL_ACTIVITY_CHANGED));window.dispatchEvent(new window.Event(DIGITAL_ACTIVITY_CHANGED))});assert.equal(calls,1)
  await act(async()=>resolve({checking:false,run_total:48,delegation_total:0,runs:[],delegations:[]}))
  assert.match(host.querySelector('.digital-home-presence-info')!.textContent!,/48/)
  Object.defineProperty(document,'hidden',{configurable:true,value:true})
  await act(async()=>window.dispatchEvent(new window.Event(DIGITAL_ACTIVITY_CHANGED)));assert.equal(calls,1)
  await act(async()=>render(false));Object.defineProperty(document,'hidden',{configurable:true,value:false})
  await act(async()=>window.dispatchEvent(new window.Event(DIGITAL_ACTIVITY_CHANGED)));assert.equal(calls,1)
 }finally{await act(async()=>root.unmount());digitalRuntimeApi.records=original;await window.happyDOM.close()}
})


test('corner actions open their own information panel instead of settings',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host),original=digitalRuntimeApi.records
 let settings=0;window.addEventListener('workstep:open-digital-person-settings',()=>settings++)
 digitalRuntimeApi.records=async()=>({checking:false,run_total:1,delegation_total:0,runs:[{id:'r1',summary:'今天的思考记录',status:'completed',created_at:'2026-11-16T01:00:00Z'}],delegations:[]})
 try{
  await act(async()=>root.render(<MemoryRouter><I18nProvider><DigitalPersonHomeInsights active name="小研" state="idle" activity={{level:3,experience:20,next_level_experience:100} as any} affect={{name:'会话作者',person_id:'p',affinity:68,emotion:'calm',valence:0,arousal:0,updated_at:null,history:[]}} messages={[]} chatShown={false} onInspect={()=>{}} onWork={()=>{}} onConversation={()=>{}}/></I18nProvider></MemoryRouter>))
  const identity=host.querySelector<HTMLButtonElement>('.digital-home-identity')!;identity.focus()
  await act(async()=>identity.click());assert.match(document.querySelector('[role="dialog"]')!.textContent!,/小研/)
  assert.match(document.querySelector('[role="dialog"]')!.textContent!,/Lv.3/)
  await act(async()=>document.querySelector<HTMLButtonElement>('.digital-home-detail-close')!.click());assert.equal(document.activeElement,identity)
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-affinity')!.click());assert.match(document.querySelector('[role="dialog"]')!.textContent!,/68/)
  await act(async()=>document.querySelector<HTMLButtonElement>('.digital-home-detail-close')!.click())
  await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="主动思考"]')!.click());assert.match(document.querySelector('[role="dialog"]')!.textContent!,/今天的思考记录/)
  assert.equal(settings,0)
 }finally{await act(async()=>root.unmount());digitalRuntimeApi.records=original;await window.happyDOM.close()}
})

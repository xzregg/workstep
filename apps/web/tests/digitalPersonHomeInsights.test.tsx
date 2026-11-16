import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {I18nProvider} from '../src/i18n'
import DigitalPersonHomeInsights from '../src/components/digital-person/DigitalPersonHomeInsights'
import {digitalRuntimeApi,type DigitalActivityRecords} from '../src/api/digitalPerson'
import {DIGITAL_ACTIVITY_CHANGED} from '../src/components/digital-person/useDigitalActivity'
test('home records coalesce refreshes and do not poll hidden or inactive views',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host),original=digitalRuntimeApi.records
 let calls=0,resolve:(data:DigitalActivityRecords)=>void=()=>{}
 digitalRuntimeApi.records=()=>{calls++;return new Promise(done=>{resolve=done})}
 const render=(active:boolean)=>root.render(<I18nProvider><DigitalPersonHomeInsights active={active} name="小研" state="idle" activity={null} affect={null} messages={[]} chatShown={false} onSettings={()=>{}} onWork={()=>{}} onConversation={()=>{}}/></I18nProvider>)
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

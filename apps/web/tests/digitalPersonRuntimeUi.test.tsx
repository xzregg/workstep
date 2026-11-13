import {installDomEnvironment} from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {MemoryRouter} from 'react-router-dom'
import {I18nProvider} from '../src/i18n'
import DigitalPersonCompanion from '../src/components/digital-person/DigitalPersonCompanion'
import DigitalPersonSettings from '../src/components/digital-person/DigitalPersonSettings'
import DigitalPersonActivity from '../src/components/digital-person/DigitalPersonActivity'
import {wakeMatches,useWakeState} from '../src/components/digital-person/digitalPersonWakeState'
import {digitalPersonApi,digitalRuntimeApi} from '../src/api/digitalPerson'
import {assistantApi,providerApi} from '../src/api/client'
const profile={enabled:true,name:'小步',role:'伙伴',personality:'直接',duties:'指派工作',avatar:'robot' as const,greeting:'你好',auto_speak:true}

test('wake matching varies sensitivity without waking on mount',()=>{
 assert.equal(useWakeState.getState().listening,false)
 assert.equal(wakeMatches('你好小步','你好小步','low'),true)
 assert.equal(wakeMatches('你好小步帮个忙','你好小步','low'),false)
 assert.equal(wakeMatches('你好小步帮个忙','你好小步','balanced'),true)
 assert.equal(wakeMatches('你好小布','你好小步','high'),true)
 assert.equal(wakeMatches('你好小布','你好小步','balanced'),false)
 assert.equal(wakeMatches('好的','小步','high'),false)
})
test('companion skips historical audio, speaks completed new replies and cancels on unmount',async()=>{
 const {window}=installDomEnvironment(),element=document.body.appendChild(document.createElement('div')),root=createRoot(element)
 const utterances:any[]=[];let cancelled=0
 const old=(globalThis as any).SpeechSynthesisUtterance
 ;(globalThis as any).SpeechSynthesisUtterance=class{constructor(public text:string){}}
 Object.defineProperty(window,'speechSynthesis',{configurable:true,value:{speak:(u:any)=>utterances.push(u),cancel:()=>cancelled++,getVoices:()=>[]}})
 const render=(replyId?:string,running=false)=>act(async()=>root.render(<I18nProvider><DigitalPersonCompanion profile={profile} replyId={replyId} reply={replyId} running={running}/></I18nProvider>))
 try{
  await render();await render('history');assert.equal(utterances.length,0)
  await render('new',true);assert.equal(utterances.length,0)
  await render('new');assert.equal(utterances.length,1)
  await act(async()=>utterances[0].onstart());assert.ok(element.querySelector('.is-speaking'))
  await act(async()=>root.unmount());assert.equal(cancelled,1);assert.equal(utterances[0].onend,null)
 }finally{(globalThis as any).SpeechSynthesisUtterance=old;element.remove()}
})
test('first enable guides configuration and only activates after finishing',async()=>{
 installDomEnvironment();const element=document.body.appendChild(document.createElement('div')),root=createRoot(element)
 const originals=[digitalPersonApi.get,digitalPersonApi.save,assistantApi.list,providerApi.list,digitalRuntimeApi.channels,digitalRuntimeApi.activity]
 let saved={...profile,enabled:false,onboarding_completed:false}
 digitalPersonApi.get=async()=>saved
 digitalPersonApi.save=async value=>(saved=value as typeof saved)
 assistantApi.list=async()=>({assistants:[{name:'digital_person',fields:['engine'],configured:{},resolved:{},available_engines:[]}]}) as any
 providerApi.list=async()=>({providers:[]}) as any
 digitalRuntimeApi.channels=async()=>({available:[],bindings:[]})
 digitalRuntimeApi.activity=async()=>({level:1,experience:0,next_level_experience:10}) as any
 try{
  await act(async()=>root.render(<MemoryRouter><I18nProvider><DigitalPersonSettings onClose={()=>{}}/></I18nProvider></MemoryRouter>))
  await act(async()=>element.querySelector<HTMLButtonElement>('[role="switch"]')!.click())
  assert.ok(element.querySelector('.digital-person-guide'));assert.equal(saved.enabled,false)
  for(let i=0;i<6;i++)await act(async()=>{const buttons=element.querySelectorAll<HTMLButtonElement>('.digital-person-guide button');buttons[buttons.length-1].click()})
  assert.equal(saved.enabled,true);assert.equal(saved.onboarding_completed,true)
  assert.equal(element.querySelector('.digital-person-guide'),null)
 }finally{
  await act(async()=>root.unmount());element.remove()
  ;[digitalPersonApi.get,digitalPersonApi.save,assistantApi.list,providerApi.list,digitalRuntimeApi.channels,digitalRuntimeApi.activity]=originals as any
 }
})
test('activity exposes evidence and retries only through failed run action',async()=>{
 installDomEnvironment();const element=document.body.appendChild(document.createElement('div')),root=createRoot(element)
 const original=digitalRuntimeApi.activity,retry=digitalRuntimeApi.retryDelivery;let retried=''
 digitalRuntimeApi.activity=async()=>({level:1,experience:0,next_level_experience:10,checking:false,delegations:[],answers:[],runs:[{id:'failed-run',status:'delivery_failed',created_at:'today',summary:'done',sources:{delegations:[{id:'source'}]},deliveries:[{session_id:'peer',status:'failed'}]}]}) as any
 digitalRuntimeApi.retryDelivery=async id=>{retried=id;return {} as any}
 try{
  await act(async()=>root.render(<MemoryRouter><I18nProvider><DigitalPersonActivity/></I18nProvider></MemoryRouter>))
  assert.match(element.querySelector('pre')!.textContent!,/source/)
  await act(async()=>element.querySelector<HTMLButtonElement>('.digital-person-run button')!.click())
  assert.equal(retried,'failed-run')
 }finally{await act(async()=>root.unmount());element.remove();digitalRuntimeApi.activity=original;digitalRuntimeApi.retryDelivery=retry}
})

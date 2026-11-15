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
test('activity loads small pages, opens details on demand, and retries failed delivery',async()=>{
 const {window}=installDomEnvironment();const element=document.body.appendChild(document.createElement('div')),root=createRoot(element)
 const originals={...digitalRuntimeApi};const pages:number[]=[];let retried='',details=0,heavyLoads=0
 digitalRuntimeApi.activity=async()=>{heavyLoads++;throw new Error('full overview must not load')}
 digitalRuntimeApi.records=async(runOffset=0)=>{
  pages.push(runOffset)
  return {checking:false,run_total:7,delegation_total:0,delegations:[],runs:Array.from({length:runOffset?2:5},(_,i)=>({id:`run-${runOffset+i}`,status:'delivery_failed',created_at:'2026-11-14T01:00:00Z',summary:'简短结果'}))}
 }
 digitalRuntimeApi.runDetail=async id=>{details++;return {id,status:'delivery_failed',created_at:'2026-11-14T01:00:00Z',summary:'完整结果仅在展开后读取',error:'通知投递失败'}}
 digitalRuntimeApi.retryDelivery=async id=>{retried=id;return {}}
 try{
  await act(async()=>root.render(<MemoryRouter><I18nProvider><DigitalPersonActivity/></I18nProvider></MemoryRouter>))
  assert.equal(heavyLoads,0);assert.equal(details,0);assert.equal(element.querySelectorAll('[data-run-id]').length,5)
  assert.equal(element.querySelector('pre'),null)
  assert.doesNotMatch(element.textContent!,/完整结果/)
  await act(async()=>element.querySelector<HTMLButtonElement>('[data-run-id="run-0"] button[aria-expanded]')!.click())
  assert.equal(details,1);assert.match(element.textContent!,/完整结果仅在展开后读取/)
  assert.match(element.querySelector('[role=alert]')!.textContent!,/通知投递失败/)
  await act(async()=>element.querySelector<HTMLButtonElement>('[data-retry-delivery]')!.click())
  assert.equal(retried,'run-0')
  await act(async()=>element.querySelector<HTMLButtonElement>('[data-kind=runs] [data-next-page]')!.click())
  assert.equal(pages.at(-1),5);assert.equal(element.querySelectorAll('[data-run-id]').length,2)
  assert.equal(element.querySelector('[data-run-id="run-0"]'),null)
 }finally{await act(async()=>root.unmount());element.remove();Object.assign(digitalRuntimeApi,originals);await window.happyDOM.close()}
})

test('activity keeps delegation notifications separate from thought records',async()=>{
 const {window}=installDomEnvironment();const element=document.body.appendChild(document.createElement('div')),root=createRoot(element)
 const original=digitalRuntimeApi.records
 digitalRuntimeApi.records=async()=>({checking:false,run_total:1,runs:[{id:'thought',status:'silent',summary:'主动思考的摘要',created_at:'2026-11-14T01:00:00Z'}],delegation_total:1,delegations:[{id:'work',instruction:'不应出现在运行记录的委派通知',notification_state:'pending'}]}) as any
 try{
  await act(async()=>root.render(<MemoryRouter><I18nProvider><DigitalPersonActivity/></I18nProvider></MemoryRouter>))
  assert.match(element.textContent!,/主动思考的摘要/)
  assert.ok(element.querySelector('[data-kind=delegations]'))
  assert.ok(element.querySelector('[data-open-execution]'))
  assert.match(element.querySelector('[data-kind=delegations]')!.textContent!,/未通知/)
  assert.doesNotMatch(element.querySelector('[data-kind=runs]')!.textContent!,/委派通知/)
  assert.match(element.querySelector('[data-kind=runs] h3')!.textContent!,/运行记录/)
  assert.doesNotMatch(element.querySelector('[data-kind=delegations]')!.textContent!,/执行中|已完成/)
 }finally{await act(async()=>root.unmount());element.remove();digitalRuntimeApi.records=original;await window.happyDOM.close()}
})

test('activity deduplicates in-flight refreshes and recovers detail errors',async()=>{
 const {window}=installDomEnvironment();const element=document.body.appendChild(document.createElement('div')),root=createRoot(element)
 const originals={...digitalRuntimeApi};let calls=0,attempts=0
 let complete!:(value:any)=>void
 digitalRuntimeApi.records=()=>{calls++;return new Promise(resolve=>{complete=resolve})}
 digitalRuntimeApi.runDetail=async id=>{attempts++;if(attempts===1)throw new Error('详情暂时不可用');return {id,status:'silent',summary:'恢复成功',created_at:'2026-11-14T01:00:00Z'}}
 try{
  await act(async()=>root.render(<MemoryRouter><I18nProvider><DigitalPersonActivity/></I18nProvider></MemoryRouter>))
  assert.equal(element.querySelector('[aria-busy]')?.getAttribute('aria-busy'),'true')
  await act(async()=>{window.dispatchEvent(new window.Event('workstep:digital-person-activity-changed'));window.dispatchEvent(new window.Event('workstep:digital-person-activity-changed'))})
  assert.equal(calls,1)
  await act(async()=>complete({checking:false,run_total:1,delegation_total:0,delegations:[],runs:[{id:'one',status:'silent',summary:'预览',created_at:'2026-11-14T01:00:00Z'}]}))
  await act(async()=>element.querySelector<HTMLButtonElement>('[aria-expanded]')!.click())
  assert.match(element.textContent!,/详情暂时不可用/)
  await act(async()=>element.querySelector<HTMLButtonElement>('.digital-person-run-detail button')!.click())
  assert.equal(attempts,2);assert.match(element.textContent!,/恢复成功/)
 }finally{await act(async()=>root.unmount());element.remove();Object.assign(digitalRuntimeApi,originals);await window.happyDOM.close()}
})

test('notification and thought pages change independently and notification failure retries',async()=>{
 const {window}=installDomEnvironment();const element=document.body.appendChild(document.createElement('div')),root=createRoot(element)
 const originals={...digitalRuntimeApi};const calls:number[][]=[];let retried=''
 digitalRuntimeApi.records=async(runOffset=0,delegationOffset=0)=>{
  calls.push([runOffset,delegationOffset])
  return {checking:false,run_total:7,delegation_total:7,delegations:[{id:'d'+delegationOffset,project_id:'p',session_id:'s',instruction:'委派内容',status:'completed',notification_state:'delivery_failed',notification_run_id:'delivery'}],runs:[{id:'r'+runOffset,status:'silent',summary:'思考摘要',created_at:'2026-11-14T00:00:00Z'}]}
 }
 digitalRuntimeApi.retryDelivery=async id=>{retried=id;return {}}
 try{
  await act(async()=>root.render(<MemoryRouter><I18nProvider><DigitalPersonActivity/></I18nProvider></MemoryRouter>))
  assert.equal(element.querySelector('[data-kind=delegations] .status-badge')?.textContent,'未通知')
  await act(async()=>element.querySelector<HTMLButtonElement>('[data-kind=delegations] [data-next-page]')!.click())
  assert.deepEqual(calls.at(-1),[0,5])
  await act(async()=>element.querySelector<HTMLButtonElement>('[data-kind=runs] [data-next-page]')!.click())
  assert.deepEqual(calls.at(-1),[5,5])
  await act(async()=>element.querySelector<HTMLButtonElement>('[data-kind=delegations] [data-retry-delivery]')!.click())
  assert.equal(retried,'delivery')
 }finally{await act(async()=>root.unmount());element.remove();Object.assign(digitalRuntimeApi,originals);await window.happyDOM.close()}
})

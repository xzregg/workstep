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
 const render=(active:boolean)=>root.render(<I18nProvider><DigitalPersonHomeInsights active={active} name="小研" state="idle" activity={null} affect={null} messages={[]} chatShown={false} onInspect={()=>{}}/></I18nProvider>)
 try{
  await act(async()=>render(true));assert.equal(calls,1)
  assert.match(host.querySelector('.digital-home-affinity')!.textContent!,/—/)
  await act(async()=>{window.dispatchEvent(new window.Event(DIGITAL_ACTIVITY_CHANGED));window.dispatchEvent(new window.Event(DIGITAL_ACTIVITY_CHANGED))});assert.equal(calls,1)
  await act(async()=>resolve({checking:false,reflection_count:777,reflection_count_lower_bound:true,run_total:48,delegation_total:0,runs:[],delegations:[]}))
  assert.match(host.querySelector('.digital-home-presence-info')!.textContent!,/777\+/)
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
  await act(async()=>root.render(<MemoryRouter><I18nProvider><DigitalPersonHomeInsights active name="小研" state="idle" activity={{level:3,experience:20,next_level_experience:100} as any} affect={{name:'会话作者',person_id:'p',affinity:68,emotion:'calm',valence:0,arousal:0,updated_at:null,history:[]}} messages={[]} chatShown={false} onInspect={()=>{}}/></I18nProvider></MemoryRouter>))
  const identity=host.querySelector<HTMLButtonElement>('.digital-home-identity')!;identity.focus()
  await act(async()=>identity.click());assert.match(document.querySelector('[role="dialog"]')!.textContent!,/小研/)
  assert.match(document.querySelector('[role="dialog"]')!.textContent!,/Lv.3/)
  await act(async()=>document.querySelector<HTMLButtonElement>('.digital-home-detail-close')!.click());assert.equal(document.activeElement,identity)
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-affinity')!.click());assert.match(document.querySelector('[role="dialog"]')!.textContent!,/68/)
  await act(async()=>document.querySelector<HTMLButtonElement>('.digital-home-detail-close')!.click())
  await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="主动思考"]')!.click());assert.match(document.querySelector('[role="dialog"]')!.textContent!,/今天的思考记录/);assert.doesNotMatch(document.querySelector('[role="dialog"]')!.textContent!,/已保留.*条记录/);assert.equal(Boolean(document.querySelector('.digital-home-detail-pages strong')),false);assert.ok(document.querySelector('.digital-home-detail-panel>footer .digital-home-detail-pages'))
  assert.equal(settings,0)
 }finally{await act(async()=>root.unmount());digitalRuntimeApi.records=original;await window.happyDOM.close()}
})


test('proactive activity replaces duplicate chat messages with real reflection and delegation records',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host),original=digitalRuntimeApi.records
 digitalRuntimeApi.records=async()=>({checking:false,run_total:1,delegation_total:1,runs:[{id:'r1',summary:'复盘今日安排',status:'completed',outcome:{sent:1,failed:1,affinity_increased:2,affinity_decreased:1,message_preview:'早上好，入口我记住了。'},created_at:'2026-11-17T01:00:00Z'}],delegations:[{id:'work',project_id:'p',session_id:'s',instruction:'整理工作安排',status:'running',created_at:'2026-11-17T01:00:00Z'}]})
 try{
  await act(async()=>root.render(<I18nProvider><DigitalPersonHomeInsights active name="小研" state="idle" activity={null} affect={null} messages={[{id:'u',role:'user',content:'现在呢',status:'succeeded'}]} chatShown={false} onInspect={()=>{}}/></I18nProvider>))
  const context=host.querySelector('.digital-home-context')!
  assert.match(context.textContent!,/主动动态/)
  assert.match(context.textContent!,/复盘今日安排/)
  assert.match(context.textContent!,/已发送 1 条消息/)
  assert.match(context.textContent!,/早上好，入口我记住了。/)
  assert.match(context.textContent!,/发送失败 1 条/)
  assert.match(context.textContent!,/好感度 \+2/)
  assert.match(context.textContent!,/好感度 −1/)
  assert.match(context.textContent!,/整理工作安排/)
  assert.doesNotMatch(context.textContent!,/现在呢|最近消息/)
  assert.equal(Boolean(context.querySelector('.digital-home-work button,.digital-home-work a')),false)
  assert.equal(context.querySelectorAll('time').length,2)
  assert.equal(host.querySelector('.digital-home-work time')!.getAttribute('dateTime'),'2026-11-17T01:00:00Z')
  await act(async()=>root.render(<I18nProvider><DigitalPersonHomeInsights active={false} name="小研" state="idle" activity={null} affect={null} messages={[]} chatShown onInspect={()=>{}}/></I18nProvider>))
  assert.equal(host.querySelector<HTMLElement>('.digital-home-context')!.hidden,true)
 }finally{await act(async()=>root.unmount());digitalRuntimeApi.records=original;await window.happyDOM.close()}
})


test('thought and delegation regions load only their next page on scroll and coalesce pending requests',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host),original=digitalRuntimeApi.records
 const calls:number[][]=[]
 let resolve:((data:DigitalActivityRecords)=>void)|undefined
 const page=(offset:number):DigitalActivityRecords=>({checking:false,run_total:12,delegation_total:12,runs:Array.from({length:5},(_,i)=>({id:`r${offset+i}`,status:'silent',summary:`思考${offset+i}`,created_at:'2026-11-17T01:00:00Z'})),delegations:Array.from({length:5},(_,i)=>({id:`d${offset+i}`,status:'completed',instruction:`委派${offset+i}`,project_id:'p',session_id:'s'}))})
 digitalRuntimeApi.records=async(r=0,d=0)=>{calls.push([r,d]);if(!r&&!d)return page(0);return new Promise(done=>{resolve=done})}
 try{
  await act(async()=>root.render(<I18nProvider><DigitalPersonHomeInsights active name="小研" state="idle" activity={null} affect={null} messages={[]} chatShown={false} onInspect={()=>{}}/></I18nProvider>))
  assert.deepEqual(calls,[[0,0]])
  const thoughts=host.querySelector<HTMLElement>('[data-activity-scroll="runs"]')!,tasks=host.querySelector<HTMLElement>('[data-activity-scroll="delegations"]')!
  assert.ok(thoughts);assert.ok(tasks)
  assert.equal(thoughts.querySelectorAll('button').length,5)
  await act(async()=>{thoughts.dispatchEvent(new window.Event('scroll'));thoughts.dispatchEvent(new window.Event('scroll'))})
  assert.deepEqual(calls,[[0,0],[5,0]])
  await act(async()=>resolve!(page(5)))
  assert.equal(thoughts.querySelectorAll('button').length,10)
  assert.equal(tasks.querySelectorAll('.digital-home-work-summary').length,5)
  await act(async()=>tasks.dispatchEvent(new window.Event('scroll')))
  assert.deepEqual(calls,[[0,0],[5,0],[0,5]])
  await act(async()=>resolve!(page(5)))
  assert.equal(tasks.querySelectorAll('.digital-home-work-summary').length,10)
  digitalRuntimeApi.records=async()=>({...page(0),runs:[{id:'new',status:'silent',summary:'新的思考',created_at:'2026-11-17T02:00:00Z'},...page(0).runs.slice(0,4)]})
  await act(async()=>window.dispatchEvent(new window.Event(DIGITAL_ACTIVITY_CHANGED)))
  assert.equal(thoughts.querySelectorAll('.digital-home-thought-event').length,11)
  assert.match(thoughts.textContent!,/思考4/,'refresh preserves the previous first-page boundary')

 }finally{await act(async()=>root.unmount());digitalRuntimeApi.records=original;await window.happyDOM.close()}
})

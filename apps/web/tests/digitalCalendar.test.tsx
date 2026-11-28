import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {I18nProvider} from '../src/i18n'
import DigitalPersonCalendar from '../src/components/digital-person/DigitalPersonCalendar'
import {digitalCalendarApi,type CalendarEvent} from '../src/api/digitalCalendar'

for(const presentation of ['home','panel'] as const)test(`${presentation}: occupied dates show schedules; add action and empty dates open creation`,async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 window.happyDOM.setWindowSize({width:presentation==='home'?1440:390,height:900})
 const globals={SVGElement:globalThis.SVGElement,ResizeObserver:globalThis.ResizeObserver,history:globalThis.history}
 Object.assign(globalThis,{SVGElement:window.SVGElement,ResizeObserver:window.ResizeObserver,history:window.history})
 const old={...digitalCalendarApi},today=new Date()
 digitalCalendarApi.list=async()=>({items:[{id:'existing',revision:'one',system_readonly:true,content:'**已有安排**',starts_at:today.toISOString(),timezone_name:'Asia/Shanghai',reminder_minutes:0,reminder_status:'pending',reminder_at:today.toISOString(),created_at:'',updated_at:''}],has_more:false,now:today.toISOString()})
 try{
  await act(async()=>root.render(<I18nProvider><DigitalPersonCalendar active projectId="p" canEdit presentation={presentation}/></I18nProvider>))
  await act(async()=>host.querySelector<HTMLButtonElement>('[data-today=true]')!.click())
  assert.equal(Boolean(document.querySelector('[role=dialog][aria-label="新增日程"]')),false)
  const view=document.querySelector<HTMLElement>('[role=dialog]:has(.digital-calendar-day-dialog)')!
  assert.equal(Boolean(view),true,'clicking an occupied date opens a separate schedule dialog')
  assert.match(view.textContent!,/已有安排/)
  assert.doesNotMatch(view.querySelector('time')!.textContent!,/–/,'read-only system events without a known duration keep their original display')
  await act(async()=>[...view.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='新增日程')!.click())
  assert.equal(Boolean(document.querySelector('[role=dialog][aria-label="新增日程"]')),true)
  await act(async()=>document.querySelector<HTMLElement>('.digital-calendar-editor-backdrop')!.click())
  await act(async()=>host.querySelector<HTMLButtonElement>('[data-has-events=false]')!.click())
  assert.equal(Boolean(document.querySelector('[role=dialog][aria-label="新增日程"]')),true)
 }finally{await act(async()=>root.unmount());Object.assign(digitalCalendarApi,old);Object.assign(globalThis,globals);await window.happyDOM.close()}
})

test('calendar opens a name-free Markdown editor; blank outside closes, filled outside preserves, save failures retain content',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 window.happyDOM.setWindowSize({width:1440,height:1000})
 const oldSvg=globalThis.SVGElement,oldResize=globalThis.ResizeObserver
 Object.assign(globalThis,{SVGElement:window.SVGElement,ResizeObserver:window.ResizeObserver})
 const saved={...digitalCalendarApi},events:CalendarEvent[]=[]
 let fail=true
 digitalCalendarApi.list=async()=>({items:events,has_more:false,now:new Date().toISOString()})
 digitalCalendarApi.create=async draft=>{if(fail)throw new Error('模拟保存失败，请重试');const row={...draft,id:'new',revision:'r1',created_at:'',updated_at:'',reminder_at:draft.starts_at,reminder_status:'pending' as const};events.push(row);return row}
 try{
  await act(async()=>root.render(<I18nProvider><DigitalPersonCalendar active projectId="p" canEdit/></I18nProvider>))
  const date=()=>host.querySelector<HTMLButtonElement>('.digital-calendar-day[data-today="true"]')!
  await act(async()=>date().click())
  assert.ok(document.querySelector('[aria-label="新增日程"]')!==null)
  assert.equal(document.querySelector('[name="title"]')!==null,false)
  await act(async()=>document.querySelector<HTMLElement>('.digital-calendar-editor-backdrop')!.click())
  assert.ok(document.querySelector('.digital-calendar-editor')===null)
  await act(async()=>date().click())
  const input=()=>document.querySelector<HTMLTextAreaElement>('[aria-label="日程内容"]')!
  assert.equal(document.querySelector('#calendar-target')!==null,false,'schedule editor has no destination selector')
  await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!.call(input(),'**方案评审**');input().dispatchEvent(new window.Event('input',{bubbles:true}))})
  await act(async()=>document.querySelector<HTMLElement>('.digital-calendar-editor-backdrop')!.click())
  assert.equal(input().value,'**方案评审**')
  await act(async()=>document.querySelector<HTMLFormElement>('.digital-calendar-editor form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})))
  assert.match(document.querySelector('[role="alert"]')!.textContent!,/保存失败/)
  assert.equal(input().value,'**方案评审**')
  fail=false
  await act(async()=>document.querySelector<HTMLFormElement>('.digital-calendar-editor form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})))
  assert.ok(document.querySelector('.digital-calendar-editor')===null)
  assert.equal(events[0].content,'**方案评审**')
  assert.ok(host.querySelector('.digital-calendar-day[data-has-events="true"]')!==null)
 }finally{await act(async()=>root.unmount());Object.assign(digitalCalendarApi,saved);Object.assign(globalThis,{SVGElement:oldSvg,ResizeObserver:oldResize});await window.happyDOM.close()}
})


for(const destination of ['new','internal','system'] as const)test(`editor restores and submits the full interval: ${destination}`,async()=>{
 const {default:DigitalCalendarEditor}=await import('../src/components/digital-person/DigitalCalendarEditor')
 const {nativeCalendarApi}=await import('../src/api/nativeCalendar')
 const {useNativeCalendarStore}=await import('../src/stores/nativeCalendarStore')
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 window.happyDOM.setWindowSize({width:1440,height:900})
 const globals={SVGElement:globalThis.SVGElement,ResizeObserver:globalThis.ResizeObserver}
 Object.assign(globalThis,{SVGElement:window.SVGElement,ResizeObserver:window.ResizeObserver})
 const oldApi={...digitalCalendarApi},oldNative={...nativeCalendarApi},oldStore=useNativeCalendarStore.getState()
 useNativeCalendarStore.setState({syncEnabled:false,owner:'test',defaultTarget:'internal'})
 const date=new Date(2030,0,1,23,45),duration=destination==='new'?30:95
 const event:CalendarEvent={id:'range',revision:'r1',content:'跨日安排',starts_at:date.toISOString(),duration_minutes:duration,timezone_name:'Asia/Shanghai',reminder_minutes:0,reminder_at:date.toISOString(),reminder_status:'pending',created_at:'',updated_at:'',target_id:destination==='system'?'device':'internal'}
 let submitted:Record<string,unknown>|undefined,saved=0
 nativeCalendarApi.targets=async()=>({owner:'test',items:[]})
 digitalCalendarApi.create=async draft=>{submitted=draft;return event}
 digitalCalendarApi.update=async (_id,draft)=>{submitted=draft;return event}
 nativeCalendarApi.submit=async body=>{submitted=body;return {id:'op',plan_id:'plan',action:'update',target_id:'device',device_id:'phone',status:'queued',items:[],cancel_requested:false}}
 try{
  await act(async()=>root.render(<I18nProvider><DigitalCalendarEditor date={date} event={destination==='new'?undefined:event} projectId="test" onClose={()=>{}} onSaved={()=>saved++}/></I18nProvider>))
  const start=document.querySelector<HTMLInputElement>('[aria-label="开始时间"]')!,end=document.querySelector<HTMLInputElement>('[aria-label="结束时间"]')!
  const expected=new Date(date.getTime()+duration*60000)
  assert.match(start.value,/2030-01-01 23:45/)
  assert.equal(end.value,`2030-01-02 ${String(expected.getHours()).padStart(2,'0')}:${String(expected.getMinutes()).padStart(2,'0')}`)
  if(destination==='new')await act(async()=>{
   const input=document.querySelector<HTMLTextAreaElement>('[aria-label="日程内容"]')!
   Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!.call(input,'跨日安排')
   input.dispatchEvent(new window.Event('input',{bubbles:true}))
  })
  await act(async()=>document.querySelector<HTMLFormElement>('.digital-calendar-editor form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})))
  assert.equal(saved,1)
  assert.equal(submitted?.duration_minutes,duration)
  const draft=destination==='system'?submitted?.draft as Record<string,unknown>:submitted
  assert.equal(draft?.starts_at,date.toISOString())
  assert.equal(draft?.duration_minutes,duration)
 }finally{
  await act(async()=>root.unmount());Object.assign(digitalCalendarApi,oldApi);Object.assign(nativeCalendarApi,oldNative)
  useNativeCalendarStore.setState(oldStore);Object.assign(globalThis,globals);await window.happyDOM.close()
 }
})

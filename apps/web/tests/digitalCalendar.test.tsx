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
 digitalCalendarApi.list=async()=>({items:[{id:'existing',revision:'one',content:'**已有安排**',starts_at:today.toISOString(),timezone_name:'Asia/Shanghai',reminder_minutes:0,reminder_status:'pending',reminder_at:today.toISOString(),created_at:'',updated_at:''}],has_more:false,now:today.toISOString()})
 try{
  await act(async()=>root.render(<I18nProvider><DigitalPersonCalendar active projectId="p" canEdit presentation={presentation}/></I18nProvider>))
  await act(async()=>host.querySelector<HTMLButtonElement>('[data-today=true]')!.click())
  assert.equal(Boolean(document.querySelector('[role=dialog][aria-label="新增日程"]')),false)
  const view=document.querySelector<HTMLElement>('[role=dialog]:has(.digital-calendar-day-dialog)')!
  assert.equal(Boolean(view),true,'clicking an occupied date opens a separate schedule dialog')
  assert.match(view.textContent!,/已有安排/)
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

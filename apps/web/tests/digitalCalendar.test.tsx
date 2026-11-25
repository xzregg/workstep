import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {I18nProvider} from '../src/i18n'
import DigitalPersonCalendar from '../src/components/digital-person/DigitalPersonCalendar'
import {digitalCalendarApi,type CalendarEvent} from '../src/api/digitalCalendar'

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

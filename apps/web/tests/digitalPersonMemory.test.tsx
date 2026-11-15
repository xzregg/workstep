import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import { digitalMemoryApi, type MemoryViewItem } from '../src/api/digitalPerson'
import DigitalPersonMemory from '../src/components/digital-person/DigitalPersonMemory'

const source={id:'memory:1',project_id:'p',project_name:'演示项目',source_time:'2026-11-12T10:00:00Z',source_kind:'chat' as const,role:'user'}
const rows:MemoryViewItem[]=[{id:'knowledge:1',summary:'只通知最终结果',kind:'preference',outcome:'stated',state:'active',interpretation:true,time:source.source_time,time_is_source:true,entities:[{kind:'person',name:'小舟',aliases:[]}],relations:[],sources:[source]},
{id:'memory:2',summary:'校验失败记录',kind:'event',outcome:'unknown',state:'source',interpretation:false,time:'2026-11-13T10:00:00Z',time_is_source:true,entities:[],relations:[],sources:[{...source,id:'memory:2',source_kind:'task'}]}]

test('real memory categories, timeline and original-source pagination',async()=>{
 const {window}=installDomEnvironment(),original={...digitalMemoryApi};let calls=0;const reads:number[]=[]
 digitalMemoryApi.browse=async()=>{calls++;return {items:rows,bounded:true}}
 digitalMemoryApi.read=async(id,offset=0)=>{reads.push(offset);return {id,content:offset?'后续原文':'原始依据',source_hash:'h',offset,next_offset:offset?null:4,has_more:!offset,total_chars:8,created_at:source.source_time,project_id:'p'}}
 const container=document.body.appendChild(document.createElement('div')),root=createRoot(container)
 try{
  await act(async()=>root.render(<I18nProvider><DigitalPersonMemory name="小舟" avatar="robot"/></I18nProvider>))
  assert.equal(calls,1);assert.equal(container.querySelectorAll('.digital-memory-node').length,2)
  assert.equal(container.querySelector('.digital-memory-collection'),null)
  assert.equal(container.querySelectorAll('.digital-memory-card').length,0,'brain view does not repeat every record below the diagram')
  assert.doesNotMatch(container.textContent!,/示例数据|本轮唤起|夜巡归档/)
  await act(async()=>container.querySelector<HTMLButtonElement>('[data-memory-kind="preference"]')!.click())
  assert.equal(container.querySelectorAll('.digital-memory-node').length,1);assert.equal(calls,1)
  await act(async()=>container.querySelector<HTMLButtonElement>('.digital-memory-node')!.click())
  assert.match(container.querySelector('.digital-memory-detail')!.textContent!,/演示项目/)
  assert.equal(reads.length,0,'originals are read only when opened')
  await act(async()=>container.querySelector<HTMLButtonElement>('[data-memory-source]')!.click())
  assert.match(document.querySelector('[role="dialog"]')!.textContent!,/原始依据/)
  await act(async()=>document.querySelector<HTMLButtonElement>('[data-memory-next]')!.click())
  assert.deepEqual(reads,[0,4]);assert.match(document.querySelector('[role="dialog"]')!.textContent!,/后续原文/)
  await act(async()=>document.querySelector<HTMLButtonElement>('[data-memory-close]')!.click())
  await act(async()=>container.querySelector<HTMLButtonElement>('[data-memory-mode="timeline"]')!.click())
  assert.ok(container.querySelector('.digital-memory-timeline'))
  assert.equal(container.querySelectorAll('.digital-memory-timeline .digital-memory-card').length,1)
 }finally{await act(async()=>root.unmount());Object.assign(digitalMemoryApi,original);container.remove();await window.happyDOM.close()}
})
test('failed memory request can recover without showing mock records',async()=>{
 const {window}=installDomEnvironment(),original=digitalMemoryApi.browse;let fail=true
 digitalMemoryApi.browse=async()=>{if(fail)throw Error('offline');return {items:[],bounded:true}}
 const container=document.body.appendChild(document.createElement('div')),root=createRoot(container)
 try{
 await act(async()=>root.render(<I18nProvider><DigitalPersonMemory name="小舟" avatar="robot"/></I18nProvider>))
 assert.ok(container.querySelector('[role="alert"]'));assert.equal(container.querySelector('[data-memory-empty]'),null)
 fail=false;await act(async()=>container.querySelector<HTMLButtonElement>('[data-memory-refresh]')!.click())
 assert.equal(container.querySelector('[role="alert"]'),null);assert.ok(container.querySelector('[data-memory-empty]'))
 }finally{await act(async()=>root.unmount());digitalMemoryApi.browse=original;container.remove();await window.happyDOM.close()}
})

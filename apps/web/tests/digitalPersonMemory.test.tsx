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

test('memory requests omit an unselected project so the Gateway accepts the default and category views',async()=>{
 const {window}=installDomEnvironment()
 const original=globalThis.fetch
 const queries:Record<string,string>[]=[]
 globalThis.fetch=async input=>{
  const params=new URL(String(input),'https://workstep.invalid').searchParams
  queries.push(Object.fromEntries(params))
  if(params.get('project_id')==='')return Response.json({detail:'Ambiguous project scope'},{status:403})
  return Response.json({items:rows,bounded:true,has_next:false})
 }
 try{
  await digitalMemoryApi.browse()
  await digitalMemoryApi.browse('',{kind:'preference'})
  await digitalMemoryApi.browse('最终结果',{kind:'preference',projectId:'p',page:2})
  assert.deepEqual(queries,[{}, {kind:'preference'}, {query:'最终结果',kind:'preference',project_id:'p',page:'2'}])
 }finally{globalThis.fetch=original;await window.happyDOM.close()}
})

test('real memory categories, timeline and original-source pagination',async()=>{
 const {window}=installDomEnvironment(),original={...digitalMemoryApi};let calls=0;const reads:number[]=[]
 digitalMemoryApi.browse=async(_query,filters)=>{calls++;return {items:filters?.kind?rows.filter(row=>row.kind===filters.kind):rows,bounded:true}}
 digitalMemoryApi.read=async(id,offset=0)=>{reads.push(offset);return {id,content:offset?'后续原文':'原始依据',source_hash:'h',offset,next_offset:offset?null:4,has_more:!offset,total_chars:8,created_at:source.source_time,project_id:'p'}}
 const container=document.body.appendChild(document.createElement('div')),root=createRoot(container)
 try{
  await act(async()=>root.render(<I18nProvider><DigitalPersonMemory name="小舟" avatar="robot"/></I18nProvider>))
  assert.equal(calls,1);assert.equal(container.querySelectorAll('.digital-memory-node').length,2)
  assert.equal(container.querySelector('.digital-memory-collection'),null)
  assert.equal(container.querySelectorAll('.digital-memory-card').length,0,'brain view does not repeat every record below the diagram')
  assert.ok(container.querySelector('.digital-memory-overview-heading [data-memory-refresh] svg'))
  assert.equal(container.querySelector('.digital-memory-toolbar [data-memory-refresh]'),null)
  const filters=container.querySelector('.digital-memory-toolbar .digital-memory-filters')
  assert.ok(filters,'category filters sit beside the search controls')
  assert.ok(container.querySelector('.digital-memory-search-group input'))
  assert.ok(container.querySelector('.digital-memory-search-group button[type=submit]'))
  assert.equal(filters.previousElementSibling?.className,'digital-memory-search-group')
  assert.doesNotMatch(container.textContent!,/示例数据|本轮唤起|夜巡归档/)
  await act(async()=>container.querySelector<HTMLButtonElement>('[data-memory-kind="preference"]')!.click())
  assert.equal(container.querySelectorAll('.digital-memory-node').length,1);assert.equal(calls,2)
  await act(async()=>container.querySelector<HTMLButtonElement>('.digital-memory-node')!.click())
  assert.match(container.querySelector('.digital-memory-detail')!.textContent!,/演示项目/)
  assert.equal(container.querySelector('.digital-memory-detail-summary')?.textContent,rows[0].summary)
  assert.equal(container.querySelector('.digital-memory-detail-title h2'),null,'detail shows one summary instead of repeating it as a title')
  assert.equal(reads.length,0,'originals are read only when opened')
  await act(async()=>container.querySelector<HTMLButtonElement>('[data-memory-source]')!.click())
  assert.match(document.querySelector('[role="dialog"]')!.textContent!,/原始依据/)
  await act(async()=>document.querySelector<HTMLButtonElement>('[data-memory-next]')!.click())
  assert.deepEqual(reads,[0,4]);assert.match(document.querySelector('[role="dialog"]')!.textContent!,/后续原文/)
  await act(async()=>document.querySelector<HTMLButtonElement>('[data-memory-close]')!.click())
  await act(async()=>container.querySelectorAll<HTMLButtonElement>('.digital-memory-modes button')[1]!.click())
  assert.ok(container.querySelector('.digital-memory-timeline'))
  assert.equal(container.querySelectorAll('.digital-memory-timeline .digital-memory-card').length,1)
 }finally{await act(async()=>root.unmount());Object.assign(digitalMemoryApi,original);container.remove();await window.happyDOM.close()}
})

test('category and project filters fetch beyond the preview and ignore obsolete responses',async()=>{
 const {window}=installDomEnvironment(),original=digitalMemoryApi.browse
 const projects=[{id:'p',name:'演示项目'},{id:'q',name:'旧记录项目'}]
 const calls:unknown[][]=[]
 let finishOld:()=>void=()=>{}
 digitalMemoryApi.browse=async(query,filters)=>{
  calls.push([query,filters?.kind,filters?.projectId,filters?.page])
  if(filters?.kind&&!filters.projectId)await new Promise<void>(resolve=>{finishOld=resolve})
  const items=filters?.projectId==='q'?[{...rows[0],summary:`旧项目偏好 ${filters.page}`}]:[rows[1]]
  return {items,bounded:true,projects,has_next:filters?.projectId==='q'&&filters.page===1}
 }
 const container=document.body.appendChild(document.createElement('div')),root=createRoot(container)
 try{
  await act(async()=>root.render(<I18nProvider><DigitalPersonMemory name="小舟" avatar="robot"/></I18nProvider>))
  assert.equal(container.querySelector('.digital-memory-cluster[data-kind="preference"]'),null)
  await act(async()=>container.querySelector<HTMLButtonElement>('[data-memory-kind="preference"]')!.click())
  const select=container.querySelector('select')!
  assert.deepEqual([...select.options].map(item=>item.value),['','p','q'])
  await act(async()=>{select.value='q';select.dispatchEvent(new window.Event('change',{bubbles:true}))})
  assert.match(container.querySelector('.digital-memory-node')!.textContent!,/旧项目偏好 1/)
  await act(async()=>finishOld())
  assert.match(container.querySelector('.digital-memory-node')!.textContent!,/旧项目偏好 1/)
  await act(async()=>container.querySelector<HTMLButtonElement>('.digital-memory-results-pagination button:last-child')!.click())
  await act(async()=>container.querySelectorAll<HTMLButtonElement>('.digital-memory-modes button')[1]!.click())
  assert.match(container.querySelector('.digital-memory-card')!.textContent!,/旧项目偏好 2/)
  assert.deepEqual(calls,[['','','',1],['','preference','',1],['','preference','q',1],['','preference','q',2]])
 }finally{await act(async()=>root.unmount());digitalMemoryApi.browse=original;container.remove();await window.happyDOM.close()}
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

test('opening assistant evidence shows its prompt first with local timestamps',async()=>{
 const {window}=installDomEnvironment(),original={...digitalMemoryApi}
 const prompt={...source,source_time:'2026-11-21T23:59:59.123456+00:00'}
 const reply={...source,id:'memory:3',role:'assistant',source_time:'2026-11-22T00:16:01.581962+00:00'}
 digitalMemoryApi.browse=async()=>({items:[{...rows[0],sources:[reply]}],bounded:true})
 digitalMemoryApi.read=async(id,offset=0)=>({
  id,offset,content:id===reply.id?'本轮回答':offset?'提问补充':'本轮提问',source_hash:id,
  created_at:(id===reply.id?reply:prompt).source_time,project_id:'p',
  next_offset:id===prompt.id&&!offset?4:null,has_more:id===prompt.id&&!offset,total_chars:id===reply.id?4:8,
  ...(id===reply.id?{companion:prompt}:{}),
 })
 const container=document.body.appendChild(document.createElement('div')),root=createRoot(container)
 try {
  await act(async()=>root.render(<I18nProvider><DigitalPersonMemory name="小舟" avatar="robot"/></I18nProvider>))
  await act(async()=>container.querySelector<HTMLButtonElement>('[data-memory-source]')!.click())
  const dialog=document.querySelector('[role="dialog"]')!
  assert.deepEqual([...dialog.querySelectorAll('blockquote')].map(el=>el.textContent),['本轮提问','本轮回答'])
  assert.equal(dialog.querySelectorAll('time').length,2)
  assert.doesNotMatch(dialog.textContent!,/\.581962|\+00:00/)
  await act(async()=>dialog.querySelector<HTMLButtonElement>('[data-memory-next]')!.click())
  assert.deepEqual([...dialog.querySelectorAll('blockquote')].map(el=>el.textContent),['本轮提问提问补充','本轮回答'])
 }finally{await act(async()=>root.unmount());Object.assign(digitalMemoryApi,original);container.remove();await window.happyDOM.close()}
})


test('library totals stay independent of filtered nodes and graph controls work',async()=>{
 const {window}=installDomEnvironment(),original=digitalMemoryApi.browse
 digitalMemoryApi.browse=async(_query,filters)=>({items:filters?.kind?rows.filter(row=>row.kind===filters.kind):rows,bounded:true,stats:{knowledge_count:1286,indexed_count:18420,processed_count:17800,pending_count:620,today_count:24,latest_knowledge_at:source.source_time,by_kind:{preference:186,experience:324,fact:512,event:264}}})
 const container=document.body.appendChild(document.createElement('div')),root=createRoot(container)
 try{
  await act(async()=>root.render(<I18nProvider><DigitalPersonMemory name="小舟" avatar="robot"/></I18nProvider>))
  assert.match(container.querySelector('[data-memory-stats]')!.textContent!,/1,286/)
  assert.match(container.querySelector('[data-memory-stats]')!.textContent!,/18,420/)
  assert.equal(container.querySelector('progress')!.value,17800)
  await act(async()=>container.querySelector<HTMLButtonElement>('[data-memory-kind="preference"]')!.click())
  assert.match(container.querySelector('[data-memory-stats]')!.textContent!,/1,286/)
  assert.equal(container.querySelectorAll('.digital-memory-node').length,1)
  await act(async()=>container.querySelector<HTMLButtonElement>('[data-memory-zoom="in"]')!.click())
  assert.match(container.querySelector('[data-memory-zoom-value]')!.textContent!,/125%/)
  await act(async()=>container.querySelector<HTMLButtonElement>('[data-memory-fit]')!.click())
  assert.match(container.querySelector('[data-memory-zoom-value]')!.textContent!,/100%/)
 }finally{await act(async()=>root.unmount());digitalMemoryApi.browse=original;container.remove();await window.happyDOM.close()}
})


test('category pagination reveals all loaded knowledge without changing library counts',async()=>{
 const {window}=installDomEnvironment(),original=digitalMemoryApi.browse
 const many=Array.from({length:8},(_,i)=>({...rows[0],id:`knowledge:${i+1}`,summary:`偏好条目 ${i+1}`}))
 digitalMemoryApi.browse=async()=>({items:many,bounded:true})
 const container=document.body.appendChild(document.createElement('div')),root=createRoot(container)
 try{
  await act(async()=>root.render(<I18nProvider><DigitalPersonMemory name="小舟" avatar="robot"/></I18nProvider>))
  assert.equal(container.querySelectorAll('.digital-memory-node').length,3)
  assert.match(container.querySelector('.digital-memory-pagination')!.textContent!,/1 \/ 3/)
  await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="下一组"]')!.click())
  assert.match(container.querySelector('.digital-memory-node')!.textContent!,/偏好条目 4/)
  await act(async()=>container.querySelector<HTMLButtonElement>('.digital-memory-node')!.click())
  assert.match(container.querySelector('.digital-memory-detail-summary')!.textContent!,/偏好条目 4/)
  await act(async()=>container.querySelector<HTMLButtonElement>('[aria-label="下一组"]')!.click())
  assert.equal(container.querySelectorAll('.digital-memory-node').length,2)
  assert.equal(container.querySelector<HTMLButtonElement>('[aria-label="下一组"]')!.disabled,true)
  assert.match(container.querySelector('[data-memory-stats]')!.textContent!,/—/,'missing statistics never fall back to the current result count')
 }finally{await act(async()=>root.unmount());digitalMemoryApi.browse=original;container.remove();await window.happyDOM.close()}
})

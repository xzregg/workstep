import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { OrganizationSyncPanel } from '../src/OrganizationSyncPanel'
const dom = new JSDOM('<html><body></body></html>', { url: 'https://gateway.test/admin/settings' })
Object.assign(globalThis, {window:dom.window, document:dom.window.document, HTMLElement:dom.window.HTMLElement, MutationObserver:dom.window.MutationObserver, Event:dom.window.Event})
Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator})
const {render,screen,fireEvent,waitFor,cleanup}=await import('@testing-library/react')
const original=globalThis.fetch
afterEach(()=>{cleanup();globalThis.fetch=original})

test('only checked departments are submitted and progress is restored and updated', async()=>{
 let payload:unknown; let started=false; let done=0
 globalThis.fetch=async(input,init)=>{
  if(String(input).endsWith('/directory-preview'))return Response.json({departments:[
   {external_id:'1',display_name:'公司',parent_external_id:null},
   {external_id:'2',display_name:'研发',parent_external_id:'1'},
  ],selected_department_ids:[]})
  if(init?.method==='POST'){
   assert.equal(new Headers(init.headers).get('X-CSRF-Token'),'csrf')
   payload=JSON.parse(String(init.body));started=true
   return Response.json({id:'job',status:'fetching',completed:0,total:1,current_department:'研发'})
  }
  return Response.json(started?{id:'job',status:'completed',completed:1,total:1,result:{departments:1,people:2}}:{status:'idle'})
 }
 render(<OrganizationSyncPanel sourceId="source" provider="wecom" csrf="csrf" onClose={()=>{}} onCompleted={()=>done++} />)
 const checkbox=await screen.findByLabelText(/研发/)
 assert.equal((screen.getByRole('button',{name:'同步组织与用户'}) as HTMLButtonElement).disabled,true)
 fireEvent.click(checkbox)
 fireEvent.click(screen.getByRole('button',{name:'同步组织与用户'}))
 await waitFor(()=>assert.deepEqual(payload,{department_ids:['2']}))
 assert.ok(screen.getByRole('progressbar',{name:'部门读取进度'}))
 await screen.findByText(/同步完成：1 个组织、2 位用户/,{},{timeout:3000})
 assert.equal(done,1)
})

test('failed start preserves selected departments for retry',async()=>{
 let calls=0
 globalThis.fetch=async(input,init)=>{
  if(String(input).endsWith('/directory-preview'))return Response.json({departments:[{external_id:'2',display_name:'研发'}],selected_department_ids:['2']})
  if(init?.method==='POST'){calls++;return new Response(null,{status:502})}
  return Response.json({status:'idle'})
 }
 render(<OrganizationSyncPanel sourceId="source" provider="dingtalk" csrf="csrf" onClose={()=>{}} onCompleted={()=>{}} />)
 fireEvent.click(await screen.findByRole('button',{name:'同步组织与用户'}))
 await screen.findByRole('alert')
 assert.equal((screen.getByLabelText(/研发/) as HTMLInputElement).checked,true)
 fireEvent.click(screen.getByRole('button',{name:'同步组织与用户'}))
 await waitFor(()=>assert.equal(calls,2))
})

test('reopening an active job restores its selection and reports a background failure',async()=>{
 let polls=0
 globalThis.fetch=async(input)=>{
  if(String(input).endsWith('/directory-preview'))return Response.json({departments:[{external_id:'2',display_name:'研发'}],selected_department_ids:[]})
  polls++
  return Response.json(polls===1?{id:'job',status:'fetching',department_ids:['2'],completed:0,total:1}:{id:'job',status:'failed',error_code:'interrupted'})
 }
 render(<OrganizationSyncPanel sourceId="source" provider="wecom" csrf="csrf" onClose={()=>{}} onCompleted={()=>{}} />)
 const checkbox=await screen.findByLabelText(/研发/)
 assert.equal((checkbox as HTMLInputElement).checked,true)
 assert.equal((checkbox as HTMLInputElement).disabled,true)
 await screen.findByText(/服务重启或关闭导致同步中断/,{},{timeout:3000})
 await waitFor(()=>assert.equal((checkbox as HTMLInputElement).disabled,false))
})

test('organization selection opens as a dialog and closes without starting sync', async () => {
 let closed = 0
 globalThis.fetch = async input => Response.json(String(input).endsWith('/directory-preview') ? {departments:[],selected_department_ids:[]} : {status:'idle'})
 render(<OrganizationSyncPanel sourceId="source" provider="dingtalk" csrf="csrf" onClose={()=>closed++} onCompleted={()=>{}} />)
 assert.ok(screen.getByRole('dialog',{name:'钉钉 · 选择同步组织'}))
 fireEvent.click(screen.getByRole('button',{name:'取消'}))
 assert.equal(closed,1)
})

test('closing edited organization choices asks before discarding', async () => {
 let closed = 0
 globalThis.fetch = async input => Response.json(String(input).endsWith('/directory-preview') ? {departments:[{external_id:'1',display_name:'研发'}],selected_department_ids:[]} : {status:'idle'})
 render(<OrganizationSyncPanel sourceId="source" provider="dingtalk" csrf="csrf" onClose={()=>closed++} onCompleted={()=>{}} />)
 fireEvent.click(await screen.findByLabelText('研发'))
 fireEvent.click(screen.getByRole('button',{name:'取消'}))
 assert.equal(closed,0)
 assert.ok(screen.getByRole('dialog',{name:'放弃组织选择'}))
 fireEvent.click(screen.getByRole('button',{name:'放弃并关闭'}))
 assert.equal(closed,1)
})

test('sync tree cascades parent selection and submits every descendant including hidden nodes', async () => {
 let payload: unknown
 globalThis.fetch = async (input,init) => {
  if (init?.method === 'POST') { payload=JSON.parse(String(init.body)); return Response.json({status:'queued'}) }
  return Response.json(String(input).endsWith('/directory-preview') ? {departments:[
   {external_id:'1',display_name:'公司'}, {external_id:'2',display_name:'研发',parent_external_id:'1'},
   {external_id:'3',display_name:'前端',parent_external_id:'2'}, {external_id:'4',display_name:'产品',parent_external_id:'1'},
  ],selected_department_ids:[]} : {status:'idle'})
 }
 render(<OrganizationSyncPanel sourceId="source" provider="dingtalk" csrf="csrf" onClose={()=>{}} onCompleted={()=>{}} />)
 const parent=await screen.findByLabelText('研发') as HTMLInputElement
 assert.ok(screen.getByRole('tree',{name:'同步组织'}))
 fireEvent.click(parent)
 assert.equal((screen.getByLabelText('前端') as HTMLInputElement).checked,true)
 assert.equal((screen.getByLabelText('公司') as HTMLInputElement).indeterminate,true)
 fireEvent.click(parent)
 assert.equal((screen.getByLabelText('前端') as HTMLInputElement).checked,false)
 fireEvent.change(screen.getByLabelText('搜索组织'),{target:{value:'研发'}})
 fireEvent.click(screen.getByRole('button',{name:'勾选搜索结果'}))
 fireEvent.click(screen.getByRole('button',{name:'同步组织与用户'}))
 await waitFor(()=>assert.deepEqual(payload,{department_ids:['2','3']}))
})


test('completed sync reports additions and locally deleted skips',async()=>{
 globalThis.fetch=async input=>Response.json(String(input).endsWith('/directory-preview')?{departments:[],selected_department_ids:[]}:{status:'completed',result:{departments:9,people:59,departments_added:0,people_added:1,departments_deleted_skipped:9,people_deleted_skipped:58}})
 render(<OrganizationSyncPanel sourceId="source" provider="dingtalk" csrf="csrf" onClose={()=>{}} onCompleted={()=>{}} />)
 await screen.findByText(/跳过本地已删除：9 个组织、58 位用户/)
})

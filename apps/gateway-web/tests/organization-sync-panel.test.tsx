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

test('first sync defaults to whole company and check changes refreshes while viewing all stays cached',async()=>{
 const payloads:Record<string,unknown>[]=[]
 let reads=0
 globalThis.fetch=async(input,init)=>{
  if(init?.method==='POST'){
   payloads.push(JSON.parse(String(init.body)));reads++
   return Response.json({id:'preview'+reads,status:'preview',department_ids:['1','2','3'],departments:[
    {external_id:'1',display_name:'公司'},{external_id:'2',display_name:'研发',parent_external_id:'1'},
    {external_id:'3',display_name:'新增部门',parent_external_id:'1'}],result:{user_candidates:[
     {subject:'old',display_name:'原有用户',department_ids:['2'],changed:false,skipped:false,excluded:false,kind:'unchanged',after:{name:'原有用户',active:true,departments:['2']}},
     {subject:'new',display_name:'新增用户',department_ids:['3'],changed:true,skipped:false,excluded:false,kind:'new',after:{name:'新增用户',active:true,departments:['3']}},
    ]}})
  }
  return Response.json(String(input).endsWith('/directory-preview')?{departments:[{external_id:'1',display_name:'公司'},{external_id:'2',display_name:'研发',parent_external_id:'1'}],selected_department_ids:[],maintenance_policy:null,is_initialized:false}:{status:'idle'})
 }
 render(<OrganizationSyncPanel sourceId="source" provider="dingtalk" csrf="csrf" onClose={()=>{}} onCompleted={()=>{}}/>)
 await screen.findByLabelText('维护范围')
 assert.equal((screen.getByLabelText('维护范围') as HTMLSelectElement).value,'all')
 assert.equal((screen.getByLabelText('研发') as HTMLInputElement).checked,true)
 fireEvent.click(screen.getByRole('button',{name:'读取通讯录'}))
 await screen.findByLabelText('同步新增用户')
 await waitFor(()=>assert.equal((screen.getByLabelText('同步新增用户') as HTMLInputElement).checked,true))
 assert.equal((screen.getByLabelText('新增部门') as HTMLInputElement).checked,true)
 assert.equal(screen.queryByLabelText('同步原有用户'),null)
 fireEvent.click(screen.getByRole('button',{name:'查看全部'}))
 assert.ok(screen.getByLabelText('同步原有用户'))
 assert.equal(payloads.length,1)
 fireEvent.click(screen.getByRole('button',{name:'检查变更'}))
 await waitFor(()=>assert.equal(payloads.length,2))
 assert.equal(payloads[1].refresh,true)
 await waitFor(()=>assert.equal((screen.getByLabelText('本次只同步组织结构') as HTMLInputElement).disabled,false))
 fireEvent.click(screen.getByLabelText('本次只同步组织结构'))
 assert.equal((screen.getByLabelText('同步新增用户') as HTMLInputElement).disabled,true)
 fireEvent.click(screen.getByRole('button',{name:'勾选搜索结果'}))
 fireEvent.click(screen.getByRole('button',{name:'同步 0 位用户 · 应用组织变更'}))
 await waitFor(()=>assert.equal(payloads.length,3))
 assert.equal(payloads[2].groups_only,true)
 assert.deepEqual(payloads[2].selected_subjects,[])
})

test('clearing user choices and picking one employee saves an identity whitelist and only required groups',async()=>{
 let confirmed:Record<string,unknown>|undefined
 globalThis.fetch=async(input,init)=>{
  if(String(input).endsWith('/confirm')){confirmed=JSON.parse(String(init?.body));return Response.json({status:'queued'})}
  if(init?.method==='POST')return Response.json({id:'preview',status:'preview',department_ids:['1','2','3'],result:{user_candidates:
   ['a','b','sales'].map(id=>({subject:id,display_name:id,department_ids:[id==='sales'?'3':'2'],changed:true,skipped:false,excluded:false,kind:'new',after:{name:id,active:true,departments:[id==='sales'?'3':'2']}}))}})
  return Response.json(String(input).endsWith('/directory-preview')?{departments:[{external_id:'1',display_name:'公司'},
   {external_id:'2',display_name:'研发',parent_external_id:'1'},{external_id:'3',display_name:'销售',parent_external_id:'1'}],is_initialized:false,selected_department_ids:[],maintenance_policy:null}:{status:'idle'})
 }
 render(<OrganizationSyncPanel sourceId="source" provider="dingtalk" csrf="csrf" onClose={()=>{}} onCompleted={()=>{}}/>)
 fireEvent.click(await screen.findByRole('button',{name:'查看研发用户'}))
 await screen.findByLabelText('同步a')
 await waitFor(()=>assert.equal((screen.getByRole('button',{name:'清空用户选择'}) as HTMLButtonElement).disabled,false))
 fireEvent.click(screen.getByRole('button',{name:'清空用户选择'}))
 fireEvent.click(screen.getByLabelText('同步a'))
 assert.equal((screen.getByLabelText('维护范围') as HTMLSelectElement).value,'users')
 assert.equal((screen.getByLabelText('同步b') as HTMLInputElement).checked,false)
 fireEvent.click(screen.getByRole('button',{name:'同步 1 位用户 · 应用组织变更'}))
 await waitFor(()=>assert.deepEqual(confirmed?.maintenance_policy,{mode:'users',department_ids:[],subjects:['a'],excluded_subjects:[]}))
 assert.deepEqual(confirmed?.department_ids,['2','1'])
})

test('saved user maintenance selects only named identities and makes departed users reviewable',async()=>{
 globalThis.fetch=async input=>Response.json(String(input).endsWith('/directory-preview')?{
  departments:[{external_id:'2',display_name:'研发'}],selected_department_ids:[],is_initialized:true,
  maintenance_policy:{mode:'users',department_ids:[],subjects:['chosen'],excluded_subjects:[]},
 }:{id:'preview',status:'preview',department_ids:['2'],result:{user_candidates:[
  {subject:'chosen',display_name:'离职用户',department_ids:['2'],changed:true,skipped:false,excluded:false,kind:'source_deleted',before:{name:'离职用户',active:true,departments:['2']},after:{name:'离职用户',active:false,departments:['2']}},
  {subject:'new',display_name:'不应自动加入',department_ids:['2'],changed:true,skipped:false,excluded:false,kind:'new',after:{name:'不应自动加入',active:true,departments:['2']}},
 ]}})
 render(<OrganizationSyncPanel sourceId="source" provider="dingtalk" csrf="csrf" onClose={()=>{}} onCompleted={()=>{}}/>)
 const chosen=await screen.findByLabelText('同步离职用户') as HTMLInputElement
 await waitFor(()=>assert.equal(chosen.checked,true))
 assert.equal((screen.getByLabelText('维护范围') as HTMLSelectElement).value,'users')
 assert.equal((screen.getByLabelText('同步不应自动加入') as HTMLInputElement).checked,false)
 assert.ok(screen.getByText('源端已删除；同步后停用本地账号，保留历史'))
 assert.equal((screen.getByRole('button',{name:'同步 1 位用户 · 应用组织变更'}) as HTMLButtonElement).disabled,false)
})

test('one full preview serves every department and checkbox changes stay local',async()=>{
 const writes:{url:string;payload:unknown}[]=[]
 const users=['1','2'].map(id=>({subject:'u'+id,display_name:'员工'+id,department_ids:[id],changed:true,skipped:false,excluded:false,kind:'new',after:{name:'员工'+id,active:true,departments:[id]}}))
 globalThis.fetch=async(input,init)=>{
  if(init?.method==='POST'){
   writes.push({url:String(input),payload:JSON.parse(String(init.body))})
   return Response.json(String(input).endsWith('/confirm')?{status:'queued'}:{id:'all',status:'preview',department_ids:['1','2'],result:{user_candidates:users}})
  }
  return Response.json(String(input).endsWith('/directory-preview')?{departments:[{external_id:'1',display_name:'研发'},{external_id:'2',display_name:'销售'}],selected_department_ids:[]}:{status:'idle'})
 }
 render(<OrganizationSyncPanel sourceId="source" provider="dingtalk" csrf="csrf" onClose={()=>{}} onCompleted={()=>{}}/>)
 fireEvent.click(await screen.findByRole('button',{name:'查看研发用户'}))
 await screen.findByLabelText('同步员工1')
 assert.equal((screen.getByLabelText('同步员工1') as HTMLInputElement).checked,false)
 assert.deepEqual(writes[0].payload,{department_ids:['1','2'],selection_department_ids:[],preview:true,full_directory:true})
 fireEvent.click(screen.getByRole('button',{name:'查看销售用户'}))
 fireEvent.click(screen.getByLabelText('同步员工2'))
 assert.equal((screen.getByLabelText('销售') as HTMLInputElement).checked,true)
 fireEvent.click(screen.getByLabelText('销售'))
 assert.equal((screen.getByLabelText('同步员工2') as HTMLInputElement).checked,false)
 fireEvent.click(screen.getByLabelText('研发'))
 fireEvent.click(screen.getByRole('button',{name:'查看研发用户'}))
 assert.equal((screen.getByLabelText('同步员工1') as HTMLInputElement).checked,true)
 assert.equal(writes.length,1)
 fireEvent.click(screen.getByRole('button',{name:'同步 1 位用户 · 应用组织变更'}))
 await waitFor(()=>assert.deepEqual(writes[1].payload,{job_id:'all',department_ids:['1'],selected_subjects:['u1'],maintenance_policy:{mode:'departments',department_ids:['1'],subjects:[],excluded_subjects:[]}}))
})

test('viewing department users reads a preview once and filters descendants without applying changes', async()=>{
 const writes: {url:string; payload:unknown}[]=[]
 globalThis.fetch=async(input,init)=>{
  if(init?.method==='POST') {
   writes.push({url:String(input),payload:JSON.parse(String(init.body))})
   return Response.json({id:'preview',status:'preview',result:{user_candidates:[
    {subject:'dev',display_name:'开发员工',department_ids:['3'],changed:false,skipped:false,excluded:false,kind:'unchanged',after:{name:'开发员工',active:true,departments:['3']}},
    {subject:'product',display_name:'产品员工',department_ids:['4'],changed:true,skipped:false,excluded:false,kind:'new',after:{name:'产品员工',active:true,departments:['4']}},
   ]}})
  }
  return Response.json(String(input).endsWith('/directory-preview')?{departments:[
   {external_id:'2',display_name:'研发'}, {external_id:'3',display_name:'开发',parent_external_id:'2'},
   {external_id:'4',display_name:'产品'},
  ],selected_department_ids:['4']}:{status:'idle'})
 }
 render(<OrganizationSyncPanel sourceId="source" provider="dingtalk" csrf="csrf" onClose={()=>{}} onCompleted={()=>{}} />)
 fireEvent.click(await screen.findByText('研发'))
 assert.equal(writes.length,0)
 assert.equal(screen.queryByLabelText('同步开发员工'),null)
 fireEvent.click(screen.getByRole('button',{name:'查看研发用户'}))
 await screen.findByLabelText('同步开发员工')
 assert.equal(screen.queryByLabelText('同步产品员工'),null)
 assert.deepEqual(writes,[{url:'/api/admin/identity-sources/source/sync-jobs',payload:{department_ids:['2','3','4'],selection_department_ids:['4','2','3'],preview:true,full_directory:true}}])
 assert.equal(screen.getByRole('button',{name:'查看研发用户'}).getAttribute('aria-pressed'),'true')
 await waitFor(()=>assert.equal((screen.getByLabelText('同步开发员工') as HTMLInputElement).checked,true))
 fireEvent.click(screen.getByLabelText('同步开发员工'))
 fireEvent.click(screen.getByRole('button',{name:'查看产品用户'}))
 assert.ok(screen.getByLabelText('同步产品员工'))
 assert.equal(screen.queryByLabelText('同步开发员工'),null)
 assert.equal(writes.length,1)
 fireEvent.click(screen.getByRole('button',{name:'查看所有所选组织用户'}))
 assert.ok(screen.getByLabelText('同步开发员工'))
 assert.equal((screen.getByLabelText('同步开发员工') as HTMLInputElement).checked,false)
 fireEvent.click(screen.getByRole('button',{name:'同步 1 位用户 · 应用组织变更'}))
 await waitFor(()=>assert.deepEqual(writes[1],{url:'/api/admin/identity-sources/source/sync-jobs/confirm',payload:{job_id:'preview',department_ids:['4'],selected_subjects:['product'],maintenance_policy:{mode:'users',department_ids:[],subjects:['product'],excluded_subjects:[]}}}))
})

test('viewing a department outside the preview reads its users and retains prior exclusions', async()=>{
 const user=(id:string)=>({subject:id,display_name:id,department_ids:[id],changed:true,skipped:false,excluded:false,kind:'new',after:{name:id,active:true,departments:[id]}})
 let payload:unknown
 globalThis.fetch=async(input,init)=>{
  if(init?.method==='POST') {
   payload=JSON.parse(String(init.body))
   return Response.json({id:'expanded',status:'preview',result:{user_candidates:[user('dev'),user('product')]}})
  }
  return Response.json(String(input).endsWith('/directory-preview')?{departments:[{external_id:'dev',display_name:'研发'},{external_id:'product',display_name:'产品'}],selected_department_ids:['dev']}:{id:'initial',status:'preview',department_ids:['dev'],result:{user_candidates:[user('dev')]}})
 }
 render(<OrganizationSyncPanel sourceId="source" provider="dingtalk" csrf="csrf" onClose={()=>{}} onCompleted={()=>{}} />)
 const employee=await screen.findByLabelText('同步dev') as HTMLInputElement
 await waitFor(()=>assert.equal(employee.checked,true))
 fireEvent.click(employee)
 fireEvent.click(screen.getByRole('button',{name:'查看产品用户'}))
 await screen.findByLabelText('同步product')
 assert.deepEqual(payload,{department_ids:['dev','product'],selection_department_ids:[],preview:true,full_directory:true})
 fireEvent.click(screen.getByRole('button',{name:'查看研发用户'}))
 assert.equal((screen.getByLabelText('同步dev') as HTMLInputElement).checked,false)
 fireEvent.click(screen.getByRole('button',{name:'检查变更'}))
 await waitFor(()=>assert.deepEqual(payload,{department_ids:['dev','product'],selection_department_ids:[],preview:true,full_directory:true,refresh:true}))
})

test('preview departments can be unchecked including descendants and empty departments', async()=>{
 let writes=0
 globalThis.fetch=async(input,init)=>{
  if(init?.method==='POST')writes++
  return Response.json(String(input).endsWith('/directory-preview')?{departments:[
   {external_id:'1',display_name:'公司'}, {external_id:'2',display_name:'研发',parent_external_id:'1'},
   {external_id:'3',display_name:'空部门'},
  ],selected_department_ids:[]}:{id:'job',status:'preview',department_ids:['1','2','3'],result:{user_candidates:[]}})
 }
 render(<OrganizationSyncPanel sourceId="source" provider="dingtalk" csrf="csrf" onClose={()=>{}} onCompleted={()=>{}} />)
 const parent=await screen.findByLabelText('公司') as HTMLInputElement
 assert.equal(parent.checked,true)
 fireEvent.click(parent)
 assert.equal(parent.checked,false)
 assert.equal((screen.getByLabelText('研发') as HTMLInputElement).checked,false)
 const empty=screen.getByLabelText('空部门') as HTMLInputElement
 fireEvent.click(empty)
 assert.equal(empty.checked,false)
 assert.equal(writes,0)
 assert.equal((screen.getByRole('button',{name:'同步 0 位用户 · 应用组织变更'}) as HTMLButtonElement).disabled,true)
})

test('full directory reading retains the checked apply scope and updates progress', async()=>{
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
 const checkbox=await screen.findByLabelText('研发')
 assert.equal((screen.getByRole('button',{name:'读取通讯录'}) as HTMLButtonElement).disabled,true)
 fireEvent.click(checkbox)
 fireEvent.click(screen.getByRole('button',{name:'读取通讯录'}))
 await waitFor(()=>assert.deepEqual(payload,{department_ids:['1','2'],selection_department_ids:['2'],preview:true,full_directory:true}))
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
 fireEvent.click(await screen.findByRole('button',{name:'读取通讯录'}))
 await screen.findByRole('alert')
 assert.equal((screen.getByLabelText('研发') as HTMLInputElement).checked,true)
 fireEvent.click(screen.getByRole('button',{name:'读取通讯录'}))
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
 const checkbox=await screen.findByLabelText('研发')
 assert.equal((checkbox as HTMLInputElement).checked,true)
 assert.equal((checkbox as HTMLInputElement).disabled,true)
 await screen.findByText(/服务重启或关闭导致同步中断/,{},{timeout:3000})
 await waitFor(()=>assert.equal((checkbox as HTMLInputElement).disabled,false))
})

test('organization selection opens as a dialog and closes without starting sync', async () => {
 let closed = 0
 globalThis.fetch = async input => Response.json(String(input).endsWith('/directory-preview') ? {departments:[],selected_department_ids:[]} : {status:'idle'})
 render(<OrganizationSyncPanel sourceId="source" provider="dingtalk" csrf="csrf" onClose={()=>closed++} onCompleted={()=>{}} />)
 assert.ok(screen.getByRole('dialog',{name:'钉钉 · 选择同步组织与用户'}))
 const instructions=screen.getByText('同步说明与注意事项').closest('details')!
 assert.equal(instructions.open,false)
 fireEvent.click(screen.getByText('同步说明与注意事项'))
 assert.equal(instructions.open,true)
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

test('sync dialog ignores backdrop clicks and Escape but allows explicit closing', async()=>{
 let closed=0
 globalThis.fetch=async input=>Response.json(String(input).endsWith('/directory-preview')?{departments:[],selected_department_ids:[]}:{status:'idle'})
 render(<OrganizationSyncPanel sourceId="source" provider="dingtalk" csrf="csrf" onClose={()=>closed++} onCompleted={()=>{}} />)
 const dialog=screen.getByRole('dialog',{name:'钉钉 · 选择同步组织与用户'})
 fireEvent.click(dialog)
 assert.equal(closed,0)
 const cancel=new dom.window.Event('cancel',{cancelable:true})
 fireEvent(dialog,cancel)
 assert.equal(cancel.defaultPrevented,true)
 assert.equal(closed,0)
 fireEvent.click(screen.getByRole('button',{name:'关闭弹窗'}))
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
 fireEvent.click(screen.getByRole('button',{name:'读取通讯录'}))
 await waitFor(()=>assert.deepEqual(payload,{department_ids:['1','2','3','4'],selection_department_ids:['2','3'],preview:true,full_directory:true}))
})


test('completed sync reports additions and locally deleted skips',async()=>{
 globalThis.fetch=async input=>Response.json(String(input).endsWith('/directory-preview')?{departments:[],selected_department_ids:[]}:{status:'completed',result:{departments:9,people:59,departments_added:0,people_added:1,departments_deleted_skipped:9,people_deleted_skipped:58}})
 render(<OrganizationSyncPanel sourceId="source" provider="dingtalk" csrf="csrf" onClose={()=>{}} onCompleted={()=>{}} />)
 await screen.findByText(/跳过本地已删除：9 个组织、58 位用户/)
})


test('preview requires explicit confirmation before applying changes', async () => {
 const writes: string[]=[]
 globalThis.fetch=async (input,init)=>{
  const url=String(input)
  if(init?.method==='POST') {writes.push(url); return Response.json({id:'job',status:'queued'})}
  return Response.json(url.endsWith('/directory-preview') ? {departments:[{external_id:'2',display_name:'研发'}],selected_department_ids:['2']} : {id:'job',status:'preview',department_ids:['2'],result:{people_departed:2,details:[]}})
 }
 render(<OrganizationSyncPanel sourceId="source" provider="wecom" csrf="csrf" onClose={()=>{}} onCompleted={()=>{}} />)
 await screen.findByText(/变更预览/)
 assert.equal(writes.length,0)
 fireEvent.click(screen.getByRole('button',{name:'同步 0 位用户 · 应用组织变更'}))
 await waitFor(()=>assert.equal(writes[0],'/api/admin/identity-sources/source/sync-jobs/confirm'))
})


test('user preview hides unchanged users, supports exclusions and group reselection',async()=>{
 let payload:unknown
 const candidates=[
  {subject:'new',display_name:'新员工',department_ids:['2'],changed:true,skipped:false,excluded:false,kind:'new',after:{name:'新员工',active:true,departments:['2']}},
  {subject:'old',display_name:'已同步员工',department_ids:['2'],changed:false,skipped:false,excluded:false,kind:'unchanged',after:{name:'已同步员工',active:true,departments:['2']}},
  {subject:'deleted',display_name:'已删除员工',department_ids:['2'],changed:true,skipped:true,skip_reason:'deleted',excluded:false,kind:'changed',after:{name:'已删除员工',active:true,departments:['2']}},
  {subject:'purged',display_name:'彻底删除员工',department_ids:['2'],changed:true,skipped:true,skip_reason:'purged',excluded:false,kind:'new',after:{name:'彻底删除员工',active:true,departments:['2']}},
 ]
 globalThis.fetch=async(input,init)=>{
  if(init?.method==='POST'){payload=JSON.parse(String(init.body));return Response.json({id:'job',status:'queued'})}
  return Response.json(String(input).endsWith('/directory-preview')?{departments:[{external_id:'2',display_name:'研发'}],selected_department_ids:['2']}:{id:'job',status:'preview',department_ids:['2'],result:{user_candidates:candidates}})
 }
 render(<OrganizationSyncPanel sourceId="source" provider="dingtalk" csrf="csrf" onClose={()=>{}} onCompleted={()=>{}} />)
 const employee=await screen.findByLabelText('同步新员工') as HTMLInputElement
 await waitFor(()=>assert.equal(employee.checked,true))
 assert.equal(screen.queryByLabelText('同步已同步员工'),null)
 assert.equal((screen.getByLabelText('同步已删除员工') as HTMLInputElement).disabled,false)
 assert.equal((screen.getByLabelText('同步彻底删除员工') as HTMLInputElement).disabled,false)
 assert.ok(screen.getByText('本地用户在回收站；勾选后将恢复并覆盖同步资料'))
 assert.ok(screen.getByText('历史彻底删除标记，账号已不存在；勾选后将重新创建并同步'))
 fireEvent.click(employee)
 assert.equal((screen.getByLabelText('研发') as HTMLInputElement).indeterminate,true)
 fireEvent.click(screen.getByLabelText('研发'))
 assert.equal(employee.checked,true)
 fireEvent.click(screen.getByLabelText('仅看有变化'))
 assert.equal((screen.getByLabelText('同步已同步员工') as HTMLInputElement).checked,true)
 fireEvent.click(employee)
 fireEvent.click(screen.getByLabelText('同步已删除员工'))
 fireEvent.click(screen.getByLabelText('同步彻底删除员工'))
 fireEvent.click(screen.getByRole('button',{name:'同步 3 位用户 · 应用组织变更'}))
 await waitFor(()=>assert.deepEqual(payload,{job_id:'job',department_ids:['2'],selected_subjects:['old','deleted','purged'],maintenance_policy:{mode:'users',department_ids:[],subjects:['old','deleted','purged'],excluded_subjects:[]}}))
})

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { OrganizationSyncNotice } from '../src/OrganizationSyncNotice'
import { OrganizationSyncHistory } from '../src/OrganizationSyncHistory'
import { OrganizationSyncSettings } from '../src/OrganizationSyncSettings'
import { AdminUsersPage } from '../src/AdminUsersPage'
import { MemoryRouter } from 'react-router-dom'
const dom = new JSDOM('<html><body></body></html>', {url:'https://gateway.test/admin/settings'})
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,MutationObserver:dom.window.MutationObserver,Event:dom.window.Event})
Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator})
const {render,screen,fireEvent,waitFor,cleanup,within}=await import('@testing-library/react')
const original=globalThis.fetch
afterEach(()=>{cleanup();globalThis.fetch=original})

test('each application editor links to its provider console in a new tab',async()=>{
 globalThis.fetch=async()=>Response.json({sources:[]})
 for (const [provider,url] of [['钉钉','https://open-dev.dingtalk.com/'],['企业微信','https://work.weixin.qq.com/wework_admin/']]) {
  render(<OrganizationSyncSettings csrf="csrf" />)
  fireEvent.click(await screen.findByRole('button',{name:`添加${provider}应用`}))
  const link=within(screen.getByRole('dialog',{name:`${provider}应用配置`})).getByRole('link',{name:`打开${provider}${provider==='钉钉'?'开发者':'管理'}后台`})
  assert.equal(link.getAttribute('href'),url)
  assert.equal(link.getAttribute('target'),'_blank')
  assert.equal(link.getAttribute('rel'),'noopener noreferrer')
  cleanup()
 }
})

test('application editor saves provider keys and scan options without displaying a saved secret',async()=>{
 const captured: {body?: Record<string,unknown>}={}
 globalThis.fetch=async(input,init)=>{
  const url=String(input)
  if(init?.method==='POST'){captured.body=JSON.parse(String(init.body));return Response.json({id:'source-1'},{status:201})}
  return Response.json({sources:[]})
 }
 render(<OrganizationSyncSettings csrf="csrf" />)
 fireEvent.click(await screen.findByRole('button',{name:'添加企业微信应用'}))
 const dialog=screen.getByRole('dialog',{name:'企业微信应用配置'})
 fireEvent.change(within(dialog).getByLabelText(/企业 Corp ID/),{target:{value:'corp-a'}})
 fireEvent.change(within(dialog).getByLabelText('Agent ID'),{target:{value:'10001'}})
 fireEvent.change(within(dialog).getByLabelText('应用 Secret'),{target:{value:'private-key'}})
 fireEvent.click(within(dialog).getByLabelText('启用扫码登录'))
 fireEvent.click(within(dialog).getByRole('button',{name:'保存配置'}))
 await waitFor(()=>assert.equal(captured.body?.tenant_id,'corp-a'))
 assert.equal(captured.body?.client_secret,'private-key');assert.equal(captured.body?.login_enabled,false);assert.equal(captured.body?.sync_enabled,true)
 assert.doesNotMatch(document.body.textContent??'',/private-key/)
})

test('user group selection filters the paginated user table',async()=>{
 const calls:string[]=[]
 globalThis.fetch=async(input)=>{
  const url=String(input);calls.push(url)
  if(url==='/api/auth/session')return Response.json({csrf_token:'csrf',admin_roles:['super_admin']})
  if(url==='/api/admin/user-groups/tree')return Response.json({groups:[{id:'g1',name:'公司',parent_id:null,member_count:0},{id:'g2',name:'研发',parent_id:'g1',member_count:1}]})
  return Response.json({users:[{id:'u1',username:'alice',display_name:'Alice',status:'active',registration_source:'directory_sync'}],total:1})
 }
 render(<MemoryRouter><AdminUsersPage /></MemoryRouter>)
 fireEvent.click(await screen.findByRole('button',{name:/研发/}))
 await waitFor(()=>assert.ok(calls.some(url=>url.includes('group_id=g2'))))
 assert.equal(screen.getByText('Alice').closest('table')!==null,true)
 assert.equal(screen.getByRole('tree',{name:'用户组'}).querySelector('[role=group]')!==null,true)
})

test('organization settings opens the self-managed selection panel without importing immediately',async()=>{
 let writes=0
 globalThis.fetch=async(input,init)=>{
  if(init?.method==='POST'){writes++;throw Error('must select first')}
  if(String(input).endsWith('/directory-preview'))return Response.json({departments:[{external_id:'2',display_name:'研发'}],selected_department_ids:[]})
  if(String(input).endsWith('/latest'))return Response.json({status:'idle'})
  return Response.json({sources:[{id:'source-1',provider:'dingtalk',tenant_id:'corp',client_id:'app',enabled:true}]})
 }
 render(<OrganizationSyncSettings csrf="csrf" />)
 fireEvent.click(await screen.findByRole('button',{name:'同步组织与用户'}))
 await screen.findByLabelText('研发')
 assert.equal(writes,0)
 assert.equal((within(screen.getByRole('dialog',{name:'钉钉 · 选择同步组织与用户'})).getByRole('button',{name:'读取组织与用户变更'}) as HTMLButtonElement).disabled,true)
})

test('existing enterprise Corp ID can be corrected without replacing its source or secret', async () => {
 let saved: Record<string,unknown> | undefined
 globalThis.fetch = async (input,init) => {
  if (init?.method === 'PUT') { assert.equal(String(input), '/api/admin/identity-sources/source-1'); saved = JSON.parse(String(init.body)); return Response.json({id:'source-1'}) }
  return Response.json({sources:[{id:'source-1',provider:'dingtalk',tenant_id:'wrong-id',client_id:'app',enabled:true,secret_configured:true}]})
 }
 render(<OrganizationSyncSettings csrf="csrf" />)
 fireEvent.click(await screen.findByRole('button',{name:'编辑配置'}))
 const field = screen.getByLabelText(/企业 Corp ID/) as HTMLInputElement
 assert.equal(field.disabled,false)
 fireEvent.change(field,{target:{value:'ding-correct'}})
 fireEvent.click(screen.getByRole('button',{name:'保存配置'}))
 await waitFor(()=>assert.equal(saved?.tenant_id,'ding-correct'))
 assert.equal(saved?.client_secret,null)
})


test('application editor saves a weekly schedule with time zone and weekday', async()=>{
 let saved: Record<string,unknown> | undefined
 globalThis.fetch=async (_input,init)=>{
  if(init?.method==='POST'){saved=JSON.parse(String(init.body));return Response.json({id:'source'})}
  return Response.json({sources:[]})
 }
 render(<OrganizationSyncSettings csrf="csrf" />)
 fireEvent.click(await screen.findByRole('button',{name:'添加钉钉应用'}))
 fireEvent.change(screen.getByLabelText(/企业 Corp ID/),{target:{value:'ding-corp'}})
 fireEvent.change(screen.getByLabelText('App Key / Client ID'),{target:{value:'app'}})
 fireEvent.change(screen.getByLabelText('应用 Secret'),{target:{value:'secret'}})
 fireEvent.change(screen.getByLabelText('自动同步频率'),{target:{value:'weekly'}})
 fireEvent.change(screen.getByLabelText('执行时间'),{target:{value:'18:30'}})
 fireEvent.change(screen.getByLabelText('星期'),{target:{value:'4'}})
 fireEvent.click(screen.getByRole('button',{name:'保存配置'}))
 await waitFor(()=>assert.deepEqual(saved?.sync_schedule,{frequency:'weekly',time:'18:30',timezone:'Asia/Shanghai',weekday:4}))
})


test('directory notice shows changes and marks only that notice read',async()=>{
 let read:unknown
 globalThis.fetch=async(input,init)=>{
  if(String(input)==='/api/auth/session')return Response.json({csrf_token:'csrf'})
  if(init?.method==='POST'){read=JSON.parse(String(init.body));return Response.json({ok:true})}
  return Response.json({notices:[{source_id:'source',at:'2026-10-09T00:00:00Z',result:{people_departed:2}}]})
 }
 render(<MemoryRouter><OrganizationSyncNotice/></MemoryRouter>)
 fireEvent.click(await screen.findByRole('button',{name:'组织同步 (1)'}))
 await screen.findByText(/停用 2 人/)
 fireEvent.click(screen.getByRole('button',{name:'标记已读'}))
 await waitFor(()=>assert.deepEqual(read,{source_id:'source',at:'2026-10-09T00:00:00Z'}))
 await screen.findByText('没有未读的组织同步提示。')
})

test('history owns loading and shows stored status changes',async()=>{
 globalThis.fetch=async input=>{
  assert.equal(String(input),'/api/admin/identity-sources/source/sync-history')
  return Response.json({jobs:[{id:'job',status:'completed',started_at:'2026-10-09T00:00:00Z',result:{people_transferred:3,people_departed:2}}]})
 }
 render(<OrganizationSyncHistory sourceId="source" onClose={()=>{}}/>)
 await screen.findByText(/调部门 3/)
 assert.ok(screen.getByRole('dialog',{name:'组织同步记录'}))
})


test('scan login callback uses the configured platform address for both providers and follows address changes', async () => {
 for (const provider of ['dingtalk', 'wecom']) {
  globalThis.fetch = async () => Response.json({sources:[{id:'source-1',provider,tenant_id:'corp',client_id:'app',enabled:true}]})
  const view = render(<OrganizationSyncSettings csrf="csrf" platformAddress="https://public.example.com/" />)
  fireEvent.click(await screen.findByRole('button',{name:'编辑配置'}))
  const callback = screen.getByLabelText('登录回调地址') as HTMLInputElement
  assert.equal(callback.value,'https://public.example.com/api/auth/external/source-1/callback')
  assert.equal(callback.readOnly,true)
  view.rerender(<OrganizationSyncSettings csrf="csrf" platformAddress="https://updated.example.com" />)
  assert.equal(callback.value,'https://updated.example.com/api/auth/external/source-1/callback')
  view.rerender(<OrganizationSyncSettings csrf="csrf" platformAddress={null} />)
  assert.equal(callback.value,'https://gateway.test/api/auth/external/source-1/callback')
  cleanup()
 }
})

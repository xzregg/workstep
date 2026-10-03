import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { OrganizationSyncSettings } from '../src/OrganizationSyncSettings'
import { AdminUsersPage } from '../src/AdminUsersPage'
import { MemoryRouter } from 'react-router-dom'
const dom = new JSDOM('<html><body></body></html>', {url:'https://gateway.test/admin/settings'})
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,MutationObserver:dom.window.MutationObserver,Event:dom.window.Event})
Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator})
const {render,screen,fireEvent,waitFor,cleanup,within}=await import('@testing-library/react')
const original=globalThis.fetch
afterEach(()=>{cleanup();globalThis.fetch=original})

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
 fireEvent.change(within(dialog).getByLabelText('Corp ID'),{target:{value:'corp-a'}})
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

test('organization sync submits once, refreshes its status and keeps a failed operation retryable',async()=>{
 let calls=0
 let release:(response:Response)=>void=()=>{}
 globalThis.fetch=async(input,init)=>{
  if(init?.method==='POST'){
   calls++;assert.equal(new Headers(init.headers).get('X-CSRF-Token'),'csrf')
   return new Promise(resolve=>{release=resolve})
  }
  return Response.json({sources:[{id:'source-1',provider:'dingtalk',tenant_id:'corp',client_id:'app',enabled:true,sync_enabled:true,login_enabled:false,secret_configured:true}]})
 }
 render(<OrganizationSyncSettings csrf="csrf" />)
 const sync=await screen.findByRole('button',{name:'同步组织'})
 fireEvent.click(sync);fireEvent.click(sync)
 await waitFor(()=>assert.equal(calls,1))
 assert.equal(screen.getByRole('button',{name:'正在同步…'}).hasAttribute('disabled'),true)
 release(new Response(null,{status:502}))
 assert.match((await screen.findByRole('alert')).textContent??'',/同步失败/)
 fireEvent.click(screen.getByRole('button',{name:'同步组织'}))
 await waitFor(()=>assert.equal(calls,2))
 release(Response.json({people:1,departments:1}))
 await waitFor(()=>assert.match(document.body.textContent??'',/组织同步完成，已更新用户组和用户/))
})

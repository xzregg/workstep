import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'
import { AdminUsersPage } from '../src/AdminUsersPage'
import { GroupMembersManager } from '../src/GroupMembersManager'
import { AdminBulkActionDialog } from '../src/AdminBulkActionDialog'
import { AdminGroupLifecyclePanel } from '../src/AdminGroupLifecyclePanel'
import { AdminGroupsPage } from '../src/AdminGroupsPage'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {url:'https://gateway.test/admin/users'})
Object.assign(globalThis, {window:dom.window, document:dom.window.document, HTMLElement:dom.window.HTMLElement,
 MutationObserver:dom.window.MutationObserver, Event:dom.window.Event})
Object.defineProperty(globalThis, 'navigator', {configurable:true,value:dom.window.navigator})
const {cleanup, fireEvent, render, screen, waitFor, within} = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(()=>{cleanup(); globalThis.fetch=originalFetch})

test('users expose checked-only delete with password confirmation and restore in deleted filter', async()=>{
 const writes:object[]=[]
 globalThis.fetch=async(input,init)=>{
  const url=String(input)
  if(url==='/api/auth/step-up')return Response.json({})
  if(init?.method==='POST'){writes.push(JSON.parse(String(init.body)));return Response.json({updated:1})}
  if(url==='/api/auth/session')return Response.json({csrf_token:'csrf',admin_roles:['super_admin'],user:{id:'owner'}})
  if(url==='/api/admin/user-groups/tree')return Response.json({groups:[]})
  if(url.startsWith('/api/admin/users?'))return Response.json({users:[{id:'a',display_name:'张三',username:'alice',status:url.includes('status=deleted')?'deleted':'active',registration_source:'local'}],total:1})
  throw Error(url)
 }
 render(<MemoryRouter><AdminUsersPage/></MemoryRouter>)
 await screen.findByText('张三')
 fireEvent.click(screen.getByRole('checkbox',{name:'选择张三'}))
 fireEvent.click(screen.getByRole('button',{name:'批量删除'}))
 fireEvent.change(screen.getByLabelText('输入你的密码确认'),{target:{value:'secret'}})
 fireEvent.click(screen.getByRole('button',{name:'确认删除'}))
 await waitFor(()=>assert.deepEqual(writes,[{action:'delete',user_ids:['a']}]))
 await waitFor(()=>assert.equal(screen.queryByRole('dialog'),null))
 fireEvent.change(screen.getByLabelText('状态'),{target:{value:'deleted'}})
 fireEvent.click(await screen.findByRole('button',{name:'恢复'}))
 fireEvent.change(screen.getByLabelText('输入你的密码确认'),{target:{value:'secret'}})
 fireEvent.click(screen.getByRole('button',{name:'确认恢复'}))
 await waitFor(()=>assert.deepEqual(writes[1],{action:'restore',user_ids:['a']}))
})

test('group tree supports selected-only delete and refreshes without deleting members',async()=>{
 const writes:object[]=[]
 globalThis.fetch=async(input,init)=>{
  const url=String(input)
  if(url==='/api/auth/step-up')return Response.json({})
  if(init?.method==='POST'){writes.push(JSON.parse(String(init.body)));return Response.json({updated:1})}
  if(url==='/api/auth/session')return Response.json({csrf_token:'csrf'})
  if(url==='/api/admin/user-groups/tree')return Response.json({groups:writes.length?[]:[{id:'g',name:'研发组',parent_id:null,source_type:'manual',member_count:0}]})
  if(url==='/api/groups/deleted')return Response.json({groups:[]})
  if(url.endsWith('/members'))return Response.json({members:[]})
  if(url.endsWith('/projects'))return Response.json({projects:[]})
  throw Error(url)
 }
 render(<MemoryRouter><AdminGroupsPage/></MemoryRouter>)
 fireEvent.click(await screen.findByRole('checkbox',{name:'选择用户组研发组'}))
 assert.equal(screen.getByRole('button',{name:'删除所选用户组'}).parentElement?.previousElementSibling===null,true)
 fireEvent.click(screen.getByRole('button',{name:'删除所选用户组'}))
 fireEvent.change(screen.getByLabelText('输入你的密码确认'),{target:{value:'secret'}})
 fireEvent.click(screen.getByRole('button',{name:'确认删除'}))
 await waitFor(()=>assert.deepEqual(writes,[{action:'delete',group_ids:['g']}]))
 await screen.findByText('尚无用户组，可创建或同步组织。')
})

test('users show display names and bulk approval sends only checked IDs, clearing selection on search', async()=>{
 const writes: Array<{url:string;init?:RequestInit}> = []
 const reads:string[]=[]
 globalThis.fetch = async(input,init)=>{
  const url=String(input)
  reads.push(url)
  if (init?.method==='POST') {writes.push({url,init}); return Response.json({updated:1})}
  if(url==='/api/auth/session')return Response.json({csrf_token:'csrf',admin_roles:['super_admin'],user:{id:'owner'}})
  if(url==='/api/admin/user-groups/tree')return Response.json({groups:[]})
  if(url.startsWith('/api/admin/users?'))return Response.json({users:[
   {id:'a',display_name:'张三',username:'ext_very_long_internal_identifier',login_username:null,status:'pending',registration_source:'directory_sync'},
   {id:'b',display_name:'李四',username:'lisi',login_username:'lisi',status:'pending',registration_source:'local'},
  ],total:2})
  throw Error(url)
 }
 render(<MemoryRouter><AdminUsersPage/></MemoryRouter>)
 await screen.findByText('张三')
 assert.ok(reads.some(url=>url.startsWith('/api/admin/users?') && new URLSearchParams(url.split('?')[1]).get('page_size')==='100'))
 assert.equal(screen.queryByText('ext_very_long_internal_identifier'),null)
 fireEvent.click(screen.getByRole('checkbox',{name:'选择张三'}))
 fireEvent.click(screen.getByRole('button',{name:'批量批准'}))
 fireEvent.click(within(screen.getByRole('dialog',{name:'批量批准用户'})).getByRole('button',{name:'确认批准'}))
 await waitFor(()=>assert.equal(writes.length,1))
 assert.equal(writes[0].url,'/api/admin/users/bulk')
 assert.deepEqual(JSON.parse(String(writes[0].init?.body)),{action:'approve',user_ids:['a']})
 await waitFor(()=>assert.equal(screen.queryByRole('dialog') === null,true))
 fireEvent.click(screen.getByRole('checkbox',{name:'选择李四'}))
 fireEvent.change(screen.getByLabelText('搜索用户'),{target:{value:'张'}})
 fireEvent.click(screen.getByRole('button',{name:/^搜索$/}))
 await waitFor(()=>assert.equal((screen.getByRole('checkbox',{name:'选择李四'}) as HTMLInputElement).checked,false))
})

test('bulk disable verifies password, prevents duplicate requests and keeps failures retryable', async()=>{
 let writes=0;let steps=0;let done=0
 globalThis.fetch=async(input)=>{
  if(String(input)==='/api/auth/step-up'){steps++;return Response.json({})}
  writes++;return writes===1?new Response(null,{status:409}):Response.json({updated:1})
 }
 render(<AdminBulkActionDialog csrf="csrf" action={{title:'批量停用用户',label:'确认停用',message:'停用所选账号',url:'/api/admin/users/bulk',body:{user_ids:['a'],action:'disable'},password:true}} onClose={()=>{}} onDone={()=>done++}/>)
 const confirm=screen.getByRole('button',{name:'确认停用'})
 assert.equal((confirm as HTMLButtonElement).disabled,true)
 fireEvent.change(screen.getByLabelText('输入你的密码确认'),{target:{value:'secret'}})
 fireEvent.click(confirm);fireEvent.click(confirm)
 await screen.findByRole('alert');assert.equal(writes,1);assert.equal(done,0)
 fireEvent.click(screen.getByRole('button',{name:'确认停用'}))
 await waitFor(()=>assert.equal(done,1));assert.equal(steps,2);assert.equal(writes,2)
})

test('group members support checked-only bulk add and protect directory membership', async()=>{
 const writes:object[]=[]
 globalThis.fetch=async(input,init)=>{
  const url=String(input)
  if(init?.method==='POST'){writes.push(JSON.parse(String(init.body)));return Response.json({updated:1})}
  if(url==='/api/groups/g/members')return Response.json({members:[
   {user_id:'sync',display_name:'同步成员',username:'ext_internal',role:'member',source:'directory_sync'},
   {user_id:'manual',display_name:'手工成员',username:'manual',role:'member',source:'manual'},
  ]})
  if(url.startsWith('/api/admin/users?'))return Response.json({users:[
   {id:'a',display_name:'张三',username:'zhangsan'}, {id:'b',display_name:'李四',username:'lisi'},
  ]})
  throw Error(url)
 }
 render(<GroupMembersManager groupId="g" csrf="csrf" onChanged={()=>{}}/>)
 await screen.findByText('同步成员')
 assert.equal((screen.getByRole('checkbox',{name:'选择同步成员'}) as HTMLInputElement).disabled,true)
 assert.equal(screen.queryByText('ext_internal'),null)
 fireEvent.change(screen.getByLabelText('搜索用户'),{target:{value:'张'}})
 fireEvent.click(screen.getByRole('button',{name:'查找用户'}))
 await screen.findByText('张三')
 fireEvent.click(screen.getByRole('checkbox',{name:'选择待添加用户张三'}))
 fireEvent.click(screen.getByRole('button',{name:'批量添加成员'}))
 fireEvent.click(within(screen.getByRole('dialog',{name:'添加成员'})).getByRole('button',{name:'确认添加'}))
 await waitFor(()=>assert.deepEqual(writes,[{action:'add',user_ids:['a'],role:'member'}]))
})

test('group role changes and removals exclude synced users and keep failed choices for retry', async()=>{
 const writes: Array<Record<string,unknown>>=[]
 let failure=true
 globalThis.fetch=async(input,init)=>{
  if(init?.method==='POST'){
   writes.push(JSON.parse(String(init.body)))
   if(failure){failure=false;return new Response(null,{status:409})}
   return Response.json({updated:1})
  }
  assert.equal(String(input),'/api/groups/g/members')
  return Response.json({members:[
   {user_id:'a',display_name:'张三',username:'zhangsan',role:'member',source:'manual'},
   {user_id:'b',display_name:'同步成员',username:'ext_hidden',role:'member',source:'directory_sync'},
  ]})
 }
 render(<GroupMembersManager groupId="g" csrf="csrf" onChanged={()=>{}}/>)
 await screen.findByText('张三')
 fireEvent.click(screen.getByRole('checkbox',{name:'全选当前表格'}))
 assert.equal((screen.getByRole('checkbox',{name:'选择同步成员'}) as HTMLInputElement).checked,false)
 fireEvent.change(screen.getByLabelText('成员角色'),{target:{value:'leader'}})
 fireEvent.click(screen.getByRole('button',{name:'批量调整角色'}))
 fireEvent.click(screen.getByRole('button',{name:'确认调整角色'}))
 await screen.findByRole('alert')
 assert.equal((screen.getByRole('checkbox',{name:'选择张三'}) as HTMLInputElement).checked,true)
 fireEvent.click(screen.getByRole('button',{name:'确认调整角色'}))
 await waitFor(()=>assert.equal(screen.queryByRole('dialog') === null,true))
 assert.deepEqual(writes[1],{action:'set_role',user_ids:['a'],role:'leader'})
 await waitFor(()=>assert.equal((screen.getByRole('checkbox',{name:'选择张三'}) as HTMLInputElement).disabled,false))
 fireEvent.click(screen.getByRole('checkbox',{name:'选择张三'}))
 fireEvent.click(screen.getByRole('button',{name:'批量移除成员'}))
 fireEvent.click(screen.getByRole('button',{name:'确认移除'}))
 await waitFor(()=>assert.equal(writes.length,3))
 assert.deepEqual(writes[2],{action:'remove',user_ids:['a']})
})

test('group selection cascades through hidden descendants and shows partial parents', async () => {
 globalThis.fetch = async () => Response.json({groups:[
  {id:'root',name:'总部',parent_id:null}, {id:'a',name:'研发',parent_id:'root'},
  {id:'b',name:'产品',parent_id:'root'}, {id:'c',name:'研发一组',parent_id:'a'},
 ]})
 render(<AdminGroupLifecyclePanel csrf="csrf" selected="" revision={0} onSelect={()=>{}} onChanged={()=>{}} />)
 const root = await screen.findByRole('checkbox',{name:'选择用户组总部'}) as HTMLInputElement
 fireEvent.click(root)
 assert.equal((screen.getByRole('checkbox',{name:'选择用户组研发一组'}) as HTMLInputElement).checked,true)
 assert.ok(screen.getByText('已选 4 个组'))
 fireEvent.click(screen.getByRole('checkbox',{name:'选择用户组产品'}))
 assert.equal(root.checked,false)
 assert.equal(root.indeterminate,true)
 fireEvent.click(screen.getByRole('button',{name:'取消选择'}))
 fireEvent.change(screen.getByLabelText('搜索用户组'),{target:{value:'总部'}})
 fireEvent.click(root)
 assert.ok(screen.getByText('已选 4 个组'))
 fireEvent.click(screen.getByRole('button',{name:'删除所选用户组'}))
 assert.match(screen.getByRole('dialog').textContent ?? '', /4 个用户组/)
})


test('group recycle bin offers restore and password-confirmed permanent deletion',async()=>{
 let body:unknown
 globalThis.fetch=async(input,init)=>{
  if(String(input)==='/api/auth/step-up')return Response.json({})
  if(init?.method==='POST'){body=JSON.parse(String(init.body));return Response.json({updated:1})}
  return Response.json({groups:String(input)==='/api/groups/deleted'?[{id:'g1',name:'删除组'}]:[]})
 }
 render(<AdminGroupLifecyclePanel csrf="csrf" selected="" revision={0} onSelect={()=>{}} onChanged={()=>{}} />)
 fireEvent.click(screen.getByRole('button',{name:'用户组回收站'}))
 fireEvent.click(await screen.findByRole('checkbox',{name:/删除组/}))
 assert.equal((screen.getByRole('button',{name:'恢复所选用户组'}) as HTMLButtonElement).disabled,false)
 fireEvent.click(screen.getByRole('button',{name:'彻底删除所选用户组'}))
 const dialog=screen.getByRole('dialog',{name:'彻底删除用户组'})
 fireEvent.change(within(dialog).getByLabelText('输入你的密码确认'),{target:{value:'password'}})
 fireEvent.click(within(dialog).getByRole('button',{name:'确认彻底删除'}))
 await waitFor(()=>assert.deepEqual(body,{group_ids:['g1'],action:'purge'}))
})


test('recycle bin supports selecting all groups and purging the selected batch',async()=>{
 let body:unknown
 globalThis.fetch=async(input,init)=>{
  if(String(input)==='/api/auth/step-up')return Response.json({})
  if(init?.method==='POST'){body=JSON.parse(String(init.body));return Response.json({updated:3})}
  return Response.json({groups:String(input)==='/api/groups/deleted'?[{id:'g1',name:'研发'},{id:'g2',name:'产品'},{id:'g3',name:'销售'}]:[]})
 }
 render(<AdminGroupLifecyclePanel csrf="csrf" selected="" revision={0} onSelect={()=>{}} onChanged={()=>{}} />)
 fireEvent.click(screen.getByRole('button',{name:'用户组回收站'}))
 await screen.findByRole('checkbox',{name:'选择用户组研发'})
 fireEvent.click(screen.getByRole('checkbox',{name:'全选用户组'}))
 assert.ok(screen.getByText('已选 3 个组'))
 fireEvent.click(screen.getByRole('button',{name:'彻底删除所选用户组'}))
 const dialog=screen.getByRole('dialog',{name:'彻底删除用户组'})
 fireEvent.change(within(dialog).getByLabelText('输入你的密码确认'),{target:{value:'password'}})
 fireEvent.click(within(dialog).getByRole('button',{name:'确认彻底删除'}))
 await waitFor(()=>assert.deepEqual(body,{group_ids:['g1','g2','g3'],action:'purge'}))
})

test('selecting group search results includes descendants but excludes unrelated groups',async()=>{
 globalThis.fetch=async()=>Response.json({groups:[{id:'root',name:'研发',parent_id:null},{id:'child',name:'前端',parent_id:'root'},{id:'other',name:'销售',parent_id:null}]})
 render(<AdminGroupLifecyclePanel csrf="csrf" selected="" revision={0} onSelect={()=>{}} onChanged={()=>{}} />)
 await screen.findByRole('checkbox',{name:'选择用户组研发'})
 fireEvent.change(screen.getByLabelText('搜索用户组'),{target:{value:'研发'}})
 fireEvent.click(screen.getByRole('button',{name:'勾选搜索结果'}))
 assert.ok(screen.getByText('已选 2 个组'))
 fireEvent.change(screen.getByLabelText('搜索用户组'),{target:{value:''}})
 assert.equal((screen.getByRole('checkbox',{name:'选择用户组销售'}) as HTMLInputElement).checked,false)
 assert.equal((screen.getByRole('checkbox',{name:'全选用户组'}) as HTMLInputElement).indeterminate,true)
})

import { AdminProjectGrantDialog } from '../src/AdminProjectGrantDialog'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'
import { AdminAccessGrants } from '../src/AdminAccessGrants'
import { AdminProjectsPage } from '../src/AdminProjectsPage'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://gateway.test/admin/projects' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver,
  Event: dom.window.Event })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

test('project management has one unified grant entry, recipient editing and revocation', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  let grants = [{ id: 'grant-1', subject_type: 'user', subject_id: 'user-1', subject_name: 'alice', access_level: 'read' }]
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    requests.push({ url, init })
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
    if (url.startsWith('/api/admin/projects?')) return Response.json({ projects: [{
      id: 'project-1', name: 'Platform', device_id: 'pc-1', device_name: 'Host PC',
      device_online: false, publisher: 'owner', published_at: '2026-01-01',
      grant_users: grants.length, grant_groups: 0, grant_levels: { read: grants.length, edit: 0 }, running_tasks: null,
    }], total: 1 })
    if (url === '/api/admin/projects/project-1/grants/user/user-1' && init?.method === 'DELETE') {
      grants = []; return new Response(null, { status: 204 })
    }
    if (url === '/api/admin/projects/project-1/grants') return Response.json({ grants })
    if (url === '/api/auth/step-up') return Response.json({})
    return Response.json({ invitations: [], invitations_enabled: true })
  }
  render(<MemoryRouter><AdminProjectsPage /></MemoryRouter>)
  await screen.findByText(/Host PC/)
  fireEvent.change(screen.getByLabelText('搜索项目或宿主电脑'), { target: { value: 'Platform' } })
  fireEvent.click(screen.getByRole('button', { name: '搜索' }))
  await waitFor(() => assert.ok(requests.some(request => request.url.includes('q=Platform'))))
  await waitFor(() => assert.equal((screen.getByRole('button', { name: '管理授权' }) as HTMLButtonElement).disabled, false))
  fireEvent.click(screen.getByRole('button', { name: '管理授权' }))
  await screen.findByText('alice')
  const create = screen.getByRole('link', { name: '新增授权' })
  assert.ok(create.classList.contains('gateway-action-link'))
  const createParams = new URL(create.getAttribute('href')!, 'https://gateway.test').searchParams
  assert.equal(createParams.get('scope_id'), 'project-1')
  assert.equal(createParams.get('scope_type'), 'project')
  assert.equal(createParams.get('assign'), '1')
  assert.equal(createParams.has('subject_id'), false)
  assert.equal(screen.queryByRole('link', { name: '配置项目权限' }), null)
  assert.equal(screen.queryByRole('button', { name: '新增授权' }), null)
  assert.equal(screen.queryByRole('button', { name: '调整' }), null)
  assert.equal(screen.queryByRole('link', { name: '项目权限' }), null)
  const edit = screen.getByRole('link', { name: '编辑权限' })
  const editParams = new URL(edit.getAttribute('href')!, 'https://gateway.test').searchParams
  assert.equal(editParams.get('subject_id'), 'user-1')
  assert.equal(editParams.get('subject_type'), 'user')
  assert.equal(editParams.get('scope_id'), 'project-1')
  fireEvent.click(screen.getByRole('button', { name: '撤销' }))
  const revoke = screen.getByRole('dialog', { name: '撤销项目授权' })
  fireEvent.change(within(revoke).getByLabelText('输入管理员密码确认'), { target: { value: 'password' } })
  fireEvent.click(within(revoke).getByRole('button', { name: '撤销授权' }))
  await screen.findByText('尚无访问授权。')
  assert.ok(requests.some(request => request.url.endsWith('/grants/user/user-1') && request.init?.method === 'DELETE'))
})

test('scoped project administrators keep one accessible grant entry without super-admin links', async () => {
  globalThis.fetch = async () => Response.json({ grants: [], subjects: [], total: 0, invitations: [], invitations_enabled: true })
  render(<AdminAccessGrants id="p" name="项目" csrf="csrf" onChanged={() => {}} canConfigurePermissions={false} />)
  await screen.findByText('尚无访问授权。')
  assert.equal(screen.queryByRole('link', { name: '配置项目权限' }), null)
  assert.equal(screen.queryByRole('link', { name: '新增授权' }), null)
  fireEvent.click(screen.getByRole('button', { name: '新增授权' }))
  assert.ok(screen.getByRole('dialog', { name: '授予项目访问' }))
})

test('whole-device grants use the shared user/group selector and revoke endpoint',async()=>{
 const calls:Array<{url:string;init?:RequestInit}>=[]
 let grants:any[]=[]
 globalThis.fetch=async(input,init)=>{
 const url=String(input);calls.push({url,init})
 if(url.startsWith('/api/admin/project-grant-subjects?'))return Response.json({subjects:[{id:'g',name:'研发组'}],total:1})
 if(url==='/api/auth/step-up')return Response.json({})
 if(init?.method==='POST'){grants=[{id:'x',subject_type:'group',subject_id:'g',subject_name:'研发组',access_level:'edit'}];return Response.json({id:'x'})}
 if(init?.method==='DELETE'){grants=[];return new Response(null,{status:204})}
 return Response.json({grants})
 }
 render(<AdminAccessGrants id="d" name="设备A" kind="devices" csrf="token" onChanged={()=>{}} />)
 await screen.findByText('尚无访问授权。')
 fireEvent.click(screen.getByRole('button',{name:'新增授权'}))
 const dialog=screen.getByRole('dialog',{name:'授予设备访问'})
 fireEvent.change(within(dialog).getByLabelText('对象类型'),{target:{value:'group'}})
 await within(dialog).findByRole('checkbox',{name:'研发组'})
 fireEvent.click(within(dialog).getByRole('checkbox',{name:'研发组'}))
 assert.equal(within(dialog).queryByRole('option',{name:'只读', hidden: true}),null)
 fireEvent.change(within(dialog).getByLabelText('输入管理员密码确认'),{target:{value:'pw'}})
 fireEvent.click(within(dialog).getByRole('button',{name:'保存授权'}))
 await screen.findByText('研发组')
 const post=calls.find(call=>call.init?.method==='POST' && call.url.includes('/devices/'))!
 assert.equal(post.url,'/api/admin/devices/d/grants')
 assert.deepEqual(JSON.parse(String(post.init?.body)),{subject_type:'group',subject_id:'g',access_level:'edit'})
 fireEvent.click(await screen.findByRole('button',{name:'撤销'}))
 const revoke=screen.getByRole('dialog',{name:'撤销设备授权'})
 fireEvent.change(within(revoke).getByLabelText('输入管理员密码确认'),{target:{value:'pw'}})
 fireEvent.click(within(revoke).getByRole('button',{name:'撤销授权'}))
 await waitFor(()=>assert.ok(calls.some(call=>call.url==='/api/admin/devices/d/grants/group/g' && call.init?.method==='DELETE')))
})

test('grant search keeps the selected recipient and hides pagination for a single page', async () => {
  const calls: string[] = []
  globalThis.fetch = async input => {
    const url = String(input); calls.push(url)
    return Response.json({ subjects: url.includes('q=missing') ? [] : [{ id: 'alice', name: 'Alice' }], total: url.includes('q=missing') ? 0 : 1 })
  }
  render(<AdminProjectGrantDialog projectId="p" name="演示项目" csrf="token" onClose={() => {}} onSaved={() => {}} />)
  const dialog = screen.getByRole('dialog', { name: '授予项目访问' })
  assert.ok(within(dialog).getByLabelText('输入管理员密码确认').closest('.gateway-modal-footer'), 'administrator confirmation belongs beside save actions')
  fireEvent.click(await within(dialog).findByRole('checkbox', { name: 'Alice' }))
  assert.equal(within(dialog).queryByRole('button', { name: '下一页' }), null)
  fireEvent.change(within(dialog).getByLabelText('搜索授权对象'), { target: { value: 'missing' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '搜索' }))
  await within(dialog).findByText('没有匹配的用户，请尝试其他关键词。')
  assert.ok(within(dialog).getByText('已选择：Alice · 只读'))
  fireEvent.change(within(dialog).getByLabelText('对象类型'), { target: { value: 'group' } })
  await waitFor(() => assert.ok(calls.some(url => url.includes('subject_type=group'))))
  assert.ok(within(dialog).getByText('请选择授权对象'))
  assert.equal((within(dialog).getByRole('button', { name: '保存授权' }) as HTMLButtonElement).disabled, true)
})


test('project authorization saves multiple recipients and retries only failed grants', async () => {
  const saved: string[] = []
  let fail = true
  let completed = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.includes('project-grant-subjects')) return Response.json({ subjects: [{ id: 'a', name: 'Alice' }, { id: 'b', name: 'Bob' }], total: 2 })
    if (url === '/api/auth/step-up') return Response.json({})
    if (init?.method === 'POST') {
      const id = JSON.parse(String(init.body)).subject_id
      saved.push(id)
      return id === 'b' && fail ? Response.json({}, { status: 500 }) : Response.json({ id })
    }
    return Response.json({ password_confirmation_required: false })
  }
  render(<AdminProjectGrantDialog projectId="p" csrf="csrf" onClose={() => {}} onSaved={() => completed++} />)
  const dialog = screen.getByRole('dialog', { name: '授予项目访问' })
  assert.ok(within(dialog).getByLabelText('输入管理员密码确认').closest('.gateway-modal-footer'), 'administrator confirmation belongs beside save actions')
  fireEvent.click(await within(dialog).findByRole('checkbox', { name: 'Alice' }))
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Bob' }))
  const password = within(dialog).queryByLabelText('输入管理员密码确认')
  if (password) fireEvent.change(password, { target: { value: 'pw' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '保存授权' }))
  await within(dialog).findByRole('alert')
  assert.deepEqual(saved, ['a', 'b'])
  assert.equal(completed, 0)
  fail = false
  fireEvent.click(within(dialog).getByRole('button', { name: '重试未成功对象' }))
  await waitFor(() => assert.equal(completed, 1))
  assert.deepEqual(saved, ['a', 'b', 'b'])
})

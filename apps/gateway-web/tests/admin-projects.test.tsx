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

test('project management searches metadata and grants and revokes access', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  let grants: Array<{ id: string; subject_type: string; subject_id: string;
    subject_name: string; access_level: string }> = []
  let groupRules: Array<{ id: string; group_id: string; group_name: string; effect: string }> = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    requests.push({ url, init })
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
    if (url.startsWith('/api/admin/projects?')) return Response.json({ projects: [{
      id: 'project-1', name: 'Platform', device_id: 'pc-1', device_name: 'Host PC',
      device_online: false, publisher: 'owner', published_at: '2026-01-01',
      grant_users: grants.length, grant_groups: 0,
      grant_levels: { read: grants.length, edit: 0 }, running_tasks: null,
    }], total: 1 })
    if (url === '/api/admin/projects/project-1/grants' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      grants = [{ id: 'grant-1', subject_type: body.subject_type, subject_id: body.subject_id,
        subject_name: 'alice', access_level: body.access_level }]
      return Response.json({ id: 'grant-1' })
    }
    if (url === '/api/admin/projects/project-1/grants') return Response.json({ grants })
    if (url === '/api/admin/projects/project-1/task-create-users') return Response.json({ assignments: [] })
    if (url === '/api/admin/projects/project-1/task-create-groups' && init?.method === 'GET') {
      return Response.json({ assignments: groupRules })
    }
    if (url === '/api/admin/projects/project-1/task-create-groups') return Response.json({ assignments: groupRules })
    if (url === '/api/admin/projects/project-1/task-create-groups/group-1' && init?.method === 'POST') {
      groupRules = [{ id: 'rule-1', group_id: 'group-1', group_name: 'Engineering', effect: 'allow' }]
      return Response.json({ id: 'rule-1' })
    }
    if (url === '/api/admin/projects/project-1/task-create-groups/group-1' && init?.method === 'DELETE') {
      groupRules = []
      return new Response(null, { status: 204 })
    }
    if (url.startsWith('/api/admin/project-grant-subjects?')) return Response.json(url.includes('subject_type=group')
      ? { subjects: [{ id: 'group-1', name: 'Engineering' }], total: 1 }
      : { subjects: [{ id: 'user-1', name: 'alice' }], total: 1 })
    if (url === '/api/auth/step-up') return Response.json({})
    if (url === '/api/admin/projects/project-1/grants/user/user-1') {
      grants = []
      return new Response(null, { status: 204 })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter><AdminProjectsPage /></MemoryRouter>)
  await screen.findByText(/Host PC/)
  assert.match(document.body.textContent ?? '', /管理权限不会自动授予项目内容访问/)
  fireEvent.change(screen.getByLabelText('搜索项目或宿主电脑'), { target: { value: 'Platform' } })
  fireEvent.click(screen.getByRole('button', { name: '搜索' }))
  await waitFor(() => assert.ok(requests.some(request => request.url.includes('q=Platform'))))
  fireEvent.click(screen.getByRole('button', { name: '管理授权' }))
  const tabs = screen.getByRole('tablist', { name: '项目设置' })
  assert.equal(within(tabs).getByRole('tab', { name: '访问授权' }).getAttribute('aria-selected'), 'true')
  assert.equal(within(tabs).getByRole('tab', { name: '任务创建能力' }).getAttribute('aria-selected'), 'false')
  assert.equal(requests.some(request => request.url.includes('/task-create-users')), false)
  await screen.findByText('尚无访问授权。')
  fireEvent.click(screen.getByRole('button', { name: '新增授权' }))
  const dialog = screen.getByRole('dialog', { name: '授予项目访问' })
  fireEvent.change(within(dialog).getByLabelText('对象类型'), { target: { value: 'group' } })
  await within(dialog).findByRole('radio', { name: 'Engineering' })
  fireEvent.change(within(dialog).getByLabelText('对象类型'), { target: { value: 'user' } })
  await within(dialog).findByRole('radio', { name: 'alice' })
  fireEvent.click(within(dialog).getByRole('radio', { name: 'alice' }))
  assert.match(dialog.textContent ?? '', /已选择：alice/)
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
  const discard = screen.getByRole('dialog', { name: '放弃项目授权修改' })
  fireEvent.click(within(discard).getByRole('button', { name: '取消' }))
  assert.ok(screen.getByRole('dialog', { name: '授予项目访问' }))
  fireEvent.change(within(dialog).getByLabelText('输入管理员密码确认'), { target: { value: 'password' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '保存授权' }))
  await screen.findByText(/用户 · 只读/)
  const posted = requests.find(request => request.url === '/api/admin/projects/project-1/grants'
    && request.init?.method === 'POST')
  assert.deepEqual(JSON.parse(String(posted?.init?.body)), {
    subject_type: 'user', subject_id: 'user-1', access_level: 'read',
  })
  fireEvent.click(screen.getByRole('button', { name: '撤销' }))
  const revoke = screen.getByRole('dialog', { name: '撤销项目授权' })
  fireEvent.change(within(revoke).getByLabelText('输入管理员密码确认'), { target: { value: 'password' } })
  fireEvent.click(within(revoke).getByRole('button', { name: '撤销授权' }))
  await waitFor(() => assert.ok(requests.some(request => request.url.endsWith('/grants/user/user-1'))))
  fireEvent.click(within(tabs).getByRole('tab', { name: '任务创建能力' }))
  assert.equal(within(tabs).getByRole('tab', { name: '任务创建能力' }).getAttribute('aria-selected'), 'true')
  assert.equal(screen.queryByRole('button', { name: '新增授权' }), null)
  await waitFor(() => assert.ok(requests.some(request => request.url.includes('/task-create-users'))))
  fireEvent.click(screen.getByRole('button', { name: '配置能力' }))
  const capability = screen.getByRole('dialog', { name: '授予任务创建能力' })
  fireEvent.change(within(capability).getByLabelText('对象类型'), { target: { value: 'group' } })
  await within(capability).findByRole('option', { name: 'Engineering' })
  fireEvent.change(within(capability).getByLabelText('能力对象'), { target: { value: 'group-1' } })
  fireEvent.change(within(capability).getByLabelText('输入管理员密码确认'), { target: { value: 'password' } })
  fireEvent.click(within(capability).getByRole('button', { name: '保存能力' }))
  await screen.findByText(/用户组 · 允许创建/)
  fireEvent.click(screen.getByRole('button', { name: '撤销规则' }))
  const revokeRule = screen.getByRole('dialog', { name: '撤销任务创建能力' })
  fireEvent.change(within(revokeRule).getByLabelText('输入管理员密码确认'), { target: { value: 'password' } })
  fireEvent.click(within(revokeRule).getByRole('button', { name: '撤销规则' }))
  await waitFor(() => assert.ok(requests.some(request => request.url.endsWith('/task-create-groups/group-1')
    && request.init?.method === 'DELETE')))
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
 await within(dialog).findByRole('radio',{name:'研发组'})
 fireEvent.click(within(dialog).getByRole('radio',{name:'研发组'}))
 assert.equal(within(dialog).queryByRole('option',{name:'只读'}),null)
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
  fireEvent.click(await within(dialog).findByRole('radio', { name: 'Alice' }))
  assert.equal(within(dialog).queryByRole('button', { name: '下一页' }), null)
  fireEvent.change(within(dialog).getByLabelText('搜索授权对象'), { target: { value: 'missing' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '搜索' }))
  await within(dialog).findByText('没有匹配的用户，请尝试其他关键词。')
  assert.ok(within(dialog).getByText('已选择：Alice · 只读'))
  fireEvent.change(within(dialog).getByLabelText('对象类型'), { target: { value: 'group' } })
  await waitFor(() => assert.ok(calls.some(url => url.includes('subject_type=group'))))
  assert.ok(within(dialog).getByText('请选择一个授权对象'))
  assert.equal((within(dialog).getByRole('button', { name: '保存授权' }) as HTMLButtonElement).disabled, true)
})

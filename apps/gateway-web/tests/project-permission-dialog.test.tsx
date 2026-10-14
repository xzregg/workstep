import assert from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import { JSDOM } from 'jsdom'
import { ProjectPermissionDialog } from '../src/ProjectPermissionDialog'
const dom = new JSDOM('<html><body></body></html>', { url: 'https://gateway.test' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, render, screen, fireEvent, waitFor } = await import('@testing-library/react')
const oldFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = oldFetch })
const catalog = [
 { id: 'task.read', name: '查看任务', description: '查看结果', category: '任务' },
 { id: 'task.create', name: '创建任务', description: '提交需求', category: '任务' },
 { id: 'workflow.edit', name: '编辑流程', description: '修改步骤', category: '流程' },
]
const sets = [ { id: 'creator', name: '任务创建者', description: '提交任务', permissions: ['task.read', 'task.create'] },
 { id: 'editor', name: '项目编辑者', description: '编辑项目', permissions: catalog.map(item => item.id) } ]
test('merged editor assigns a group set, custom denial and retries a failed atomic save', async () => {
 let fail = true, saved = 0
 const posts: object[] = []
 globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (url.includes('subjects')) return Response.json({ subjects: [{ id: 'group', name: '协作组' }], total: 1 })
  if (url.includes('/resources')) return Response.json({ resources: [{ id: 'project', name: '演示项目' }], total: 1 })
  if (url.endsWith('/step-up')) return Response.json({})
  if (url.endsWith('/project-set')) { posts.push(JSON.parse(String(init?.body))); return fail ? Response.json({ error: { message: '保存失败' } }, { status: 503 }) : Response.json({ id: 'project:grant' }) }
  throw Error(url)
 }
 render(<ProjectPermissionDialog catalog={catalog} sets={sets} csrf="csrf" onClose={() => {}} onSaved={() => saved++} />)
 assert.equal(screen.queryByRole('checkbox', { name: '创建任务' }), null)
 assert.ok(screen.getByText('请先选择授权对象，再配置对应权限。'))
 assert.equal((screen.getByRole('button', { name: '保存权限' }) as HTMLButtonElement).disabled, true)
 fireEvent.change(screen.getByLabelText('对象类型'), { target: { value: 'group' } })
 await screen.findByRole('checkbox', { name: '协作组' })
 await screen.findByRole('checkbox', { name: '演示项目', hidden: true })
 fireEvent.click(screen.getByRole('checkbox', { name: '协作组' }))
 fireEvent.click(screen.getByRole('checkbox', { name: '演示项目', hidden: true }))
 fireEvent.click(screen.getByRole('button', { name: /项目编辑者/ }))
 fireEvent.change(screen.getByRole('searchbox', { name: '搜索权限' }), { target: { value: 'workflow' } })
 fireEvent.change(screen.getByLabelText('正在配置的规则'), { target: { value: 'deny' } })
 fireEvent.click(screen.getByRole('checkbox', { name: '编辑流程' }))
 assert.ok(screen.getByText('自定义权限'))
 assert.ok(screen.getByRole('button', { name: '移除编辑流程' }))
 fireEvent.change(screen.getByLabelText('输入管理员密码确认'), { target: { value: 'password' } })
 fireEvent.click(screen.getByRole('button', { name: '保存权限' }))
 await screen.findByText(/演示项目：保存失败/)
 assert.equal((screen.getByRole('checkbox', { name: '协作组' }) as HTMLInputElement).checked, true)
 fail = false; fireEvent.click(screen.getByRole('button', { name: '保存权限' }))
 await waitFor(() => assert.equal(saved, 1))
 assert.deepEqual(posts[0], { subject_type: 'group', subject_id: 'group', project_id: 'project', allow: ['task.read', 'task.create'], deny: ['workflow.edit'] })
 assert.deepEqual(posts[0], posts[1])
})
test('closing a modified project policy opens confirmation above the native editor and preserves it on cancel', () => {
 const prototype = dom.window.HTMLDialogElement.prototype
 const originalShow = Object.getOwnPropertyDescriptor(prototype, 'showModal')
 const originalClose = Object.getOwnPropertyDescriptor(prototype, 'close')
 const layers: HTMLDialogElement[] = []
 Object.defineProperty(prototype, 'showModal', { configurable: true, value: function(this: HTMLDialogElement) { this.setAttribute('open', ''); layers.push(this) } })
 Object.defineProperty(prototype, 'close', { configurable: true, value: function(this: HTMLDialogElement) { this.removeAttribute('open') } })
 try {
 globalThis.fetch = async () => Response.json({ subjects: [], resources: [], total: 0 })
 let closed = 0
 render(<ProjectPermissionDialog catalog={catalog} sets={sets} csrf="csrf" subjectPreset={{type: 'user', id: 'u', name: '张三'}} preset={{scope_type: 'project', scope_id: 'p', scope_name: '项目'}} onClose={() => closed++} onSaved={() => {}} />)
 fireEvent.click(screen.getByRole('checkbox', { name: '创建任务' }))
 screen.getByRole('button', { name: '关闭弹窗' }).focus()
 fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' }))
 const editor = screen.getByRole('dialog', { name: '分配权限' })
 const confirmation = screen.getByRole('dialog', { name: '放弃权限修改' })
 assert.ok(confirmation instanceof dom.window.HTMLDialogElement, 'confirmation must join the native top layer')
 assert.equal(layers[0], editor)
 assert.equal(layers.at(-1), confirmation)
 assert.equal(closed, 0)
 fireEvent(confirmation, new dom.window.Event('cancel', { cancelable: true }))
 assert.equal(screen.queryByRole('dialog', { name: '放弃权限修改' }), null)
 assert.ok(editor.hasAttribute('open'))
 assert.equal(closed, 0)
 assert.equal(document.activeElement, screen.getByRole('button', { name: '关闭弹窗' }))
 fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' }))
 fireEvent.click(screen.getByRole('dialog', { name: '放弃权限修改' }).querySelector('.gateway-dialog-cancel')!)
 assert.equal(screen.queryByRole('dialog', { name: '放弃权限修改' }), null)
 fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' }))
 fireEvent.click(screen.getByRole('button', { name: '放弃并关闭' }))
 assert.equal(closed, 1)
 } finally {
  cleanup()
  if (originalShow) Object.defineProperty(prototype, 'showModal', originalShow); else Reflect.deleteProperty(prototype, 'showModal')
  if (originalClose) Object.defineProperty(prototype, 'close', originalClose); else Reflect.deleteProperty(prototype, 'close')
 }
})

test('permission management opens the merged project editor and keeps platform grants separate', async () => {
 const { MemoryRouter } = await import('react-router-dom')
 const { AdminPermissionsPage } = await import('../src/AdminPermissionsPage')
 globalThis.fetch = async input => {
  const url = String(input)
  if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
  if (url.endsWith('/catalog')) return Response.json({
   permissions: [{ id: 'task.create', name: '创建任务', category: '业务操作', scopes: ['global','project'], effects: ['allow','deny'] },
    { id: 'admin.super_admin', name: '超级管理员', category: '平台管理', scopes: ['platform'], effects: ['allow'] }],
   project_permissions: catalog, project_permission_sets: sets,
  })
  if (url.includes('subjects')) return Response.json({ subjects: [], total: 0 })
  if (url.includes('/resources')) return Response.json({ resources: [], total: 0 })
  return Response.json({ assignments: [
  { id: 'admin:1', subject_type: 'user', subject_id: 'admin', subject_name: '仅平台管理员', permission: 'admin.super_admin', scope_type: 'platform', scope_id: null, scope_name: '整个平台', effect: 'allow' },
 ] })
 }
 render(<MemoryRouter><AdminPermissionsPage /></MemoryRouter>)
 await waitFor(() => assert.equal((screen.getByRole('button', { name: '分配权限' }) as HTMLButtonElement).disabled, false))
 assert.equal(screen.queryByText('仅平台管理员'), null)
 fireEvent.click(screen.getByRole('button', { name: '分配权限' }))
 assert.ok(screen.getByRole('complementary', { name: '用户组树' }))
 assert.equal(screen.queryByRole('navigation', { name: '功能分类' }), null)
 fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' }))
 fireEvent.click(screen.getByRole('button', { name: '资源与业务权限' }))
 assert.ok(screen.getByRole('group', { name: '权限（可多选）' }))
 assert.equal(screen.queryByRole('checkbox', { name: '超级管理员' }), null)
 assert.equal(screen.queryByRole('navigation', { name: '功能分类' }), null)
})

 test('platform permission page separates both its assignments and its catalog from user resource grants', async () => {
 const { MemoryRouter } = await import('react-router-dom')
 const { AdminPermissionsPage } = await import('../src/AdminPermissionsPage')
 globalThis.fetch = async input => {
  const url = String(input)
  if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
  if (url.endsWith('/catalog')) return Response.json({ permissions: [
   { id: 'task.create', name: '创建任务', category: '业务操作', scopes: ['global'], effects: ['allow','deny'] },
   { id: 'admin.super_admin', name: '超级管理员', category: '平台管理', scopes: ['platform'], effects: ['allow'] },
  ], project_permissions: catalog, project_permission_sets: sets })
  if (url.includes('subjects')) return Response.json({ subjects: [], total: 0 })
  return Response.json({ assignments: [
   { id: 'capability:1', subject_type: 'user', subject_id: 'resource', subject_name: '资源用户', permission: 'task.create', scope_type: 'global', scope_id: null, scope_name: '全局', effect: 'allow' },
   { id: 'admin:1', subject_type: 'user', subject_id: 'admin', subject_name: '平台管理员', permission: 'admin.super_admin', scope_type: 'platform', scope_id: null, scope_name: '整个平台', effect: 'allow' },
  ] })
 }
 render(<MemoryRouter><AdminPermissionsPage mode="platform" /></MemoryRouter>)
 await screen.findByText('平台管理员')
 assert.equal(screen.queryByText('资源用户'), null)
 assert.equal(screen.queryByRole('button', { name: '资源与业务权限' }), null)
 fireEvent.click(screen.getByRole('button', { name: '分配平台权限' }))
 assert.ok(screen.getByRole('checkbox', { name: '超级管理员' }))
 assert.equal(screen.queryByRole('checkbox', { name: '创建任务' }), null)
 assert.equal(screen.queryByLabelText('权限集合'), null)
 })

 test('project permission link restores the recipient and saved policy rather than a default set', async () => {
 const { MemoryRouter } = await import('react-router-dom')
 const { AdminPermissionsPage } = await import('../src/AdminPermissionsPage')
 globalThis.fetch = async input => {
  const url = String(input)
  if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
  if (url.endsWith('/catalog')) return Response.json({ permissions: [{ id: 'project.edit', name: '编辑项目' }], project_permissions: catalog, project_permission_sets: sets })
  if (url.includes('/resources')) return Response.json({ resources: [{ id: 'project', name: '项目' }], total: 1 })
  return Response.json({ assignments: [{ id: 'project:grant', subject_type: 'user', subject_id: 'u', subject_name: '张三', permission: 'project.edit', scope_type: 'project', scope_id: 'project', scope_name: '项目', effect: 'allow', ui_permissions: { allow: ['task.read'], deny: ['workflow.edit'] } }] })
 }
 render(<MemoryRouter initialEntries={['/admin/permissions?scope_type=project&scope_id=project&subject_type=user&subject_id=u&subject_name=张三&assign=1']}><AdminPermissionsPage /></MemoryRouter>)
 await screen.findByRole('dialog', { name: '调整项目权限' })
 assert.equal((screen.getByRole('checkbox', { name: '创建任务' }) as HTMLInputElement).checked, false)
 assert.ok(screen.getByRole('button', { name: '移除编辑流程' }))
 assert.equal(screen.queryByLabelText('搜索授权对象'), null)
 })

 test('multiple projects preserve selection through search and retry only failed grants', async () => {
 const posts: string[] = []; let fail = true, saved = 0
 globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (url.includes('/resources')) return Response.json({resources: url.includes('q=second') ? [{id:'p2', name:'第二项目'}] : [{id:'p1',name:'第一项目'}],total:1})
  if (url.endsWith('/step-up')) return Response.json({})
  if (url.endsWith('/project-set')) { const id = JSON.parse(String(init?.body)).project_id; posts.push(id); return id === 'p2' && fail ? Response.json({error:{message:'第二项目保存失败'}},{status:503}) : Response.json({}) }
  return Response.json({subjects:[],groups:[],total:0})
 }
 render(<ProjectPermissionDialog catalog={catalog} sets={sets} csrf="csrf" subjectPreset={{type:'user',id:'u',name:'张三'}} onClose={() => {}} onSaved={() => saved++} />)
 fireEvent.click(await screen.findByRole('checkbox',{name:'第一项目',hidden:true}))
 const search = screen.getByLabelText('搜索指定项目')
 fireEvent.change(search,{target:{value:'second'}})
 fireEvent.submit(search.closest('form')!)
 fireEvent.click(await screen.findByRole('checkbox',{name:'第二项目',hidden:true}))
 fireEvent.change(screen.getByLabelText('输入管理员密码确认'),{target:{value:'password'}})
 fireEvent.click(screen.getByRole('button',{name:'保存权限'}))
 await screen.findByText(/第二项目保存失败/)
 assert.deepEqual(posts,['p1','p2']); assert.equal(saved,0)
 assert.equal(screen.getByRole('checkbox',{name:'创建任务'}).matches(':disabled'),true)
 fail = false
 fireEvent.click(screen.getByRole('button',{name:'保存权限'}))
 await waitFor(() => assert.equal(saved,1))
 assert.deepEqual(posts,['p1','p2','p2'])
 })

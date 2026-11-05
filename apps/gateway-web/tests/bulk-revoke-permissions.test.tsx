import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'
import { AdminPermissionsPage } from '../src/AdminPermissionsPage'
import { BulkRevokePermissionDialog } from '../src/BulkRevokePermissionDialog'
import { PermissionSubjectTable } from '../src/PermissionSubjectTable'

const dom = new JSDOM('<html><body></body></html>', { url: 'https://gateway.test/admin/permissions' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, Event: dom.window.Event })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })


const rule = (id: string, subject_type: 'user' | 'group' = 'user', subject_name = '张三') => ({
 id, subject_type, subject_id: 'same', subject_name, permission: 'task.create', scope_type: 'global', scope_id: null, scope_name: '全局', effect: 'allow' as const,
})

test('subject selection includes collapsed rules and supports partial rule selection and select all', async () => {
 const rows = [rule('capability:1'), rule('device_user:2'), rule('group_capability:3', 'group', '研发组')]
 render(<PermissionSubjectTable assignments={rows} name={()=>'创建任务'} canEdit canRevoke csrf="csrf" onChanged={()=>{}} onEdit={()=>{}} onRevoke={()=>{}}/>)
 fireEvent.click(screen.getByRole('checkbox', {name:'选择张三的全部规则'}))
 assert.ok(screen.getByText('已选 2 条规则'))
 fireEvent.click(screen.getAllByRole('button', {name:'查看规则'})[0])
 const checked = screen.getAllByRole('checkbox', {name:/选择规则/})
 assert.equal((checked[0] as HTMLInputElement).checked, true)
 fireEvent.click(checked[0])
 assert.equal((screen.getByRole('checkbox', {name:'选择张三的全部规则'}) as HTMLInputElement).indeterminate, true)
 fireEvent.click(screen.getByRole('checkbox', {name:'全选当前表格'}))
 assert.ok(screen.getByText('已选 3 条规则'))
 fireEvent.click(screen.getByRole('button', {name:'批量撤销'}))
 const dialog = screen.getByRole('dialog', {name:'批量撤销权限'})
 assert.ok(within(dialog).getByText(/3 条直接授权规则/))
 assert.equal(within(dialog).getAllByRole('listitem').length, 3)
 fireEvent.click(within(dialog).getByRole('button', {name:'取消'}))
 assert.equal(screen.queryByRole('dialog'), null)
 assert.ok(screen.getByText('已选 3 条规则'))
})

test('bulk revoke verifies administrator, prevents duplicates and retries only remaining rules', async () => {
 const deletes: string[] = []; let attempts = 0; let finished: string[] | undefined
 globalThis.fetch = async (input, init) => {
  if (String(input) === '/api/auth/step-up') return Response.json({})
  assert.equal(init?.method, 'DELETE')
  assert.equal(new Headers(init?.headers).get('X-CSRF-Token'), 'csrf')
  const id = decodeURIComponent(String(input).split('/').at(-1)!)
  deletes.push(id)
  if (id === 'role:2' && attempts++ === 0) return Response.json({error:{message:'保留管理员权限'}}, {status:409})
  return new Response(null, {status:204})
 }
 render(<BulkRevokePermissionDialog assignments={[rule('capability:1'), rule('role:2')]} name={()=>'创建任务'} csrf="csrf" onFinished={ids=>{finished=ids}}/>)
 const button = screen.getByRole('button', {name:'撤销所选权限'})
 assert.equal((button as HTMLButtonElement).disabled, true)
 fireEvent.change(screen.getByLabelText('输入管理员密码确认'), {target:{value:'password'}})
 fireEvent.click(button); fireEvent.click(button)
 await screen.findByText(/保留管理员权限/)
 assert.equal(finished, undefined)
 assert.ok(screen.getByText(/已处理 1/))
 fireEvent.click(screen.getByRole('button', {name:'重试剩余权限'}))
 await waitFor(()=>assert.deepEqual(finished, ['capability:1','role:2']))
 assert.deepEqual(deletes, ['capability:1','role:2','role:2'])
})

test('closing after partial success reports completed rules so the owner refreshes', async () => {
 let completed: string[] | undefined
 globalThis.fetch = async (input) => String(input).includes('step-up') ? Response.json({})
  : String(input).endsWith('capability%3A1') ? new Response(null, {status:204}) : new Response(null, {status:403})
 render(<BulkRevokePermissionDialog assignments={[rule('capability:1'),rule('role:2')]} name={()=>'创建任务'} csrf="csrf" onFinished={ids=>{completed=ids}}/>)
 fireEvent.change(screen.getByLabelText('输入管理员密码确认'), {target:{value:'password'}})
 fireEvent.click(screen.getByRole('button', {name:'撤销所选权限'}))
 await screen.findByRole('alert')
 fireEvent.click(screen.getByRole('button', {name:'取消'}))
 assert.deepEqual(completed, ['capability:1'])
})


test('permission page revokes only selected visible rules and refreshes, changing filter clears selection', async () => {
 let rows = [rule('capability:1'), {...rule('role:2'), permission:'admin.audit'}, rule('group_capability:3', 'group', '研发组')]
 const deleted: string[] = []
 globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (url === '/api/auth/session') return Response.json({csrf_token:'csrf'})
  if (url === '/api/auth/step-up') return Response.json({})
  if (url.endsWith('/catalog')) return Response.json({permissions:[{id:'task.create',name:'创建任务',category:'业务',scopes:['global'],effects:['allow','deny']}, {id:'admin.audit',name:'审计',category:'平台',scopes:['platform'],effects:['allow']}]})
  if (url.includes('/subjects?')) return Response.json({subjects:[],total:0})
  if (init?.method === 'DELETE') {
   const id = decodeURIComponent(url.split('/').at(-1)!)
   deleted.push(id); rows = rows.filter(row=>row.id!==id)
   return new Response(null, {status:204})
  }
  const type = new URL(url, 'https://gateway.test').searchParams.get('subject_type')
  return Response.json({assignments:rows.filter(row=>!type || row.subject_type===type)})
 }
 render(<MemoryRouter><AdminPermissionsPage/></MemoryRouter>)
 await screen.findByText('研发组')
 fireEvent.click(screen.getByRole('checkbox', {name:'全选当前表格'}))
 assert.ok(screen.getByText('已选 2 条规则'))
 fireEvent.change(screen.getByLabelText('对象类型筛选'), {target:{value:'group'}})
 await screen.findByText('研发组')
 await waitFor(()=>assert.equal(screen.queryByText('张三'), null))
 assert.ok(screen.getByText('已选 0 条规则'))
 fireEvent.click(screen.getByRole('checkbox', {name:'全选当前表格'}))
 await screen.findByText('已选 1 条规则')
 fireEvent.click(screen.getByRole('button', {name:'批量撤销'}))
 fireEvent.change(screen.getByLabelText('输入管理员密码确认'), {target:{value:'password'}})
 fireEvent.click(screen.getByRole('button', {name:'撤销所选权限'}))
 await screen.findByText(/当前条件下尚无权限规则/)
 assert.deepEqual(deleted, ['group_capability:3'])
 assert.equal(screen.queryByRole('dialog'), null)
})

test('failed administrator verification sends no revoke requests and can be retried', async () => {
 let deletes = 0; let valid = false; let finished = false
 globalThis.fetch = async (input, init) => {
  if (String(input) === '/api/auth/step-up') return new Response(null, {status:valid ? 200 : 403})
  assert.equal(init?.method, 'DELETE'); deletes++
  return new Response(null, {status:204})
 }
 render(<BulkRevokePermissionDialog assignments={[rule('capability:1')]} name={()=>'创建任务'} csrf="csrf" onFinished={()=>{finished=true}}/>)
 fireEvent.change(screen.getByLabelText('输入管理员密码确认'), {target:{value:'wrong'}})
 fireEvent.click(screen.getByRole('button', {name:'撤销所选权限'}))
 await screen.findByRole('alert')
 assert.equal(deletes, 0)
 valid = true
 fireEvent.click(screen.getByRole('button', {name:'撤销所选权限'}))
 await waitFor(()=>assert.equal(finished, true))
 assert.equal(deletes, 1)
})

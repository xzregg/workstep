import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { PasswordConfirmationRequired } from '../src/PasswordConfirmation'
import { AdminBulkActionDialog } from '../src/AdminBulkActionDialog'
import { AdminDeviceActionDialog } from '../src/AdminDeviceActionDialog'
import { AdminRevokeRoleDialog } from '../src/AdminRoleDialogs'
import { AdminProviderDisableDialog } from '../src/AdminProviderEditorDialog'
import { AdminSkillActionDialog } from '../src/AdminSkillActionDialog'

const dom = new JSDOM('<html><body></body></html>', { url: 'https://gateway.test/' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, Event: dom.window.Event })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { render, screen, fireEvent, waitFor, cleanup } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

for (const kind of ['purge-users', 'purge-groups', 'device', 'role', 'provider', 'skill']) {
  test(`scan session performs ${kind} without password fields or step-up requests`, async () => {
    const calls: string[] = []
    let done = false
    globalThis.fetch = async (input, init) => {
      calls.push(String(input))
      assert.notEqual(String(input), '/api/auth/step-up')
      assert.equal((init?.headers as Record<string,string>)['X-CSRF-Token'], 'csrf')
      return Response.json({})
    }
    const saved = () => { done = true }
    const close = () => {}
    const element = kind.startsWith('purge') ? <AdminBulkActionDialog csrf="csrf" onClose={close} onDone={saved}
      action={{ title:'回收站彻底删除', label:'确认彻底删除', message:'无法恢复', password:true,
        url:`/api/admin/${kind === 'purge-users' ? 'users' : 'groups'}/bulk`, body:{ action:'purge', ids:['one'] } }} />
      : kind === 'device' ? <AdminDeviceActionDialog csrf="csrf" onClose={close} onComplete={saved} action="disable"
        device={{ id:'d', name:'设备', status:'active', online:true, version:null, app_instance_id:null }} />
      : kind === 'role' ? <AdminRevokeRoleDialog csrf="csrf" onClose={close} onComplete={saved}
        role={{ id:'r', display_name:'用户', role:'identity_admin' } as any} />
      : kind === 'provider' ? <AdminProviderDisableDialog csrf="csrf" onClose={close} onSaved={saved}
        provider={{ id:'p', name:'供应商' } as any} />
      : <AdminSkillActionDialog csrf="csrf" onClose={close} onDone={saved}
        action={{kind:'approve',skillId:'s',versionId:'v',version:'1.0'}} />
    render(<PasswordConfirmationRequired.Provider value={false}>{element}</PasswordConfirmationRequired.Provider>)
    assert.equal(document.querySelector('input[type=password]'), null)
    assert.ok(screen.getByRole('button', {name:'取消'}))
    const confirm = screen.getAllByRole('button').find(button => button.textContent !== '取消')!
    assert.equal((confirm as HTMLButtonElement).disabled, false)
    fireEvent.click(confirm)
    await waitFor(() => assert.equal(done, true))
    assert.equal(calls.length, 1)
  })
}

test('password login still requires input and a successful password proof', async () => {
  const calls: string[] = []
  let done = false
  globalThis.fetch = async input => { calls.push(String(input)); return Response.json({}) }
  render(<AdminBulkActionDialog csrf="csrf" onClose={()=>{}} onDone={()=>{done=true}}
    action={{title:'删除',label:'确认删除',message:'确认',password:true,url:'/api/admin/users/bulk',body:{action:'purge'}}}/>)
  const confirm = screen.getByRole('button',{name:'确认删除'}) as HTMLButtonElement
  assert.equal(confirm.disabled,true)
  fireEvent.change(screen.getByLabelText('输入你的密码确认'),{target:{value:'pass'}})
  fireEvent.click(confirm)
  await waitFor(()=>assert.equal(done,true))
  assert.deepEqual(calls,['/api/auth/step-up','/api/admin/users/bulk'])
})

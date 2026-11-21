import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { AdminProviderModelsDialog } from '../src/AdminProviderModelsDialog'
import { useStepUpPassword } from '../src/PasswordConfirmation'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://gateway.test' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  MutationObserver: dom.window.MutationObserver, Event: dom.window.Event })
// These UI fixtures explicitly exercise Chinese error recovery.
Object.defineProperty(dom.window.navigator, 'language', { configurable: true, value: 'zh-CN' })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, fireEvent, render, screen, within } = await import('@testing-library/react')
const original = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = original })
const provider = { id: 'provider', name: 'Company', revision: 3 }

function Picker({ onClose = () => {} }: { onClose?: () => void }) {
  return <AdminProviderModelsDialog provider={provider} initialModels={['model-a']} csrf="csrf"
    authorization={useStepUpPassword()} onClose={onClose} onApply={() => assert.fail('Unexpected apply')} />
}

test('clicking fetch without a password prompts and focuses the password field before any request', async () => {
  const requests: string[] = []
  globalThis.fetch = async input => {
    const url = String(input)
    requests.push(url)
    if (url === '/api/auth/step-up') return Response.json({})
    return Response.json({ revision: 3, models: [{ id: 'model-b' }], errors: [] })
  }
  render(<Picker />)
  const fetchButton = screen.getByRole('button', { name: '获取模型' }) as HTMLButtonElement
  const passwordInput = screen.getByLabelText('输入管理员密码确认')
  assert.equal(fetchButton.disabled, false)
  fireEvent.click(fetchButton)
  assert.equal(screen.getByRole('alert').textContent, '请输入管理员密码，再获取模型。')
  assert.ok(document.activeElement === passwordInput)
  assert.deepEqual(requests, [])

  fireEvent.change(passwordInput, { target: { value: 'password' } })
  fireEvent.click(fetchButton)
  await screen.findByRole('checkbox', { name: 'model-b' })
  assert.deepEqual(requests, ['/api/auth/step-up', '/api/admin/providers/provider/models/preview'])
})

test('discovery failure preserves current selection and closing changes requires confirmation', async () => {
  let closed = 0
  globalThis.fetch = async input => String(input) === '/api/auth/step-up' ? Response.json({})
    : Response.json({ revision: 3, models: [], errors: [{ protocol: 'openai_responses', error: '读取失败' }] })
  render(<Picker onClose={() => { closed++ }} />)
  fireEvent.change(screen.getByLabelText('输入管理员密码确认'), { target: { value: 'password' } })
  fireEvent.click(screen.getByRole('button', { name: '获取模型' }))
  await screen.findByText(/读取失败/)
  assert.equal((screen.getByRole('checkbox', { name: 'model-a' }) as HTMLInputElement).checked, true)
  fireEvent.click(screen.getByRole('checkbox', { name: 'model-a' }))
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  const discard = screen.getByRole('dialog', { name: '放弃模型修改' })
  fireEvent.click(within(discard).getByRole('button', { name: '放弃并关闭' }))
  assert.equal(closed, 1)
})


test('a changed provider blocks applying models to a stale editor', async () => {
  globalThis.fetch = async (input, init) => {
    if (String(input) === '/api/auth/step-up') return Response.json({})
    assert.equal(String(input), '/api/admin/providers/provider/models/preview')
    assert.equal(init?.method, 'POST')
    return Response.json({}, { status: 409 })
  }
  render(<Picker />)
  fireEvent.change(screen.getByLabelText('输入管理员密码确认'), { target: { value: 'password' } })
  fireEvent.click(screen.getByRole('checkbox', { name: 'model-a' }))
  fireEvent.click(screen.getByRole('button', { name: '获取模型' }))
  await screen.findByText('供应商配置已变化，请重新打开供应商编辑页。')
  assert.equal((screen.getByRole('button', { name: /应用到表单/ }) as HTMLButtonElement).disabled, true)
  assert.equal((screen.getByRole('button', { name: '获取模型' }) as HTMLButtonElement).disabled, true)
})

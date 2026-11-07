import assert from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import { JSDOM } from 'jsdom'
import { AdminCompanyNameDialog } from '../src/AdminCompanyNameDialog'
import { PasswordConfirmationRequired } from '../src/PasswordConfirmation'
const dom = new JSDOM('<html><body></body></html>', { url: 'https://gateway.test' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, render, screen, fireEvent } = await import('@testing-library/react')
afterEach(cleanup)

test('routine company display changes save without password confirmation', () => {
 render(<AdminCompanyNameDialog name="旧名称" csrf="csrf" onClose={() => {}} onSaved={() => {}} />)
 assert.equal(screen.queryByLabelText('管理员密码'), null)
 const save = screen.getByRole('button', { name: '保存公司名称' }) as HTMLButtonElement
 assert.equal(save.disabled, true)
 fireEvent.change(screen.getByLabelText('公司显示名称'), { target: { value: '新名称' } })
 assert.equal(save.disabled, false)
})

test('sessions without password confirmation have no password field in the action row', () => {
 render(<PasswordConfirmationRequired.Provider value={false}><AdminCompanyNameDialog name="旧名称" csrf="csrf" onClose={() => {}} onSaved={() => {}} /></PasswordConfirmationRequired.Provider>)
 assert.equal(screen.queryByLabelText('管理员密码'), null)
 fireEvent.change(screen.getByLabelText('公司显示名称'), { target: { value: '新名称' } })
 assert.equal((screen.getByRole('button', { name: '保存公司名称' }) as HTMLButtonElement).disabled, false)
})

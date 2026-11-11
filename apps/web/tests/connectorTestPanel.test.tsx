import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import { I18nProvider } from '../src/i18n'
import { connectorApi } from '../src/api/connectors'
import ConnectorEditor from '../src/components/connectors/ConnectorEditor'
import ConnectorTestPanel from '../src/components/connectors/ConnectorTestPanel'

test('test tab uses unsaved settings, lists tools, explicitly executes and routes auth failures to configuration', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = { ...connectorApi }
  let saves = 0, calls = 0, needsAuth = false
  connectorApi.save = async () => { saves++; throw new Error('must not save') }
  connectorApi.diagnose = async (definition, invocation) => {
    calls++
    assert.equal(definition.url, 'https://example.com/draft')
    if (needsAuth) return { ok: false, status: 'auth_required', message: '需要认证', tool_count: 0, tools: [], auth_scheme: 'bearer' }
    if (invocation) assert.deepEqual(invocation, { tool_name: 'add', arguments: {} })
    return { ok: true, status: 'connected', message: '已连接', tool_count: 1,
      tools: [{ name: 'add', description: '计算求和', input_schema: { type: 'object', properties: {} } }],
      ...(invocation ? { result: { content: [{ type: 'text', text: '5' }] } } : {}) }
  }
  const click = async (selector: string) => act(async () => document.querySelector<HTMLButtonElement>(selector)!.click())
  try {
    await act(async () => root.render(<I18nProvider><ConnectorEditor initial={{ name: 'Demo', url: 'https://example.com/draft' }} onClose={() => {}} onSaved={() => {}} /></I18nProvider>))
    await click('[data-connector-tab=test]')
    assert.equal(calls, 0, 'opening test page never executes a subprocess or tool')
    await click('[data-connector-diagnose]')
    assert.equal(calls, 1)
    assert.match(document.querySelector('.connector-test-tools')!.textContent!, /add/)
    assert.equal(saves, 0, 'tests must not persist draft credentials')
    const input = async (text: string) => act(async () => {
      const field = document.querySelector<HTMLTextAreaElement>('.connector-test-invocation textarea')!
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, text)
      field.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await input('[]')
    assert.equal(document.querySelector<HTMLButtonElement>('[data-connector-invoke]')!.disabled, true)
    await input('{}')
    await click('[data-connector-invoke]')
    assert.equal(calls, 2)
    assert.match(document.querySelector('.connector-test-output')!.textContent!, /5/)
    needsAuth = true
    await click('[data-connector-diagnose]')
    assert.equal(document.querySelector('[data-connector-invoke]'), null, 'failed re-test clears old callable tools')
    await click('[data-connector-configure-auth]')
    assert.equal(document.querySelector('[data-connector-tab=config]')!.getAttribute('aria-selected'), 'true')
    assert.ok(document.querySelector('.connector-authentication'))
    assert.equal(saves, 0)
  } finally {
    Object.assign(connectorApi, original)
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('changing a draft aborts the pending test and ignores its late response', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = connectorApi.diagnose
  let finish!: (value: Awaited<ReturnType<typeof connectorApi.diagnose>>) => void
  let signal: AbortSignal | undefined
  connectorApi.diagnose = (_definition, _invocation, incomingSignal) => {
    signal = incomingSignal
    return new Promise(resolve => { finish = resolve })
  }
  const busy = () => {}
  const render = (url: string) => root.render(<I18nProvider><ConnectorTestPanel definition={{ name: 'Demo', url }} valid active onConfigureAuth={() => {}} onBusyChange={busy} /></I18nProvider>)
  try {
    await act(async () => render('https://example.com/old'))
    await act(async () => document.querySelector<HTMLButtonElement>('[data-connector-diagnose]')!.click())
    assert.equal(signal?.aborted, false)
    await act(async () => render('https://example.com/new'))
    assert.equal(signal?.aborted, true)
    await act(async () => finish({ ok: true, status: 'connected', message: 'old result', tool_count: 1, tools: [{ name: 'old', description: '', input_schema: {} }] }))
    assert.equal(document.querySelector('.connector-test-tools'), null)
    assert.equal(document.querySelector<HTMLButtonElement>('[data-connector-diagnose]')!.disabled, false)
  } finally {
    connectorApi.diagnose = original
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import App from '../src/App'
import { I18nProvider, useLocaleStore } from '../src/i18n'

for (const interactive of [false, true]) test(`Gateway public route mounts canonical task detail with scoped ${interactive ? 'interactive' : 'read-only'} access`, async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL('http://localhost:8700/share/handle')
  document.head.innerHTML = '<meta name="workstep-share-transport" content="gateway">'
  useLocaleStore.setState({ locale: 'zh-CN' })
  const originalFetch = globalThis.fetch
  const originalSocket = globalThis.WebSocket
  const calls: string[] = []
  Object.assign(globalThis, { ResizeObserver: window.ResizeObserver,
    WebSocket: class { constructor() { throw new Error('Owner websocket is forbidden') } } })
  globalThis.fetch = async (input, init) => {
    const path = String(input); calls.push(path)
    const prefix = '/api/public/shares/handle'
    if (path === prefix + '/meta') return Response.json({ title: 'Shared', mode: interactive ? 'interactive' : 'read_only', has_password: false })
    if (path === prefix + '/session') return Response.json({ csrf_token: 'restored-csrf' })
    if (path === prefix + '/unlock') return Response.json({ csrf_token: 'csrf' })
    if (path === prefix + '/task') return Response.json({ id: 'task', title: 'Gateway task', status: interactive ? 'awaiting_review' : 'pending',
      created_at: '2026-10-03T00:00:00Z', steps: [{ step_key: 'build', status: interactive ? 'awaiting_review' : 'pending', has_history: false }], workflow: null })
    if (path === prefix + '/history') return Response.json({ messages: [{ id: 'message', role: 'assistant',
      step_key: 'build', content: 'Visible execution', created_at: '2026-10-03T00:00:00Z' }], next_offset: null, interventions: interactive ? [{ interaction_id: 'permission', step_key: 'build', request: { method: 'session/request_permission', tool_call: { title: 'Review command' }, options: [{ option_id: 'once', name: '允许本次操作', kind: 'allow_once' }] } }] : [] })
    if (path === prefix + '/artifacts') return Response.json({ artifacts: [] })
    if (path === prefix + '/reviews') return Response.json({ reviews: interactive ? [{ id: 'review', step_key: 'build', mode: 'manual', status: 'pending', report: null }] : [] })
    if (path === prefix + '/steps/build/review/approve') {
      assert.equal(new Headers(init?.headers).get('X-Share-CSRF'), 'restored-csrf')
      assert.deepEqual(JSON.parse(String(init?.body)), { review_run_id: 'review' })
      return Response.json({ resumed: true })
    }
    if (path === prefix + '/interventions/permission/respond') {
      assert.equal(new Headers(init?.headers).get('X-Share-CSRF'), 'restored-csrf')
      assert.deepEqual(JSON.parse(String(init?.body)), { data: { outcome: { outcome: 'selected', option_id: 'once' } } })
      return Response.json({ delivered: true })
    }
    throw new Error(`Unscoped API: ${path}`)
  }
  const element = document.body.appendChild(document.createElement('div'))
  const root = createRoot(element)
  try {
    await act(async () => root.render(<I18nProvider><App /></I18nProvider>))
    assert.ok(element.querySelector('.task-detail-header'))
    assert.ok(element.textContent?.includes('Gateway task'))
    assert.ok(element.textContent?.includes('Visible execution'))
    assert.equal(element.querySelector('.app-shell'), null)
    if (!interactive) assert.equal(element.querySelector('.chat-input'), null)
    else {
      const approve = Array.from(element.querySelectorAll('button')).find(button => button.textContent?.trim() === '通过并进入下一步骤')
      assert.ok(approve)
      await act(async () => approve.click())
      assert.equal(calls.filter(path => path.endsWith('/review/approve')).length, 0)
      const dialog = document.querySelector('[role=dialog]')
      assert.ok(dialog)
      const confirm = Array.from(dialog.querySelectorAll('button')).find(button => button.textContent?.trim() === '确认')
      assert.ok(confirm)
      await act(async () => confirm.click())
      assert.equal(calls.filter(path => path.endsWith('/review/approve')).length, 1)
      const allow = Array.from(element.querySelectorAll('button')).find(button => button.textContent?.trim() === '允许本次操作')
      assert.ok(allow)
      await act(async () => allow.click())
      assert.equal(calls.filter(path => path.endsWith('/permission/respond')).length, 1)
    }
    assert.ok(calls.every(path => path.startsWith('/api/public/shares/handle/')))
    assert.equal(calls.filter(path => path.endsWith('/unlock')).length, 0)
  } finally {
    await act(async () => root.unmount())
    element.remove(); globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket
    await window.happyDOM.close()
  }
})

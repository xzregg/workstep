import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ChatInputUsage from '../src/components/ChatInputUsage'
import { I18nProvider } from '../src/i18n'

test('balance-only engines display actual credit balance without inventing a percentage', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><ChatInputUsage compact quota={{
      engine_id: 'custom', credits: { balance: '12.50', unit: 'USD', unlimited: false },
    }} /></I18nProvider>))
    const quota = container.querySelector<HTMLElement>('.chat-input-quota')
    assert.ok(quota)
    assert.match(quota.textContent || '', /12.50 USD/)
    assert.doesNotMatch(quota.textContent || '', /%/)
    await act(async () => root.render(<I18nProvider><ChatInputUsage compact quota={null} /></I18nProvider>))
    assert.ok(container.querySelector('.chat-input-quota') === null)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('Antigravity quota shows each model group and native time window', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><ChatInputUsage compact={false} quota={{
      engine_id:'antigravity',primary:{used_percent:15,remaining_percent:85},
      groups:[{name:'Gemini Models',windows:[{kind:'weekly',used_percent:15,remaining_percent:85,resets_at:1796181626}]},
        {name:'Claude and GPT models',windows:[{kind:'weekly',used_percent:27,remaining_percent:73},
          {kind:'five-hour',used_percent:27,remaining_percent:73}]}],
    }} /></I18nProvider>))
    assert.deepEqual([...container.querySelectorAll('.chat-input-quota-group > strong')].map(e=>e.textContent), ['Gemini Models','Claude and GPT models'])
    assert.equal(container.querySelectorAll('.chat-input-quota-group > span').length, 3)
    assert.match(container.querySelector('.chat-input-quota')?.getAttribute('aria-label') || '', /85%/)
    assert.match(container.textContent || '', /85%/)
    assert.match(container.textContent || '', /73%/)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('compact quota uses an icon and percentage while retaining an accessible label and details', async () => {
  const { window } = installDomEnvironment()
  const container = window.document.body.appendChild(window.document.createElement('div'))
  const root = createRoot(container as never)
  try {
    const render = (compact: boolean) => <I18nProvider><ChatInputUsage
      compact={compact}
      quota={{ engine_id: 'codex_sdk', primary: { used_percent: 25, remaining_percent: 75 } }}
    /></I18nProvider>
    await act(async () => root.render(render(true)))
    const quota = container.querySelector('.chat-input-quota') as HTMLElement
    const label = quota.cloneNode(true) as HTMLElement
    label.querySelector('.chat-input-quota-tip')?.remove()
    assert.equal(label.textContent, '75%')
    assert.ok(label.querySelector('svg[aria-hidden="true"]'))
    assert.match(quota.getAttribute('aria-label') || '', /75%/)
    await act(async () => quota.click())
    assert.ok(quota.classList.contains('is-tip-open'))
    assert.ok(quota.querySelector('.chat-input-quota-tip strong')?.textContent)

    await act(async () => root.render(render(false)))
    const desktopLabel = quota.cloneNode(true) as HTMLElement
    desktopLabel.querySelector('.chat-input-quota-tip')?.remove()
    assert.match(desktopLabel.textContent || '', /\S+ 75%/)
    assert.ok(desktopLabel.querySelector('svg') === null)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('chat usage owns quota and context details in toolbar order', async () => {
  const { window } = installDomEnvironment()
  const container = window.document.body.appendChild(window.document.createElement('div'))
  const root = createRoot(container as never)
  try {
    await act(async () => {
      root.render(<I18nProvider><ChatInputUsage
        compact={false}
        quota={{
          engine_id: 'codex_sdk',
          primary: { used_percent: 25, remaining_percent: 75 },
          secondary: { used_percent: 50, remaining_percent: 50 },
          individual_limit: { used: 2, limit: 10, remaining_percent: 80 },
        }}
        context={{ used: 250, total: 1000, percent: 25 }}
      /></I18nProvider>)
    })
    const quota = container.querySelector('.chat-input-quota') as HTMLElement
    const context = container.querySelector('.chat-input-context-breakdown-wrap') as HTMLElement
    assert.ok(quota)
    assert.ok(context)
    assert.ok(quota.compareDocumentPosition(context) & window.Node.DOCUMENT_POSITION_FOLLOWING)
    assert.match(quota.textContent || '', /75/)
    assert.match(quota.textContent || '', /50/)
    assert.match(quota.textContent || '', /80/)
    assert.equal(context.querySelector('.chat-input-context-ring-value')?.getAttribute('stroke-dasharray'), '25 100')

    await act(async () => quota.click())
    assert.ok(quota.classList.contains('is-tip-open'))
    await act(async () => context.click())
    assert.ok(context.classList.contains('is-tip-open'))
    await act(async () => window.document.body.click())
    assert.equal(quota.classList.contains('is-tip-open'), false)
    assert.equal(context.classList.contains('is-tip-open'), false)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


test('unified quota cards keep failures visible, show remaining meters and filter to the selected engine', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><ChatInputUsage compact={false} selectedEngine="custom" entries={[
      {engine_id: 'custom', name: 'Custom', supported: true, status: 'ok', quota: {engine_id: 'custom', groups: [
        {name: 'Gemini', windows: [{kind: 'weekly', remaining_percent: 83, used_percent: 17}]},
      ]}},
      {engine_id: 'other', supported: true, status: 'unauthenticated', quota: null},
    ]} /></I18nProvider>))
    await act(async () => (container.querySelector('.chat-input-quota') as HTMLElement).click())
    assert.equal(container.querySelectorAll('[data-quota-engine]').length, 1)
    assert.equal(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'), '83')
    await act(async () => (container.querySelector('[data-quota-all]') as HTMLButtonElement).click())
    assert.equal(container.querySelectorAll('[data-quota-engine]').length, 2)
    assert.match(container.textContent || '', /Sign in required|登录/)
    assert.equal(container.querySelector('.chat-input-quota')?.classList.contains('is-tip-open'), true)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('switching selected engine refocuses the quota popover while keeping all-engine view available', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const entries = [
    { engine_id: 'codex_sdk', supported: true, status: 'ok' as const, quota: { engine_id: 'codex_sdk', primary: { remaining_percent: 82, used_percent: 18 } } },
    { engine_id: 'antigravity', supported: true, status: 'ok' as const, quota: { engine_id: 'antigravity', primary: { remaining_percent: 61, used_percent: 39 } } },
  ]
  try {
    await act(async () => root.render(<I18nProvider><ChatInputUsage compact={false} selectedEngine="codex_sdk" entries={entries} /></I18nProvider>))
    await act(async () => (container.querySelector('.engine-quota-trigger') as HTMLButtonElement).click())
    assert.deepEqual([...container.querySelectorAll('[data-quota-engine]')].map(n => n.getAttribute('data-quota-engine')), ['codex_sdk'])
    await act(async () => (container.querySelector('[data-quota-all]') as HTMLButtonElement).click())
    assert.deepEqual([...container.querySelectorAll('[data-quota-engine]')].map(n => n.getAttribute('data-quota-engine')), ['codex_sdk', 'antigravity'])
    await act(async () => root.render(<I18nProvider><ChatInputUsage compact={false} selectedEngine="antigravity" entries={entries} /></I18nProvider>))
    assert.deepEqual([...container.querySelectorAll('[data-quota-engine]')].map(n => n.getAttribute('data-quota-engine')), ['antigravity'])
    // Non-quota selected engine falls back to showing all eligible engines.
    await act(async () => root.render(<I18nProvider><ChatInputUsage compact={false} selectedEngine="pydantic_ai" entries={entries} /></I18nProvider>))
    assert.deepEqual([...container.querySelectorAll('[data-quota-engine]')].map(n => n.getAttribute('data-quota-engine')), ['codex_sdk', 'antigravity'])
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('shared ChatInput exposes the unified quota button for session, task creation, and task detail while skipping share projects', async () => {
  const { window } = installDomEnvironment()
  const { default: ChatInput } = await import('../src/components/ChatInput')
  const { engineApi } = await import('../src/api/client')
  const originalQuotas = engineApi.quotas
  const fetched: Array<[string, boolean]> = []
  engineApi.quotas = async (project = '', refresh = false) => {
    fetched.push([project, refresh])
    return {
      engines: [
        { engine_id: 'codex_sdk', supported: true, status: 'ok', quota: { engine_id: 'codex_sdk', primary: { remaining_percent: 78, used_percent: 22 } } },
        { engine_id: 'antigravity', supported: true, status: 'ok', quota: { engine_id: 'antigravity', primary: { remaining_percent: 65, used_percent: 35 } } },
      ],
      cached: false, collected_at: 1, expires_at: 301,
    }
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    // 1. Task creation composer (projectId only, no sessionId/taskId)
    await act(async () => root.render(<I18nProvider><ChatInput value="" onChange={() => {}} onSend={() => {}} projectId="proj-create" /></I18nProvider>))
    assert.ok(container.querySelector('.chat-input-quota') !== null)
    // 2. Task detail composer (projectId + taskId + selected step engine)
    await act(async () => root.render(<I18nProvider><ChatInput value="" onChange={() => {}} onSend={() => {}} projectId="proj-detail" taskId="task-1" skillEngine="antigravity" /></I18nProvider>))
    assert.ok(container.querySelector('.chat-input-quota') !== null)
    assert.match(container.querySelector('.engine-quota-trigger')?.textContent || '', /65%/)
    // 3. Shared task composer must not query host quotas
    const countBeforeShare = fetched.length
    await act(async () => root.render(<I18nProvider><ChatInput value="" onChange={() => {}} onSend={() => {}} projectId="share:tok-1" taskId="task-1" /></I18nProvider>))
    assert.equal(fetched.length, countBeforeShare)
    assert.ok(container.querySelector('.chat-input-quota') === null)
  } finally {
    engineApi.quotas = originalQuotas
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

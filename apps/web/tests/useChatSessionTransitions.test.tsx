import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { chatSessionApi } from '../src/api/client'
import { I18nProvider } from '../src/i18n'
import { useChatSessionTransitions } from '../src/hooks/useChatSessionTransitions'
import { useChatListStore } from '../src/stores/chatSessionStore'

test('engine handoff keeps its dialog open on failure and applies a successful retry', async () => {
  const { window } = installDomEnvironment()
  const originalHandoff = chatSessionApi.handoff
  const originalFetch = useChatListStore.getState().fetchSessions
  const applied: string[] = []
  const requests: string[] = []
  let attempts = 0
  let root!: Root
  let controls!: ReturnType<typeof useChatSessionTransitions>

  function Harness() {
    controls = useChatSessionTransitions({
      project: { id: 'project-1', routeName: 'Project' },
      sessionId: 'session-1',
      sessionTitle: 'Source',
      messageIds: ['message-1'],
      running: false,
      current: { engine: 'claude', providerId: '', model: '', fastModel: '', visionModel: '', thinkingEffort: '' },
      defaultEngine: 'claude',
      engines: [], providers: [], permissionMode: '',
      onHandoffApplied: (detail) => applied.push(detail.engine),
      navigate: () => {},
    })
    return controls.dialogs
  }

  try {
    chatSessionApi.handoff = async (_sessionId, input) => {
      requests.push(input.engine)
      attempts += 1
      if (attempts === 1) throw new Error('交接失败')
      return { engine: input.engine, provider_id: '' } as never
    }
    useChatListStore.setState({ fetchSessions: (async () => {}) as never })
    const container = window.document.body.appendChild(window.document.createElement('div'))
    await act(async () => {
      root = createRoot(container as never)
      root.render(<I18nProvider><Harness /></I18nProvider>)
    })

    await act(async () => { assert.equal(controls.requestEngineHandoff('codex'), true) })
    assert.ok(container.querySelector('[role="dialog"]'))
    const confirm = () => container.querySelector('.btn-primary') as HTMLButtonElement
    await act(async () => { confirm().click(); await Promise.resolve() })
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /交接失败/)
    await act(async () => { confirm().click(); await Promise.resolve() })
    assert.deepEqual(requests, ['codex', 'codex'])
    assert.deepEqual(applied, ['codex'])
    assert.equal(container.querySelector('[role="dialog"]'), null)

    await act(async () => { root.unmount() })
  } finally {
    chatSessionApi.handoff = originalHandoff
    useChatListStore.setState({ fetchSessions: originalFetch })
    await window.happyDOM.close()
  }
})

test('forking from an earlier message submits the selected cutoff and navigates', async () => {
  const { window } = installDomEnvironment()
  const originalFork = chatSessionApi.fork
  const routes: string[] = []
  const inputs: Array<{ fork_message_id?: string; context_mode: string }> = []
  let root!: Root
  let controls!: ReturnType<typeof useChatSessionTransitions>

  function Harness() {
    controls = useChatSessionTransitions({
      project: { id: 'project-1', routeName: 'My Project' },
      sessionId: 'session-1',
      sessionTitle: 'Source',
      messageIds: ['message-1', 'message-2'],
      running: false,
      current: { engine: 'claude', providerId: '', model: '', fastModel: '', visionModel: '', thinkingEffort: '' },
      defaultEngine: 'claude',
      engines: [], providers: [], permissionMode: '',
      onHandoffApplied: () => {},
      navigate: (path) => routes.push(path),
    })
    return controls.dialogs
  }

  try {
    chatSessionApi.fork = async (_sessionId, input) => {
      inputs.push(input)
      return { id: 'fork-1', project_id: 'project-1', title: input.title } as never
    }
    const container = window.document.body.appendChild(window.document.createElement('div'))
    await act(async () => {
      root = createRoot(container as never)
      root.render(<I18nProvider><Harness /></I18nProvider>)
    })
    await act(async () => { controls.openFork('claude', 'message-1') })
    const confirm = container.querySelector('.btn-primary') as HTMLButtonElement
    assert.ok(confirm)
    assert.equal(confirm.disabled, false)
    await act(async () => { confirm.click(); await Promise.resolve() })
    assert.equal(inputs.length, 1)
    assert.equal(inputs[0].fork_message_id, 'message-1')
    assert.equal(inputs[0].context_mode, 'smart')
    assert.deepEqual(routes, ['/chat?project=My%20Project&session=fork-1'])
    assert.equal(container.querySelector('[role="dialog"]'), null)

    await act(async () => { root.unmount() })
  } finally {
    chatSessionApi.fork = originalFork
    await window.happyDOM.close()
  }
})

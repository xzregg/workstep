import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useChatSessionEngineSelection } from '../src/hooks/useChatSessionEngineSelection'
import { chatSessionApi, type ChatSessionDetail } from '../src/api/client'
import { useChatExecutionConfigStore } from '../src/stores/chatExecutionConfigStore'

test('two viewers follow the latest provider/model and reject stale events and history', async () => {
  const { window } = installDomEnvironment()
  useChatExecutionConfigStore.setState({ configs: {} })
  const selections: Array<ReturnType<typeof useChatSessionEngineSelection>> = []
  function Viewer({ index }: { index: number }) {
    selections[index] = useChatSessionEngineSelection({ projectId: 'p', sessionId: 's', savedSessionId: 's', engines: [], providers: [] })
    return <span data-viewer={index}>{selections[index].config.engine}/{selections[index].config.providerId}/{selections[index].config.model}</span>
  }
  const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
  const old = { id: 's', project_id: 'p', engine: 'claude', provider_id: 'a', model: 'old', execution_config_revision: 1 } as ChatSessionDetail
  try {
    window.localStorage.setItem('workstep-chat-engine-config:p:s', JSON.stringify({ engine: 'claude', providerId: 'stale-local', model: 'stale-local' }))
    await act(async () => root.render(<><Viewer index={0} /><Viewer index={1} /></>))
    await act(async () => selections.forEach(selection => selection.restoreSession(old)))
    assert.equal(selections[0].config.providerId, 'a')
    await act(async () => useChatExecutionConfigStore.getState().handleWsEvent({
      type: 'CUSTOM', name: 'workstep.chat_execution_config', channel: 'session_chat', project_id: 'p', session_id: 's',
      value: { ...old, provider_id: 'b', model: 'latest', thinking_effort: 'high', service_tier: 'priority', execution_config_revision: 2 },
    }))
    for (const selection of selections) {
      assert.equal(selection.config.providerId, 'b')
      assert.equal(selection.config.model, 'latest')
      assert.equal(selection.config.thinkingEffort, 'high')
    }
    await act(async () => {
      selections[0].restoreSession(old)
      useChatExecutionConfigStore.getState().handleWsEvent({
        type: 'CUSTOM', name: 'workstep.chat_execution_config', channel: 'session_chat', project_id: 'other', session_id: 's',
        value: { ...old, project_id: 'other', engine: 'codex_sdk', execution_config_revision: 20 },
      })
    })
    assert.equal(selections[0].config.providerId, 'b')
    assert.equal(selections[1].config.engine, 'claude')
    await act(async () => useChatExecutionConfigStore.getState().receive('p', {
      ...old, engine: 'codex_sdk', provider_id: 'b', model: 'codex-model', execution_config_revision: 4,
    }))
    assert.ok(selections.every(selection => selection.config.engine === 'codex_sdk' && selection.config.model === 'codex-model'))
  } finally {
    await act(async () => root.unmount())
    useChatExecutionConfigStore.setState({ configs: {} })
    await window.happyDOM.close()
  }
})

test('explicit model changes patch only that field; a late response cannot revert a newer provider', async () => {
  const { window } = installDomEnvironment()
  useChatExecutionConfigStore.setState({ configs: {} })
  const original = chatSessionApi.updateExecutionConfig
  let complete!: (value: never) => void
  let selection!: ReturnType<typeof useChatSessionEngineSelection>
  function Viewer() {
    selection = useChatSessionEngineSelection({ projectId: 'p', sessionId: 's', savedSessionId: 's', engines: [], providers: [] })
    return null
  }
  const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
  const old = { id: 's', project_id: 'p', engine: 'claude', provider_id: 'a', model: 'old', execution_config_revision: 1 } as ChatSessionDetail
  try {
    chatSessionApi.updateExecutionConfig = (_id, _project, changes) => {
      assert.deepEqual(changes, { model: 'new' })
      return new Promise(resolve => { complete = resolve })
    }
    await act(async () => root.render(<Viewer />))
    await act(async () => selection.restoreSession(old))
    await act(async () => selection.setModel('new'))
    assert.equal(selection.saving, true)
    await act(async () => useChatExecutionConfigStore.getState().receive('p', { ...old, provider_id: 'b', model: 'remote', execution_config_revision: 3 }))
    await act(async () => complete({ ...old, model: 'new', execution_config_revision: 2 } as never))
    assert.equal(selection.config.providerId, 'b')
    assert.equal(selection.config.model, 'remote')
    assert.equal(selection.saving, false)
  } finally {
    chatSessionApi.updateExecutionConfig = original
    await act(async () => root.unmount())
    useChatExecutionConfigStore.setState({ configs: {} })
    await window.happyDOM.close()
  }
})

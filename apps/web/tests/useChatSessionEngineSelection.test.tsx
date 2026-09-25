import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useChatSessionEngineSelection } from '../src/hooks/useChatSessionEngineSelection'
import { EMPTY_ENGINE_CONFIG } from '../src/utils/chatEngineConfig'

test('session engine selection restores local choices and clears dependent models', async () => {
  const { window } = installDomEnvironment()
  const key = 'workstep-chat-engine-config:project-1:session-1'
  window.localStorage.setItem(key, JSON.stringify({
    engine: 'codex_sdk', providerId: 'provider-1', model: 'main',
    fastModel: 'fast', visionModel: 'vision', thinkingEffort: 'high',
  }))
  let root!: Root
  let selection!: ReturnType<typeof useChatSessionEngineSelection>

  function Harness() {
    selection = useChatSessionEngineSelection({
      projectId: 'project-1', sessionId: 'session-1', savedSessionId: 'session-1',
      engines: [], providers: [],
    })
    return null
  }

  try {
    const container = window.document.body.appendChild(window.document.createElement('div'))
    await act(async () => {
      root = createRoot(container as never)
      root.render(<Harness />)
    })
    await act(async () => {
      selection.setDefaults({
        engine: 'claude', provider_id: 'default-provider', model: 'default-model',
        fast_model: '', vision_model: '', thinking_effort: '',
      })
    })
    assert.equal(selection.config.providerId, 'default-provider')
    assert.equal(selection.config.model, 'default-model')
    await act(async () => {
      selection.restoreSession({ id: 'session-1', engine: 'claude', provider_id: '' } as never)
    })
    assert.deepEqual(selection.config, {
      engine: 'codex_sdk', providerId: 'provider-1', model: 'main',
      fastModel: 'fast', visionModel: 'vision', thinkingEffort: 'high',
    })
    await act(async () => { selection.chooseProvider('provider-2') })
    assert.deepEqual(selection.config, {
      ...EMPTY_ENGINE_CONFIG, engine: 'codex_sdk', providerId: 'provider-2',
    })
    await act(async () => { root.unmount() })
    assert.equal(JSON.parse(window.localStorage.getItem(key) || '{}').providerId, 'provider-2')
  } finally {
    await window.happyDOM.close()
  }
})

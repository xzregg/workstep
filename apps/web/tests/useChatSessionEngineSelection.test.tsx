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
      selection.restoreSession({ id: 'session-1', engine: 'codex_sdk', provider_id: '' } as never)
    })
    assert.deepEqual(selection.config, {
      engine: 'codex_sdk', providerId: 'provider-1', model: 'main',
      fastModel: 'fast', visionModel: 'vision', thinkingEffort: 'high', providerCleared: false,
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

test('session engine selection replaces a stale engine cache with the persisted session engine', async () => {
  const { window } = installDomEnvironment()
  const key = 'workstep-chat-engine-config:project-1:session-stale'
  let root!: Root
  let selection!: ReturnType<typeof useChatSessionEngineSelection>

  function Harness() {
    selection = useChatSessionEngineSelection({
      projectId: 'project-1', sessionId: 'session-stale', savedSessionId: 'session-stale',
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
    for (const engine of ['opencode', '']) {
      window.localStorage.setItem(key, JSON.stringify({
        engine, providerId: 'old-provider', model: 'old-model',
        fastModel: 'old-fast', visionModel: 'old-vision', thinkingEffort: 'high',
      }))
      await act(async () => {
        selection.restoreSession({
          id: 'session-stale', engine: 'codex_sdk', provider_id: '',
          model: 'gpt-6-sol', fast_model: 'gpt-6-sol', vision_model: '',
        } as never)
      })
      assert.equal(selection.config.engine, 'codex_sdk')
      assert.equal(selection.config.providerId, '')
      assert.equal(selection.config.model, 'gpt-6-sol')
      assert.equal(selection.config.fastModel, 'gpt-6-sol')
      assert.equal(selection.config.visionModel, '')
      assert.equal(selection.config.thinkingEffort, '')
      assert.equal(JSON.parse(window.localStorage.getItem(key) || '{}').engine, 'codex_sdk')
    }
    await act(async () => { root.unmount() })
  } finally {
    await window.happyDOM.close()
  }
})

test('session engine selection fills an empty provider from the session row', async () => {
  const { window } = installDomEnvironment()
  const key = 'workstep-chat-engine-config:project-1:session-2'
  window.localStorage.setItem(key, JSON.stringify({
    engine: 'claude', providerId: '', model: '',
    fastModel: '', visionModel: '', thinkingEffort: '',
  }))
  let root!: Root
  let selection!: ReturnType<typeof useChatSessionEngineSelection>

  function Harness() {
    selection = useChatSessionEngineSelection({
      projectId: 'project-1', sessionId: 'session-2', savedSessionId: 'session-2',
      engines: [{
        id: 'claude', supports_provider: true, provider_protocols: ['anthropic_messages'],
      }] as never,
      providers: [{ id: 'row-provider', protocol: 'anthropic_messages', enabled: true }] as never,
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
      selection.restoreSession({
        id: 'session-2', engine: 'claude', provider_id: 'row-provider',
      } as never)
    })
    assert.equal(selection.config.engine, 'claude')
    assert.equal(selection.config.providerId, 'row-provider')
    // 回填后同步落回本地，避免下次打开在「行有/本地空」之间反复横跳。
    assert.equal(JSON.parse(window.localStorage.getItem(key) || '{}').providerId, 'row-provider')
    await act(async () => { root.unmount() })
  } finally {
    await window.happyDOM.close()
  }
})

test('session engine selection ignores an incompatible row provider', async () => {
  const { window } = installDomEnvironment()
  const key = 'workstep-chat-engine-config:project-1:session-3'
  window.localStorage.setItem(key, JSON.stringify({
    engine: 'claude', providerId: '', model: '',
    fastModel: '', visionModel: '', thinkingEffort: '',
  }))
  let root!: Root
  let selection!: ReturnType<typeof useChatSessionEngineSelection>

  function Harness() {
    selection = useChatSessionEngineSelection({
      projectId: 'project-1', sessionId: 'session-3', savedSessionId: 'session-3',
      engines: [{
        id: 'claude', supports_provider: true, provider_protocols: ['anthropic_messages'],
      }] as never,
      providers: [{ id: 'row-provider', protocol: 'openai_compatible', enabled: true }] as never,
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
      selection.restoreSession({
        id: 'session-3', engine: 'claude', provider_id: 'row-provider',
      } as never)
    })
    // 协议不兼容时仍按「跟随默认」展示，不把不兼容供应商填进本地配置。
    assert.equal(selection.config.providerId, '')
    await act(async () => { root.unmount() })
  } finally {
    await window.happyDOM.close()
  }
})


test('explicit default provider survives session restoration', async () => {
  const { window } = installDomEnvironment()
  const key = 'workstep-chat-engine-config:project-1:session-default'
  let selection!: ReturnType<typeof useChatSessionEngineSelection>
  function Harness() {
    selection = useChatSessionEngineSelection({
      projectId: 'project-1', sessionId: 'session-default', savedSessionId: 'session-default',
      engines: [], providers: [],
    })
    return null
  }
  const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
  try {
    await act(async () => root.render(<Harness />))
    await act(async () => selection.setDefaults({ engine: 'codex_sdk', provider_id: 'old-provider' } as never))
    await act(async () => selection.chooseProvider(''))
    assert.equal(selection.config.providerCleared, true)
    window.localStorage.setItem(key, JSON.stringify(selection.config))
    await act(async () => selection.restoreSession({
      id: 'session-default', engine: 'codex_sdk', provider_id: 'old-provider',
    } as never))
    assert.equal(selection.config.providerId, '')
    assert.equal(selection.config.providerCleared, true)
    await act(async () => selection.chooseProvider('new-provider'))
    assert.equal(selection.config.providerCleared, false)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

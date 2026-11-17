import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { chatSessionApi, type ChatSessionDetail, type ChatSessionHandoffInput } from '../src/api/client'
import { useChatSessionTransitions } from '../src/hooks/useChatSessionTransitions'
import { useChatSessionEngineSelection } from '../src/hooks/useChatSessionEngineSelection'
import { I18nProvider } from '../src/i18n'
import { encodePermissionSelection } from '../src/utils/enginePermissions'
import { useChatListStore } from '../src/stores/chatSessionStore'

for (const scenario of ['return', 'older-history', 'reload', 'provider-cycle', 'cancel', 'silent-failure', 'silent-none-failure', 'busy', 'double-submit', 'reset']) {
  test(`handoff boundary: ${scenario}`, async () => {
    const { window } = installDomEnvironment()
    const originalApi = chatSessionApi.handoff
    const originalFetch = useChatListStore.getState().fetchSessions
    const originalDetail = { id: 's', engine: 'claude', provider_id: 'provider-a', model: 'original-model', permission_mode: encodePermissionSelection('claude', {permission_mode:'acceptEdits'}), pending_handoff: null } as ChatSessionDetail
    let stored = originalDetail
    let controls!: ReturnType<typeof useChatSessionTransitions>
    let selection!: ReturnType<typeof useChatSessionEngineSelection>
    let updateMessages!: (ids: string[]) => void
    let setRunning!: (running: boolean) => void
    const requests: ChatSessionHandoffInput[] = []
    let fail = false
    function Harness() {
      const [messageIds, setMessages] = useState(['last'])
      const [running, updateRunning] = useState(false)
      updateMessages = setMessages
      setRunning = updateRunning
      selection = useChatSessionEngineSelection({ projectId: 'p', sessionId: 's', savedSessionId: 's', engines: [], providers: [] })
      controls = useChatSessionTransitions({
        project: { id: 'p', routeName: 'P' }, sessionId: 's', sessionTitle: 'S', messageIds,
        running, current: selection.config, pendingHandoff: selection.pendingHandoff, loadedEndpoint: selection.loadedEndpoint,
        defaultEngine: 'claude', engines: [], providers: [], permissionMode: selection.permissionMode,
        onHandoffApplied: selection.applyHandoff, navigate: () => {},
      })
      return controls.dialogs
    }
    const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
    const confirm = async () => act(async () => { (window.document.querySelector('.btn-primary') as HTMLButtonElement).click() })
    try {
      chatSessionApi.handoff = async (_id, input) => {
        requests.push(input)
        if (fail) throw new Error('network failure')
        stored = input.engine === 'claude' && input.provider_id === 'provider-a'
          ? { ...originalDetail, permission_mode: '' }
          : { ...stored, engine: input.engine, provider_id: input.provider_id || '', model: null, permission_mode: input.engine === stored.engine ? stored.permission_mode : null,
              pending_handoff: { source_engine: 'claude', source_provider_id: 'provider-a', target_engine: input.engine,
                context_mode: input.context_mode, message_id: 'last' } }
        return stored
      }
      useChatListStore.setState({ fetchSessions: (async () => {}) as never })
      await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
      await act(async () => selection.restoreSession(originalDetail))
      await act(async () => { assert.equal(controls.requestEngineHandoff('codex_sdk'), true) })
      if (scenario === 'cancel') {
        await act(async () => { (window.document.querySelector('.btn-ghost') as HTMLButtonElement).click() })
        assert.equal(selection.config.engine, 'claude')
        assert.equal(requests.length, 0)
        assert.equal(selection.permissionMode, originalDetail.permission_mode)
        return
      }
      if (scenario === 'double-submit') {
        await act(async () => {
          const button = window.document.querySelector('.btn-primary') as HTMLButtonElement
          button.click()
          button.click()
        })
        assert.equal(requests.length, 1)
        assert.equal(selection.config.engine, 'codex_sdk')
        return
      }
      if (scenario === 'silent-none-failure') {
        await act(async () => { (window.document.querySelector('input[value="none"]') as HTMLInputElement).click() })
      }
      await confirm()
      assert.equal(selection.permissionMode, '')
      assert.equal(requests[0].permission_mode, undefined)
      if (scenario === 'reset') {
        await act(async () => { assert.equal(controls.requestResetHandoff(), true) })
        assert.ok(window.document.querySelector('[role="dialog"]'))
        await confirm()
        assert.equal(selection.config.engine, 'claude')
        assert.equal(selection.config.providerId, '')
        return
      }
      if (scenario === 'silent-none-failure') {
        fail = true
        await act(async () => { controls.requestProviderHandoff('provider-b') })
        assert.equal((window.document.querySelector('input[value="none"]') as HTMLInputElement).checked, true)
        fail = false
        await confirm()
        assert.equal(requests.at(-1)?.context_mode, 'none')
        return
      }
      if (scenario === 'older-history') {
        await act(async () => updateMessages(['older', 'last']))
      }
      if (scenario === 'reload') {
        await act(async () => root.render(null))
        await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
        await act(async () => selection.restoreSession(stored))
      }
      if (scenario === 'busy') {
        await act(async () => setRunning(true))
        await act(async () => { controls.requestEngineHandoff('claude'); controls.requestProviderHandoff('other') })
        assert.equal(requests.length, 1)
        assert.equal(window.document.querySelector('[role="dialog"]'), null)
        return
      }
      if (scenario === 'return' || scenario === 'silent-failure') {
        fail = scenario === 'silent-failure'
        await act(async () => { assert.equal(controls.requestEngineHandoff('claude'), true) })
        if (fail) {
          assert.match(window.document.querySelector('[role="alert"]')?.textContent || '', /network failure/)
          assert.equal(selection.config.engine, 'codex_sdk')
          fail = false
          await confirm()
        }
        assert.equal(stored.engine, 'claude')
        assert.equal(selection.config.providerId, 'provider-a')
        assert.equal(selection.config.model, 'original-model')
        assert.equal(selection.permissionMode, '')
        await act(async () => selection.restoreSession(stored))
        assert.equal(selection.config.engine, 'claude')
      } else {
        for (const provider of ['provider-b', 'provider-c', '']) {
          await act(async () => { assert.equal(controls.requestProviderHandoff(provider), true) })
          assert.equal(window.document.querySelector('[role="dialog"]'), null)
          assert.equal(selection.config.providerId, provider)
        }
        await act(async () => updateMessages(['last', 'new-message']))
        await act(async () => { assert.equal(controls.requestProviderHandoff('provider-b'), true) })
        assert.ok(window.document.querySelector('[role="dialog"]'))
      }
    } finally {
      await act(async () => root.unmount())
      chatSessionApi.handoff = originalApi
      useChatListStore.setState({ fetchSessions: originalFetch })
      await window.happyDOM.close()
    }
  })
}

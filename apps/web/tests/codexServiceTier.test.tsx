import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import CoordinatorConfigBar from '../src/components/CoordinatorConfigBar'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { engineApi, invalidateEngineModels } from '../src/api/client'
import { useChatSessionEngineSelection } from '../src/hooks/useChatSessionEngineSelection'
import { loadChatEngineConfig, saveChatEngineConfig } from '../src/utils/chatEngineConfig'

test('Codex speed menu selects native tiers and returns to inherited configuration', async () => {
  const { window, document } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN', language: null })
  window.innerWidth = 1400
  const original = engineApi.models
  engineApi.models = async () => ({ engine_id: 'codex_sdk', models: [], default_model: '', error: null })
  invalidateEngineModels('codex_sdk')
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  let chosen = ''
  function Harness() {
    const [tier, setTier] = useState('')
    return <I18nProvider><CoordinatorConfigBar
      engines={[]} engine="codex_sdk" defaultEngine="codex_sdk" model="" fastModel=""
      variant="menu" serviceTier={tier}
      onEngineChange={() => {}} onModelChange={() => {}} onFastModelChange={() => {}}
      onServiceTierChange={value => { chosen = value; setTier(value) }}
    /></I18nProvider>
  }
  try {
    await act(async () => root.render(<Harness />))
    const open = async () => {
      const row = [...document.querySelectorAll<HTMLElement>('[role="button"]')]
        .find(element => element.textContent?.startsWith('速度'))!
      assert.ok(row)
      await act(async () => row.click())
    }
    await open()
    for (const label of ['默认', '标准', '快速']) {
      assert.ok([...document.querySelectorAll('button')].find(button => button.textContent?.includes(label)))
    }
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent?.includes('快速'))!.click())
    assert.equal(chosen, 'priority')
    assert.equal(document.querySelector('[role="listbox"]'), null)
    await open()
    assert.ok(document.querySelector('[data-selected="true"]')?.textContent?.includes('快速'))
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent?.includes('默认'))!.click())
    assert.equal(chosen, '')
  } finally {
    engineApi.models = original
    invalidateEngineModels('codex_sdk')
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('speed choice is isolated by session and reset when changing provider or engine', async () => {
  const { window, document } = installDomEnvironment()
  let selection!: ReturnType<typeof useChatSessionEngineSelection>
  function Harness() {
    selection = useChatSessionEngineSelection({ projectId: 'p', sessionId: 's', savedSessionId: 's', engines: [], providers: [] })
    return null
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<Harness />))
    await act(async () => { selection.chooseEngine('codex_sdk'); selection.setServiceTier('priority') })
    assert.equal(selection.config.serviceTier, 'priority')
    saveChatEngineConfig('p', 's', selection.config)
    assert.equal(loadChatEngineConfig('p', 's').serviceTier, 'priority')
    assert.equal(loadChatEngineConfig('p', 'other').serviceTier, undefined)
    await act(async () => selection.chooseProvider('third-party'))
    assert.equal(selection.config.serviceTier || '', '')
    await act(async () => selection.setServiceTier('default'))
    await act(async () => selection.chooseEngine('claude'))
    assert.equal(selection.config.serviceTier || '', '')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import BotSettings from '../src/pages/BotSettings'
import { useProjectStore } from '../src/stores/projectStore'

test('bot settings requires credentials and sends the selected platform fields', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const previousFetch = globalThis.fetch
  const previousStore = useProjectStore.getState()
  useProjectStore.setState({ projects: [], fetchProjects: async () => {} })
  const posted: unknown[] = []
  globalThis.fetch = async (input, init) => {
    if (String(input) === '/api/channel-bots' && init?.method === 'POST') {
      posted.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ id: 'bot-1', ...posted[0], secret: undefined, has_secret: true, status: 'disabled' }), { status: 200 })
    }
    return new Response(JSON.stringify([]), { status: 200 })
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const enter = async (input: HTMLInputElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  try {
    await act(async () => root.render(<I18nProvider><BotSettings /></I18nProvider>))
    const fields = container.querySelectorAll<HTMLInputElement>('.bot-settings-form input:not([type="checkbox"])')
    const save = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '保存')!
    assert.equal(save.disabled, true)
    await enter(fields[0], '研发助手')
    await enter(fields[1], 'bot-id')
    await enter(fields[2], 'secret-value')
    assert.equal(save.disabled, false)
    await act(async () => save.click())
    assert.deepEqual(posted, [{
      platform: 'wecom', name: '研发助手', app_id: 'bot-id', secret: 'secret-value',
      enabled: false, default_target_type: '', default_project_id: '', default_task_id: '',
    }])
  } finally {
    await act(async () => root.unmount())
    container.remove()
    globalThis.fetch = previousFetch
    useProjectStore.setState(previousStore)
    await window.happyDOM.close()
  }
})

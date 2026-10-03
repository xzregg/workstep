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
    assert.equal(container.querySelector('option[value="task"]'), null, 'task binding belongs to task details')
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


test('editing a legacy task default saves a project default and never fetches tasks', async () => {
  const { window } = installDomEnvironment()
  const previousFetch = globalThis.fetch
  const previousStore = useProjectStore.getState()
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ projects: [{ id: 'p1', name: '项目一', type: 'local' }] as any, fetchProjects: async () => {} })
  const requests: string[] = []
  let saved: any
  const bot = { id: 'b1', platform: 'wecom', name: '机器人', app_id: 'app', enabled: false,
    has_secret: true, status: 'disabled', error: '', default_target_type: 'task', default_project_id: 'p1', default_task_id: 't1' }
  globalThis.fetch = async (input, init) => {
    requests.push(String(input))
    if (init?.method === 'PATCH') {
      saved = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ ...bot, ...saved }))
    }
    return new Response(JSON.stringify([bot]))
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><BotSettings /></I18nProvider>))
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '编辑')!.click())
    assert.equal(container.querySelector('option[value="task"]'), null)
    assert.equal(container.querySelectorAll<HTMLSelectElement>('.bot-settings-form select')[1].value, 'project')
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '保存')!.click())
    assert.equal(saved.default_target_type, 'project')
    assert.equal(saved.default_project_id, 'p1')
    assert.equal(saved.default_task_id, '')
    assert.equal(requests.some((url) => url.includes('/task/')), false)
    assert.equal('secret' in saved, false)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    globalThis.fetch = previousFetch
    useProjectStore.setState(previousStore)
    await window.happyDOM.close()
  }
})

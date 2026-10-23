import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import BotSettings from '../src/pages/BotSettings'
import { useProjectStore } from '../src/stores/projectStore'

test('channel navigation filters bots, guards dirty switches, and provides social credentials', async () => {
  const { window } = installDomEnvironment()
  const previousFetch = globalThis.fetch, previousStore = useProjectStore.getState()
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ projects: [{ id: 'p', name: '演示', type: 'local' }] as any, fetchProjects: async () => {} })
  const saved: any[] = []
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'POST') saved.push(JSON.parse(String(init.body)))
    return Response.json(init?.method === 'POST' ? { id: 'new', ...saved.at(-1) } : [{ id: 'w', platform: 'wecom', name: '企微助手', app_id: 'w', enabled: false, status: 'disabled', task_bindings: [] }])
  }
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container)
  const clickPlatform = async (platform: string) => act(async () => container.querySelector<HTMLButtonElement>(`.bot-settings-platform[data-platform="${platform}"]`)!.click())
  const enter = async (label: string, value: string) => act(async () => {
    const input = [...container.querySelectorAll('label')].find(row => row.textContent === label)!.querySelector('input')!
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  try {
    await act(async () => root.render(<I18nProvider><BotSettings /></I18nProvider>))
    assert.equal(container.querySelectorAll('.bot-settings-platform').length, 7)
    await clickPlatform('telegram')
    assert.doesNotMatch(container.querySelector('.bot-settings-list')!.textContent!, /企微助手/)
    assert.ok(container.querySelector('input[type="password"]'))
    await enter('机器人名称', '电报助手')
    await enter('Bot Token', '123:secret')
    await clickPlatform('slack')
    assert.match(document.body.textContent!, /放弃未保存/)
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '取消')!.click())
    assert.equal(container.querySelector<HTMLInputElement>('input[type="password"]')!.value, '123:secret')
    const project = container.querySelector<HTMLSelectElement>('select[required]')!
    await act(async () => { project.value = 'p'; project.dispatchEvent(new window.Event('change', { bubbles: true })) })
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '保存')!.click())
    assert.equal(saved[0].platform, 'telegram')
    assert.equal(saved[0].secret, '123:secret')
    await clickPlatform('slack')
    assert.equal(container.querySelectorAll('input[type="password"]').length, 2)
    assert.match(container.querySelector('.bot-settings-form')!.textContent!, /App-Level Token/)
    await clickPlatform('discord')
    assert.match(container.textContent!, /Message Content Intent/)
  } finally {
    await act(async () => root.unmount()); container.remove(); globalThis.fetch = previousFetch; useProjectStore.setState(previousStore); await window.happyDOM.close()
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
    task_bindings: [{ bot_id: 'b1', project_id: 'p1', task_id: 't1', task_title: '登录修复', project_name: '项目一', group_id: 'g1', group_name: '研发群' }],
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
    assert.match(container.querySelector('.bot-task-bindings-trigger')!.textContent!, /已绑定任务.*1/)
    assert.equal(container.querySelector('.bot-task-bindings'), null)
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '编辑')!.click())
    assert.equal(container.querySelector('option[value="task"]'), null)
    assert.equal(container.querySelectorAll<HTMLSelectElement>('.bot-settings-form select')[1].value, 'p1')
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


test('bot settings explains when the running backend omits task bindings', async () => {
  const { window } = installDomEnvironment()
  const previousFetch = globalThis.fetch
  const previousStore = useProjectStore.getState()
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ projects: [], fetchProjects: async () => {} })
  globalThis.fetch = async () => new Response(JSON.stringify([{
    id: 'b1', platform: 'wecom', name: '机器人', app_id: 'app', enabled: true,
    has_secret: true, status: 'connected', error: '', default_target_type: 'project',
    default_project_id: 'p1', default_task_id: '',
  }]))
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><BotSettings /></I18nProvider>))
    const bindings = container.querySelector('.bot-task-bindings-trigger')
    assert.ok(bindings)
    assert.match(bindings.textContent!, /已绑定任务/)
    assert.equal(container.querySelector('.bot-task-bindings'), null)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    globalThis.fetch = previousFetch
    useProjectStore.setState(previousStore)
    await window.happyDOM.close()
  }
})

test('bot settings shows an empty task binding state when the backend reports no bindings', async () => {
  const { window } = installDomEnvironment()
  const previousFetch = globalThis.fetch
  const previousStore = useProjectStore.getState()
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ projects: [], fetchProjects: async () => {} })
  globalThis.fetch = async () => new Response(JSON.stringify([{
    id: 'b1', platform: 'wecom', name: '机器人', app_id: 'app', enabled: true,
    has_secret: true, status: 'connected', error: '', default_target_type: 'project',
    default_project_id: 'p1', default_task_id: '', task_bindings: [],
  }]))
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><BotSettings /></I18nProvider>))
    const bindings = container.querySelector('.bot-task-bindings-trigger')
    assert.ok(bindings)
    assert.match(bindings.textContent!, /已绑定任务.*0/)
    assert.doesNotMatch(bindings.textContent!, /重启后端/)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    globalThis.fetch = previousFetch
    useProjectStore.setState(previousStore)
    await window.happyDOM.close()
  }
})

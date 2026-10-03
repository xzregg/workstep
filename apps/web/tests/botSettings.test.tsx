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
    assert.match(container.querySelector('.bot-task-bindings')!.textContent!, /登录修复/ )
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


test('DingTalk can save an optional custom button card template', async () => {
  const { window } = installDomEnvironment()
  const fetch = globalThis.fetch
  const store = useProjectStore.getState()
  useLocaleStore.setState({ locale:'zh-CN' })
  useProjectStore.setState({projects:[],fetchProjects:async () => {}})
  let saved: any
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'POST') saved = JSON.parse(String(init.body))
    return new Response(JSON.stringify(init?.method === 'POST' ? {...saved,id:'b'} : []))
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><BotSettings /></I18nProvider>))
    const platform = container.querySelector<HTMLSelectElement>('select')!
    await act(async () => { platform.value = 'dingtalk'; platform.dispatchEvent(new window.Event('change',{bubbles:true})) })
    const fields = [...container.querySelectorAll<HTMLInputElement>('.bot-settings-form input:not([type="checkbox"])')]
    assert.equal(fields.length, 4)
    for (const [index, value] of ['助手','app','secret','own.schema'].entries()) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(fields[index],value)
        fields[index].dispatchEvent(new window.Event('input',{bubbles:true}))
      })
    }
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '保存')!.click())
    assert.equal(saved.card_template_id,'own.schema')
  } finally {
    await act(async () => root.unmount())
    container.remove(); globalThis.fetch = fetch; useProjectStore.setState(store); await window.happyDOM.close()
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
    const bindings = container.querySelector('.bot-task-bindings')
    assert.ok(bindings)
    assert.match(bindings.textContent!, /已绑定任务/)
    assert.match(bindings.textContent!, /重启后端/)
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
    const bindings = container.querySelector('.bot-task-bindings')
    assert.ok(bindings)
    assert.match(bindings.textContent!, /暂无绑定任务/)
    assert.doesNotMatch(bindings.textContent!, /重启后端/)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    globalThis.fetch = previousFetch
    useProjectStore.setState(previousStore)
    await window.happyDOM.close()
  }
})

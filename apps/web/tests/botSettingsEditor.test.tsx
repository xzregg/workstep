import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import BotSettingsEditor from '../src/components/BotSettingsEditor'
import { useProjectStore } from '../src/stores/projectStore'
import type { BotPlatform } from '../src/api/channelBots'

test('social credentials require the platform fields and failed saves retain the draft for retry', async () => {
 for (const platform of ['telegram', 'discord', 'slack'] as BotPlatform[]) {
  const { window } = installDomEnvironment()
  const previousFetch = globalThis.fetch, previousStore = useProjectStore.getState()
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ projects: [{ id: 'p', name: '演示', type: 'local' }] as any })
  let attempts = 0, payload: any, saved = 0
  const busyStates: boolean[] = []
  globalThis.fetch = async (_input, init) => {
    payload = JSON.parse(String(init?.body)); attempts++
    return attempts === 1 ? Response.json({ detail: '保存失败，请重试' }, { status: 500 }) : Response.json({ ...payload, id: 'b' })
  }
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container)
  const enter = async (input: HTMLInputElement, value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  try {
    await act(async () => root.render(<I18nProvider><BotSettingsEditor platform={platform} onPlatformChange={() => {}} onSaved={() => { saved++ }} onCancel={() => {}} onDirtyChange={() => {}} onBusyChange={busy => busyStates.push(busy)} /></I18nProvider>))
    const fields = container.querySelectorAll<HTMLInputElement>('input:not([type="checkbox"])')
    await enter(fields[0], '助手')
    if (platform !== 'telegram') await enter(fields[1], 'application-id')
    const token = container.querySelector<HTMLInputElement>('input[type="password"]')!
    await enter(token, platform === 'telegram' ? '123:token' : 'bot-token')
    const project = container.querySelector<HTMLSelectElement>('select[required]')!
    await act(async () => { project.value = 'p'; project.dispatchEvent(new window.Event('change', { bubbles: true })) })
    const save = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '保存')!
    if (platform === 'slack') {
      assert.equal(save.disabled, true)
      await enter(container.querySelectorAll<HTMLInputElement>('input[type="password"]')[1], 'app-token')
    }
    assert.equal(save.disabled, false)
    await act(async () => save.click())
    assert.equal(saved, 0)
    assert.match(container.querySelector('[role="alert"]')!.textContent!, /保存失败/)
    assert.ok(token.value)
    await act(async () => save.click())
    assert.equal(saved, 1)
    assert.equal(payload.platform, platform)
    assert.equal(payload.app_id, platform === 'telegram' ? '123' : 'application-id')
    assert.equal(payload.app_token, platform === 'slack' ? 'app-token' : undefined)
    assert.ok(busyStates.includes(true))
  } finally {
    await act(async () => root.unmount()); container.remove(); globalThis.fetch = previousFetch; useProjectStore.setState(previousStore); await window.happyDOM.close()
  }
 }
})

test('editing Slack keeps both stored tokens without resending empty values', async () => {
  const { window } = installDomEnvironment()
  const previousFetch = globalThis.fetch, previousStore = useProjectStore.getState()
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ projects: [{ id: 'p', name: '演示', type: 'local' }] as any })
  let payload: any
  globalThis.fetch = async (_input, init) => { payload = JSON.parse(String(init?.body)); return Response.json({}) }
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><BotSettingsEditor platform="slack" bot={{ id: 'b', platform: 'slack', name: '助手', app_id: 'A1', has_secret: true, has_app_token: true, default_project_id: 'p' } as any} onPlatformChange={() => {}} onSaved={() => {}} onCancel={() => {}} onDirtyChange={() => {}} onBusyChange={() => {}} /></I18nProvider>))
    assert.equal(container.querySelector<HTMLSelectElement>('select')!.disabled, true)
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '保存')!.click())
    assert.equal('secret' in payload, false)
    assert.equal('app_token' in payload, false)
  } finally {
    await act(async () => root.unmount()); container.remove(); globalThis.fetch = previousFetch; useProjectStore.setState(previousStore); await window.happyDOM.close()
  }
})

test('bot settings requires credentials and sends the selected platform fields', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const previousFetch = globalThis.fetch
  const previousStore = useProjectStore.getState()
  useProjectStore.setState({ projects: [{ id: 'p1', name: '项目一', type: 'local' }, { id: 'remote', name: '远程', type: 'remote' }] as any, fetchProjects: async () => {} })
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
    await act(async () => root.render(<I18nProvider><BotSettingsEditor platform="wecom" onPlatformChange={() => {}} onSaved={() => {}} onCancel={() => {}} onDirtyChange={() => {}} onBusyChange={() => {}} /></I18nProvider>))
    assert.equal(container.querySelector('option[value="task"]'), null, 'task binding belongs to task details')
    const fields = container.querySelectorAll<HTMLInputElement>('.bot-settings-form input:not([type="checkbox"])')
    const save = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '保存')!
    assert.equal(save.disabled, true)
    await enter(fields[0], '研发助手')
    await enter(fields[1], 'bot-id')
    await enter(fields[2], 'secret-value')
    assert.equal(save.disabled, true, 'default project is required after credentials are filled')
    assert.equal(container.querySelector('option[value="remote"]'), null)
    const project = container.querySelectorAll<HTMLSelectElement>('.bot-settings-form select')[1]
    await act(async () => { project.value = 'p1'; project.dispatchEvent(new window.Event('change', { bubbles: true })) })
    assert.equal(save.disabled, false)
    await act(async () => save.click())
    assert.deepEqual(posted, [{
      platform: 'wecom', name: '研发助手', app_id: 'bot-id', secret: 'secret-value',
      enabled: false, default_target_type: 'project', default_project_id: 'p1', default_task_id: '',
    }])
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
  useProjectStore.setState({projects:[{id:'p1',name:'项目一',type:'local'}] as any,fetchProjects:async () => {}})
  let saved: any
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'POST') saved = JSON.parse(String(init.body))
    return new Response(JSON.stringify(init?.method === 'POST' ? {...saved,id:'b'} : []))
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><BotSettingsEditor platform="dingtalk" onPlatformChange={() => {}} onSaved={() => {}} onCancel={() => {}} onDirtyChange={() => {}} onBusyChange={() => {}} /></I18nProvider>))
    const consoleLink = container.querySelector<HTMLAnchorElement>('a[href="https://open-dev.dingtalk.com/"]')!
    assert.ok(consoleLink)
    assert.equal(consoleLink.target, '_blank')
    assert.match(consoleLink.rel, /noopener/)
    assert.ok(container.querySelector('a[href="https://open.dingtalk.com/document/orgapp/create-and-deliver-cards"]'))
    assert.match(container.textContent!, /开发配置.*权限管理/)
    assert.match(container.textContent!, /Card.Instance.Write/)
    const project = container.querySelectorAll<HTMLSelectElement>('.bot-settings-form select')[1]
    await act(async () => { project.value = 'p1'; project.dispatchEvent(new window.Event('change', { bubbles: true })) })
    const fields = [...container.querySelectorAll<HTMLInputElement>('.bot-settings-form input:not([type="checkbox"])')]
    assert.equal(fields.length, 5)
    for (const [index, value] of ['助手','app','secret','own.schema','review.schema'].entries()) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(fields[index],value)
        fields[index].dispatchEvent(new window.Event('input',{bubbles:true}))
      })
    }
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '保存')!.click())
    assert.equal(saved.card_template_id,'own.schema')
    assert.equal(saved.review_card_template_id,'review.schema')
  } finally {
    await act(async () => root.unmount())
    container.remove(); globalThis.fetch = fetch; useProjectStore.setState(store); await window.happyDOM.close()
  }
})

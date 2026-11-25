import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import DigitalPersonDelegationDialog from '../src/components/digital-person/DigitalPersonDelegationDialog'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { useGatewaySessionStore } from '../src/stores/gatewaySessionStore'
import { useProjectStore } from '../src/stores/projectStore'
import { useChatListStore } from '../src/stores/chatSessionStore'

for (const width of [1440, 390]) test(`delegation shortcuts load, retry and run in execution context at ${width}px`, async () => {
  const { window } = installDomEnvironment()
  window.innerWidth = width
  Object.assign(globalThis, { history: window.history })
  const previousFetch = globalThis.fetch, previousProject = useProjectStore.getState(), previousList = useChatListStore.getState(), previousGateway = useGatewaySessionStore.getState()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const original = { id: 'original', name: '当前项目', path: '/tmp/original', workflows: [], steps: {} }
  const execution = { ...original, id: 'execution', name: '执行项目' }
  useProjectStore.setState({ projects: [original, execution], activeProject: original })
  useChatListStore.setState({ quickButtonsByProject: {} })
  let fail = true, finishLoad: (() => void) | undefined
  const mutations: {url: string; body: string}[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (init?.method === 'POST') { mutations.push({ url, body: String(init.body) }); return Response.json({ detail: '动作启动失败' }, { status: 500 }) }
    if (url.includes('/quick-buttons')) {
      await new Promise<void>(resolve => { finishLoad = resolve })
      if (fail) return Response.json({ detail: '快捷配置加载失败' }, { status: 500 })
      return Response.json({ buttons: [
        { id: 'draft', label: '填写要求', prompt: '补充要求' },
        { id: 'send', label: '直接发送', prompt: '立即执行', immediate_send: true },
        { id: 'action', label: '执行动作', kind: 'action', action_id: 'a', require_confirmation: false },
        { id: 'active', label: '正在执行动作', kind: 'action', action_id: 'busy' },
        { id: 'hidden', label: '禁用按钮', prompt: '禁止', enabled: false },
        { id: 'display', label: '展示信息', kind: 'display', content: '只读说明' },
      ] })
    }
    if (url.includes('/chat-sessions/execution-session')) return Response.json({ id: 'execution-session', project_id: execution.id, title: '执行会话', messages: [], engine: 'pydantic_ai', running: false })
    if (url.includes('/assistant/list')) return Response.json({ assistants: [{ name: 'chat_session', configured: { engine: 'pydantic_ai' }, available_engines: [] }] })
    return Response.json({ providers: [], buttons: [], sessions: [], runs: [], active_action_ids: ['busy'] })
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === label)!
  const showMenu = async () => { const bolt = document.querySelector<HTMLButtonElement>('.chat-quick-bolt'); if (bolt) await act(async () => bolt.click()) }
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={['/chat?project=当前项目&session=original']}><I18nProvider><DigitalPersonDelegationDialog delegation={{ project_id: execution.id, session_id: 'execution-session', title: '委派执行' } as never} onClose={() => {}} /></I18nProvider></MemoryRouter>))
    // Resolve lazy ChatPage before inspecting its pending request.
    for (let i = 0; i < 30 && !finishLoad; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    assert.ok(finishLoad, 'embedded execution must request project quick buttons')
    assert.ok(document.querySelector('[role="status"] .spinner'))
    await act(async () => finishLoad!())
    assert.match(document.body.textContent!, /快捷配置加载失败/)
    fail = false
    await act(async () => button('重试').click())
    await act(async () => finishLoad!())
    await showMenu()
    assert.ok(button('填写要求'))
    assert.ok(button('禁用按钮') === undefined)
    assert.equal(button('正在执行动作').disabled, true)
    assert.match(document.body.textContent!, /只读说明/)
    await act(async () => button('填写要求').click())
    assert.equal(document.querySelector('textarea')?.value, '补充要求')
    await showMenu()
    await act(async () => button('执行动作').click())
    assert.match(document.body.textContent!, /动作启动失败/)
    assert.match(mutations[0].url, /project-actions\/sessions\/execution-session\/run\?project_id=execution/)
    assert.equal(JSON.parse(mutations[0].body).button_id, 'action')
    await showMenu()
    await act(async () => button('直接发送').click())
    assert.match(mutations[1].url, /chat-sessions\/execution-session\/chat\?project_id=execution/)
    assert.equal(useProjectStore.getState().activeProject?.id, original.id)
    const writes = mutations.length
    window.happyDOM.setURL('https://d-test.example.com/')
    await act(async () => useGatewaySessionStore.setState({ session: { host_project_id: execution.id, access_level: 'edit', permissions: ['session.read', 'session.chat'] } as never }))
    await showMenu()
    assert.ok(button('执行动作') === undefined, 'action.run is required in the execution project')
    assert.ok(button('填写要求'))
    await act(async () => useGatewaySessionStore.setState({ session: { host_project_id: execution.id, access_level: 'read', permissions: ['session.read'] } as never }))
    assert.ok(button('填写要求') === undefined)
    assert.ok(document.querySelector('textarea') === null)
    assert.equal(mutations.length, writes, 'revoked and read-only shortcuts never execute')
  } finally { await act(async () => root.unmount()); globalThis.fetch = previousFetch; useProjectStore.setState(previousProject); useChatListStore.setState(previousList); useGatewaySessionStore.setState(previousGateway); await window.happyDOM.close() }
})

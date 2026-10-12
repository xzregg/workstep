import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { useGatewaySessionStore } from '../src/stores/gatewaySessionStore'
import ProjectSettingsPanel from '../src/components/ProjectSettingsPanel'
import SkillCenterSettings from '../src/pages/SkillCenterSettings'
import ShareDialog from '../src/components/ShareDialog'
import AssistantChatPanel from '../src/components/AssistantChatPanel'
import { skillApi, projectApi } from '../src/api/client'
import { installDomEnvironment } from './helpers/domEnv'

const project = { id: 'host', name: 'Demo', path: '/demo', steps: {}, workflows: [] }
function session(permissions: string[]) {
  useGatewaySessionStore.setState({ session: {
    device_id: 'device', device_name: 'PC', username: 'Alice', gateway_url: 'http://localhost:8700',
    project_id: 'platform', host_project_id: 'host', access_level: 'edit', task_create: true,
    share_create: true, can_manage_project_access: false, permissions,
  } })
}

test('running shortcuts does not require permission to send project chat messages', async () => {
  const { window } = installDomEnvironment(); window.happyDOM.setURL('http://d-device.localhost:8700/')
  session(['session.read', 'action.run'])
  let selected = 0
  const element = document.body.appendChild(document.createElement('div')), root = createRoot(element)
  try {
    await act(async () => root.render(<I18nProvider><AssistantChatPanel projectId="host" title="Chat" messages={[]}
      running={false} stopping={false} input="" locale="zh-CN"
      copy={{ emptyIntro: '', thinking: '', me: '用户', meInitials: 'U', agent: '助手', agentInitials: 'AI', placeholder: '', fullPrompt: '', closePrompt: '' }}
      attachmentPrefix="test" onInputChange={() => {}} onSend={() => {}} onSendContent={async () => true} onStop={() => {}}
      quickPrompts={[{ id: 'run', label: '运行脚本', kind: 'action', prompt: '' }, { id: 'prompt', label: '发送提示', prompt: 'hello' }]}
      onQuickPromptItemSelect={() => { selected++ }} /></I18nProvider>))
    const run = [...element.querySelectorAll('button')].find(button => button.textContent === '运行脚本')
    assert.ok(run)
    assert.doesNotMatch(element.textContent ?? '', /发送提示/)
    assert.equal(element.querySelector('.chat-input'), null)
    await act(async () => run.click()); assert.equal(selected, 1)
    await act(async () => session(['session.read']))
    assert.doesNotMatch(element.textContent ?? '', /运行脚本/)
  } finally { await act(async () => root.unmount()); useGatewaySessionStore.setState({ session: null }); await window.happyDOM.close() }
})

test('project settings expose Skills independently and hide operations after permission revocation', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL('http://d-device.localhost:8700/')
  useLocaleStore.setState({ locale: 'zh-CN' })
  session(['skill.read'])
  const oldList = skillApi.list, oldRescan = skillApi.rescan
  const writes: string[] = []
  const result = { project_id: 'host', project_name: 'Demo', project_path: '/demo', compatible_engines: [], takes_effect: 'next_run' as const,
    skills: [{ skill_id: 's', name: 'Demo skill', description: 'Description', source: 'project', source_path: '/demo/SKILL.md', valid: true, enabled: false, sync_status: 'disabled' as const, conflict: false }] }
  skillApi.list = async () => result
  skillApi.rescan = async () => { writes.push('rescan'); return result }
  const element = document.body.appendChild(document.createElement('div')), root = createRoot(element)
  try {
    await act(async () => root.render(<I18nProvider><ProjectSettingsPanel project={project} onClose={() => {}} /></I18nProvider>))
    const tab = [...element.querySelectorAll('button')].find(button => button.textContent === '技能中心')
    assert.ok(tab, 'Skills-only users need a settings entrance and tab')
    await act(async () => tab.click())
    assert.match(element.textContent ?? '', /Demo skill/)
    assert.equal(element.querySelector('[role="switch"]'), null)
    assert.equal([...element.querySelectorAll('button')].some(button => button.textContent?.includes('重新扫描')), false)
    await act(async () => session(['skill.read', 'skill.manage']))
    assert.ok(element.querySelector('[role="switch"]'))
    const rescan = [...element.querySelectorAll('button')].find(button => button.textContent?.includes('重新扫描'))!
    await act(async () => rescan.click())
    assert.deepEqual(writes, ['rescan'])
    await act(async () => session([]))
    assert.doesNotMatch(element.textContent ?? '', /Demo skill/)
    await act(async () => root.render(<I18nProvider><SkillCenterSettings project={project} /></I18nProvider>))
    assert.doesNotMatch(element.textContent ?? '', /Demo skill/)
  } finally {
    await act(async () => root.unmount()); skillApi.list = oldList; skillApi.rescan = oldRescan
    useGatewaySessionStore.setState({ session: null }); await window.happyDOM.close()
  }
})

test('share managers can revoke existing links without exposing share creation', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL('http://d-device.localhost:8700/')
  useLocaleStore.setState({ locale: 'zh-CN' }); session(['share.manage'])
  let revoked = 0, created = 0
  const api = { get: async () => ({ token: 'token', url: 'http://localhost:8700/share/token', created_at: '', mode: 'read_only' as const }),
    create: async () => { created++; throw new Error('unexpected') }, revoke: async () => { revoked++ } }
  const element = document.body.appendChild(document.createElement('div')), root = createRoot(element)
  try {
    await act(async () => root.render(<I18nProvider><ShareDialog open taskId="t" projectId="host" gateway api={api} onClose={() => {}} /></I18nProvider>))
    const revoke = [...element.querySelectorAll('button')].find(button => button.textContent?.includes('撤销分享'))!
    assert.ok(revoke)
    await act(async () => revoke.click())
    const confirm = [...element.querySelectorAll('button')].filter(button => button.textContent?.includes('撤销分享')).at(-1)!
    await act(async () => confirm.click())
    assert.equal(revoked, 1)
    assert.equal(element.querySelector('input[type="password"]'), null)
    assert.equal(created, 0)
  } finally { await act(async () => root.unmount()); useGatewaySessionStore.setState({ session: null }); await window.happyDOM.close() }
})

for (const [permission, label] of [['session.config', '对话助手'], ['action.manage', '快捷按钮'], ['project.settings', '并发限制']]) {
  test(`${permission} exposes its own settings tab without granting the other settings`, async () => {
    const { window } = installDomEnvironment(); window.happyDOM.setURL('http://d-device.localhost:8700/')
    useLocaleStore.setState({ locale: 'zh-CN' }); session([permission])
    const oldSettings = projectApi.settings
    const calls: unknown[][] = []
    let closed = 0
    projectApi.settings = async (...args) => {
      calls.push(args)
      return { name: 'Demo', chat_system_prompt: '', quick_buttons: [], concurrency: { project: {}, effective: { max_tasks: 2, max_chats: 2, schedule_exempt: false } } } as any
    }
    const element = document.body.appendChild(document.createElement('div')), root = createRoot(element)
    try {
      await act(async () => root.render(<I18nProvider><ProjectSettingsPanel project={project} onClose={() => { closed++ }} /></I18nProvider>))
      assert.deepEqual(calls, [])
      const tabs = [...element.querySelectorAll('nav button')]
      const allowed = tabs.find(tab => tab.textContent === label)
      assert.ok(allowed, label)
      for (const other of ['对话助手', '快捷按钮', '并发限制', '技能中心'].filter(item => item !== label)) {
        assert.equal(tabs.some(tab => tab.textContent === other), false, other)
      }
      await act(async () => allowed.click())
      assert.deepEqual(calls, [['host', false]])
      if (permission === 'project.settings') {
        await act(async () => element.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
        await act(async () => element.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.click())
        assert.equal(closed, 0)
        assert.match(document.body.textContent ?? '', /尚未保存/)
      }
      await act(async () => session([]))
      assert.equal([...element.querySelectorAll('nav button')].some(tab => tab.textContent === label), false)
      assert.equal(element.querySelector('textarea'), null)
    } finally { await act(async () => root.unmount()); projectApi.settings = oldSettings; useGatewaySessionStore.setState({ session: null }); await window.happyDOM.close() }
  })
}

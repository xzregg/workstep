import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import ChatPage from '../src/pages/ChatPage'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { useProjectStore } from '../src/stores/projectStore'
import { useGatewaySessionStore } from '../src/stores/gatewaySessionStore'
import { chatRoleApi } from '../src/api/chatRoles'
import { roleCenterApi } from '../src/api/roleCenter'

for (const projectScoped of [false, true]) test(`phone gateway ${projectScoped ? 'project ticket keeps host role assets hidden' : 'whole-device workspace shows role selection in the plus sheet'}`, async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL('http://d-device.localhost:8700/chat')
  window.happyDOM.setWindowSize({ width: 390, height: 844 })
  Object.assign(globalThis, { history: window.history })
  useLocaleStore.setState({ locale: 'zh-CN', language: null })
  const oldFetch = globalThis.fetch, oldGet = chatRoleApi.get, oldCatalog = roleCenterApi.catalog
  const oldProjects = useProjectStore.getState(), oldGateway = useGatewaySessionStore.getState()
  const project = { id: 'phone-project', name: 'phone', path: '/tmp/phone', workflows: [], steps: {}, type: 'local' as const }
  useProjectStore.setState({ projects: [project], activeProject: project, loading: false })
  useGatewaySessionStore.setState({ session: {
    device_id: 'device', device_name: 'PC', username: 'user', gateway_url: 'http://localhost:8700/devices',
    project_id: projectScoped ? 'published' : null, host_project_id: projectScoped ? project.id : null,
    access_level: projectScoped ? 'edit' : null, task_create: true, share_create: true, can_manage_project_access: true,
  }, loading: false, error: '' })
  let bindingGets = 0
  chatRoleApi.get = async () => { bindingGets++; return { binding: null, name: '', missing: false } }
  roleCenterApi.catalog = async () => ({ roles: [], teams: [], categories: [], warnings: [] })
  globalThis.fetch = async input => {
    const url = String(input)
    if (url.includes('/chat-sessions/phone-session')) return Response.json({ id: 'phone-session', project_id: project.id,
      title: '手机对话', messages: [], engine: 'pydantic_ai', running: false, source: 'chat' })
    if (url.includes('/assistants')) return Response.json({ assistants: [{ name: 'chat_session',
      configured: { engine: 'pydantic_ai' }, resolved: {}, available_engines: [] }] })
    return Response.json({ providers: [], buttons: [], sessions: [], runs: [], active_action_ids: [] })
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={['/chat?project=phone&session=phone-session']}>
      <I18nProvider><ChatPage /></I18nProvider>
    </MemoryRouter>))
    const plus = document.querySelector<HTMLButtonElement>('.chat-input-attach')
    assert.ok(plus)
    await act(async () => plus.click())
    const sheet = document.querySelector('.mobile-sheet')
    assert.ok(sheet)
    const roleButton = [...sheet.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === '角色／专家团')
    assert.equal(Boolean(roleButton), !projectScoped)
    assert.equal(bindingGets, projectScoped ? 0 : 1)
    if (roleButton) {
      await act(async () => roleButton.click())
      assert.ok(document.querySelector('.chat-role-picker[role="dialog"]'))
      assert.equal(document.querySelector('.mobile-sheet'), null)
    }
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = oldFetch; chatRoleApi.get = oldGet; roleCenterApi.catalog = oldCatalog
    useProjectStore.setState(oldProjects); useGatewaySessionStore.setState(oldGateway)
    await window.happyDOM.close()
  }
})

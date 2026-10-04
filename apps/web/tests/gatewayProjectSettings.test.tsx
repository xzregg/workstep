import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ProjectSettingsPanel from '../src/components/ProjectSettingsPanel'
import GatewayTaskShareLink from '../src/components/GatewayTaskShareLink'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { useGatewaySessionStore } from '../src/stores/gatewaySessionStore'

test('remote settings reuse grants UI and task sharing stays on the Gateway main host', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  window.happyDOM.setURL('http://d-device-1.localhost:8700/')
  const oldFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = async input => {
    calls.push(String(input))
    assert.equal(String(input), '/api/remote/project-grants')
    return Response.json({ grants: [{ subject_type: 'group', subject_id: 'group-1',
      subject_name: 'Backend', access_level: 'read' }] })
  }
  useGatewaySessionStore.setState({ session: {
    device_id: 'device-1', device_name: 'PC', username: 'Alice', gateway_url: 'http://localhost:8700/devices',
    project_id: 'platform-1', host_project_id: 'host-1', access_level: 'edit',
    task_create: false, share_create: true, can_manage_project_access: false,
  } })
  const element = document.body.appendChild(document.createElement('div'))
  const root = createRoot(element)
  try {
    await act(async () => root.render(<I18nProvider>
      <ProjectSettingsPanel project={{ id: 'host-1', name: 'Visible', path: '', workflows: [], steps: {} }} onClose={() => {}} />
      <GatewayTaskShareLink taskId="task-1" projectId="host-1" />
    </I18nProvider>))
    assert.equal(calls.length, 0)
    const accessTab = [...element.querySelectorAll('button')].find(button => button.textContent === '访问授权')
    assert.ok(accessTab)
    await act(async () => accessTab.click())
    assert.match(element.textContent ?? '', /用户组 · Backend · 只读/)
    assert.deepEqual(calls, ['/api/remote/project-grants'])
    assert.equal(element.querySelector('a')?.getAttribute('href'),
      'http://localhost:8700/shares/new?project_id=platform-1&task_id=task-1')
    await act(async () => useGatewaySessionStore.setState(state => ({
      session: { ...state.session!, share_create: false, can_manage_project_access: true },
    })))
    assert.equal(element.querySelector('.task-detail-share-button'), null)
  } finally {
    await act(async () => root.unmount())
    element.remove()
    globalThis.fetch = oldFetch
    useGatewaySessionStore.setState({ session: null, loading: false, error: '' })
    await window.happyDOM.close()
  }
})

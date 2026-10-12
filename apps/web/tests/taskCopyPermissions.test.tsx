import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import TaskCopyButton from '../src/components/TaskCopyButton'
import { I18nProvider } from '../src/i18n'
import { useGatewaySessionStore } from '../src/stores/gatewaySessionStore'
import { useTaskStore } from '../src/stores/taskStore'
import { taskApi } from '../src/api/client'
import { installDomEnvironment } from './helpers/domEnv'

test('copy permission owns its entry and sends the correct project and title to the existing API', async () => {
  const { window } = installDomEnvironment(); window.happyDOM.setURL('http://d-device.localhost:8700/')
  const oldCopy = taskApi.copy, state = useTaskStore.getState()
  const calls: string[][] = []
  taskApi.copy = async (...args) => { calls.push(args); return { id: 'copy' } as any }
  const setPermissions = (permissions: string[]) => useGatewaySessionStore.setState({ session: {
    device_id: 'device', device_name: 'PC', username: 'Alice', gateway_url: 'http://localhost:8700',
    project_id: 'platform', host_project_id: 'host', access_level: 'edit', task_create: true,
    share_create: false, can_manage_project_access: false, permissions,
  } })
  setPermissions(['task.read', 'task.create'])
  const element = document.body.appendChild(document.createElement('div')), root = createRoot(element)
  try {
    await act(async () => root.render(<I18nProvider><TaskCopyButton taskId="source" projectId="host" title="Demo" /></I18nProvider>))
    assert.equal(element.querySelector('button'), null)
    await act(async () => setPermissions(['task.read', 'task.create', 'task.copy']))
    await act(async () => element.querySelector<HTMLButtonElement>('button')!.click())
    assert.equal(calls.length, 1); assert.deepEqual(calls[0].slice(0, 2), ['source', 'host'])
    assert.match(calls[0][2], /Demo/)
    await act(async () => setPermissions(['task.read']))
    assert.equal(element.querySelector('button'), null)
  } finally {
    await act(async () => root.unmount()); taskApi.copy = oldCopy; useTaskStore.setState(state)
    useGatewaySessionStore.setState({ session: null }); await window.happyDOM.close()
  }
})

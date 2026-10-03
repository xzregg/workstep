import assert from 'node:assert/strict'
import test from 'node:test'
import { projectApi } from '../src/api/project'
import { useProjectStore } from '../src/stores/projectStore'
import { useGatewaySessionStore } from '../src/stores/gatewaySessionStore'

test('project workspace loads only its signed project and deduplicates session loading', async () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const oldFetch = globalThis.fetch
  Object.defineProperty(globalThis, 'window', { configurable: true,
    value: { location: { hostname: 'd-device-1.localhost', protocol: 'http:', port: '8700' } } })
  const calls: string[] = []
  globalThis.fetch = async input => {
    calls.push(String(input))
    if (String(input) === '/api/remote/session') return Response.json({
      device_id: 'device-1', device_name: 'PC', username: 'Alice', gateway_url: 'http://localhost:8700/devices',
      project_id: 'platform-1', host_project_id: 'host-1', access_level: 'read', task_create: false,
    })
    if (String(input) === '/api/project/host-1/summary') return Response.json({
      id: 'host-1', name: 'Scoped', steps: { steps: [] },
      workflows: [{ id: 'flow-1', name: 'Flow', is_default: true, nodeCount: 0 }],
    })
    throw new Error(`Unexpected global request: ${input}`)
  }
  try {
    useGatewaySessionStore.setState({ session: null, error: '', loading: false })
    const stale = { id: 'private-2', name: 'Private', path: '/private', steps: {}, workflows: [] }
    useProjectStore.setState({ projects: [stale], activeProject: stale, activeWorkflowId: 'private-flow' })
    await Promise.all([useGatewaySessionStore.getState().load(), useGatewaySessionStore.getState().load()])
    await useProjectStore.getState().fetchProjects()
    assert.equal(calls.filter(path => path === '/api/remote/session').length, 1)
    assert.equal(useProjectStore.getState().activeProject?.id, 'host-1')
    assert.equal(useProjectStore.getState().activeProject?.path, '')
    assert.equal(useProjectStore.getState().activeWorkflowId, 'flow-1')
    assert.equal(useProjectStore.getState().projects.length, 1)
    globalThis.fetch = async input => {
      assert.equal(String(input), '/api/remote/project-grants')
      return Response.json({ grants: [{ subject_type: 'group', subject_id: 'group-1',
        subject_name: 'Backend', access_level: 'read' }] })
    }
    const access = await projectApi.publication('host-1')
    assert.equal(access.can_publish, false)
    assert.equal(access.can_manage, false)
    assert.equal(access.gateway_url, 'http://localhost:8700')
    assert.equal(access.grants[0]?.subject_name, 'Backend')
    await assert.rejects(projectApi.publication('private-2'), /项目/)
    globalThis.fetch = async () => Response.json({ id: 'private-2', name: 'Private' })
    await assert.rejects(projectApi.list(), /项目/)
  } finally {
    globalThis.fetch = oldFetch
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    useGatewaySessionStore.setState({ session: null, error: '', loading: false })
    useProjectStore.setState({ projects: [], activeProject: null, activeWorkflowId: null })
  }
})

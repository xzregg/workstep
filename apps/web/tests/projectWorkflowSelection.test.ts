import assert from 'node:assert/strict'
import test from 'node:test'
import { workflowApi, type Project } from '../src/api/client.ts'
import { useProjectStore } from '../src/stores/projectStore.ts'

test('a stale workflow response cannot replace the selected workflow steps', async () => {
  const original = workflowApi.get
  let finishDefault!: (value: any) => void
  let finishSimple!: (value: any) => void
  workflowApi.get = async (id) => new Promise(resolve => {
    if (id === 'default') finishDefault = resolve
    else finishSimple = resolve
  })
  const project = {
    id: 'project', name: '项目', path: '/tmp/project', steps: { marker: 'initial' },
    workflows: [
      { id: 'default', name: '默认流程', is_default: true },
      { id: 'simple', name: '简单流程', is_default: false },
    ],
  } as Project
  useProjectStore.setState({ projects: [project], activeProject: project, activeWorkflowId: 'default' })

  try {
    const staleRequest = useProjectStore.getState().setActiveWorkflow('default')
    const selectedRequest = useProjectStore.getState().setActiveWorkflow('simple')
    finishSimple({ id: 'simple', steps: { marker: 'simple' } })
    await selectedRequest
    finishDefault({ id: 'default', steps: { marker: 'default' } })
    await staleRequest

    assert.equal(useProjectStore.getState().activeWorkflowId, 'simple')
    assert.deepEqual(useProjectStore.getState().activeProject?.steps, { marker: 'simple' })
  } finally {
    workflowApi.get = original
  }
})

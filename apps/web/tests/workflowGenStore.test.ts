import assert from 'node:assert/strict'
import test from 'node:test'

import { useWorkflowGenStore } from '../src/stores/workflowGenStore.ts'


test('keeps the generated workflow name on proposal cards', () => {
  useWorkflowGenStore.setState({ sessions: {} })
  const store = useWorkflowGenStore.getState()
  store.newSession('flow-1')
  store.handleWsEvent({
    type: 'CUSTOM',
    name: 'workstep.flow_proposals',
    channel: 'flow_gen',
    session_id: 'flow-1',
    messageId: 'assistant-1',
    value: {
      proposals: [{
        id: 'p1',
        title: '标准版',
        workflowName: '发布流程',
        summary: '需求到发布',
        steps: { nodes: [], connections: [] },
      }],
    },
  })

  assert.equal(
    useWorkflowGenStore.getState().sessions['flow-1'].latestProposals[0]?.workflowName,
    '发布流程',
  )
})

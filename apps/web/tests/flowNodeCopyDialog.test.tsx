import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import { projectApi, workflowApi } from '../src/api/client'
import FlowNodeCopyDialog from '../src/components/FlowNodeCopyDialog'
import type { StepNodeData } from '../src/components/flowCanvasData'

test('copy dialog loads a workflow, selects a step, and returns its data', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const originalProjects = projectApi.list
  const originalWorkflow = workflowApi.get
  const copied: StepNodeData[] = []
  projectApi.list = async () => ({ projects: [{
    id: 'project-1', name: 'Project One', workflows: [{ id: 'workflow-1', name: 'Flow One', nodeCount: 1 }],
  }] }) as Awaited<ReturnType<typeof projectApi.list>>
  workflowApi.get = async () => ({ steps: { nodes: [{ id: 1, type: 'build', title: 'Build step', inputs: [], outputs: [] }], connections: [] } }) as Awaited<ReturnType<typeof workflowApi.get>>
  try {
    await act(async () => root.render(<I18nProvider><FlowNodeCopyDialog
      onClose={() => {}}
      onCopy={(node) => copied.push(node)}
    /></I18nProvider>))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const step = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Build step'))
    assert.ok(step)
    await act(async () => step.click())
    const confirm = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('复制') || button.textContent?.includes('Copy'))
    assert.ok(confirm)
    assert.equal(confirm.disabled, false)
    await act(async () => confirm.click())
    assert.equal(copied.length, 1)
    assert.equal(copied[0].key, 'build')
  } finally {
    projectApi.list = originalProjects
    workflowApi.get = originalWorkflow
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

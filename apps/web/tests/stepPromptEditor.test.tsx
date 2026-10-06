// React DOM must see the test DOM during module initialization.
import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import { workflowApi } from '../src/api/client'
import StepPromptEditor from '../src/components/StepPromptEditor'

test('loads the bound workflow and saves only its selected prompt', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const originalSaveSteps = workflowApi.updateStepPrompt
  const originalGet = workflowApi.get
  const saved: any[] = []
  const published: any[] = []
  let closed = 0
  workflowApi.updateStepPrompt = async (workflowId, projectId, stepKey, prompt) => {
    saved.push({ workflowId, projectId, stepKey, prompt })
    return { steps: { nodes: [{ type: 'build', prompt }, { type: 'review', prompt: 'latest' }] } }
  }
  const project = {
    id: 'project-1', path: '/tmp/project-1', name: 'Example', workflows: [],
    steps: { nodes: [{ type: 'build', prompt: 'old' }, { type: 'review', prompt: 'keep' }] },
  }
  workflowApi.get = async (id, projectId) => {
    assert.equal(id, 'selected-flow')
    assert.equal(projectId, project.id)
    return { id, steps: { nodes: [{ type: 'build', prompt: 'bound-flow-prompt' }] } } as any
  }
  try {
    await act(async () => root.render(<I18nProvider><StepPromptEditor
      project={project} projectId={project.id} workflowId="selected-flow"
      step={{ key: 'build', label: 'Build', color: '#123456', prompt: 'old', inputs: [], outputs: [] }}
      onSaved={(steps) => published.push(steps)} onClose={() => { closed += 1 }}
    /></I18nProvider>))
    const editor = container.querySelector<HTMLTextAreaElement>('.markdown-editor-input')
    assert.ok(editor)
    assert.equal(editor.value, 'bound-flow-prompt')
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, 'new')
      editor.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    const saveButton = container.querySelector<HTMLButtonElement>('.dialog-footer button:last-child')
    assert.ok(saveButton)
    await act(async () => saveButton.click())
    assert.equal(saved.length, 1)
    assert.equal(saved[0].projectId, project.id)
    assert.deepEqual(saved[0], { workflowId: 'selected-flow', projectId: project.id, stepKey: 'build', prompt: 'new' })
    assert.equal(published[0].nodes[1].prompt, 'latest')
    assert.equal(published.length, 1)
    assert.equal(closed, 1)
  } finally {
    workflowApi.updateStepPrompt = originalSaveSteps
    workflowApi.get = originalGet
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('missing bound workflow disables saving instead of falling back to default', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const originalGet = workflowApi.get
  workflowApi.get = async () => { throw new Error('Workflow not found') }
  try {
    await act(async () => root.render(<I18nProvider><StepPromptEditor
      project={{ id: 'project-1', path: '/tmp/project-1', name: 'Example', workflows: [], steps: {} }}
      projectId="project-1" workflowId="missing"
      step={{ key: 'build', label: 'Build', color: 'var(--accent)', prompt: 'old', inputs: [], outputs: [] }}
      onSaved={() => assert.fail('must not save')} onClose={() => {}}
    /></I18nProvider>))
    assert.equal(container.querySelector<HTMLButtonElement>('.dialog-footer button:last-child')!.disabled, true)
    assert.match(container.querySelector('[role="alert"]')?.textContent || '', /Workflow not found/)
  } finally {
    workflowApi.get = originalGet
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('save failure keeps the prompt editor open and shows the error', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const originalSaveSteps = workflowApi.updateStepPrompt
  const originalGet = workflowApi.get
  workflowApi.get = async () => ({ steps: { nodes: [{ type: 'build', prompt: 'old' }] } } as any)
  workflowApi.updateStepPrompt = async () => { throw new Error('Disk busy') }
  let closed = 0
  try {
    await act(async () => root.render(<I18nProvider><StepPromptEditor
      project={{ id: 'project-1', path: '/tmp/project-1', name: 'Example', workflows: [],
        steps: { nodes: [{ type: 'build', prompt: 'old' }] } }}
      projectId="project-1" workflowId="selected-flow"
      step={{ key: 'build', label: 'Build', color: '#123456', prompt: 'old', inputs: [], outputs: [] }}
      onSaved={() => { throw new Error('unexpected success') }}
      onClose={() => { closed += 1 }}
    /></I18nProvider>))
    await act(async () => container.querySelector<HTMLButtonElement>('.dialog-footer button:last-child')!.click())
    assert.match(container.querySelector('[role="alert"]')?.textContent || '', /Disk busy/)
    assert.equal(closed, 0)
    assert.ok(container.querySelector('[role="dialog"]'))
  } finally {
    workflowApi.updateStepPrompt = originalSaveSteps
    workflowApi.get = originalGet
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

// React DOM must see the test DOM during module initialization.
import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import { projectApi } from '../src/api/client'
import StepPromptEditor, { replaceProjectStepPrompt } from '../src/components/StepPromptEditor'

test('editing a node prompt preserves other steps and graph metadata', () => {
  const steps = {
    nodes: [{ type: 'build', prompt: 'old' }, { type: 'review', prompt: 'keep' }],
    connections: [{ from: 'build', to: 'review' }],
  }
  const updated = replaceProjectStepPrompt(steps, 'build', 'new')
  assert.deepEqual(updated, {
    nodes: [{ type: 'build', prompt: 'new' }, { type: 'review', prompt: 'keep' }],
    connections: steps.connections,
  })
  assert.equal(steps.nodes[0].prompt, 'old')
})

test('legacy step definitions update only the selected prompt', () => {
  const steps = { steps: [{ key: 'build', prompt: 'old' }, { id: 'review', prompt: 'keep' }] }
  assert.deepEqual(replaceProjectStepPrompt(steps, 'review', 'new'), {
    steps: [{ key: 'build', prompt: 'old' }, { id: 'review', prompt: 'new' }],
  })
})

test('saving a step prompt persists the selected project steps and closes the editor', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const originalSaveSteps = projectApi.saveSteps
  const saved: Array<{ projectId: string; steps: any }> = []
  const published: any[] = []
  let closed = 0
  projectApi.saveSteps = async (projectId, steps) => {
    saved.push({ projectId, steps })
    return { saved: true }
  }
  const project = {
    id: 'project-1', path: '/tmp/project-1', name: 'Example', workflows: [],
    steps: { nodes: [{ type: 'build', prompt: 'old' }, { type: 'review', prompt: 'keep' }] },
  }
  try {
    await act(async () => root.render(<I18nProvider><StepPromptEditor
      project={project} projectId={project.id}
      step={{ key: 'build', label: 'Build', color: '#123456', prompt: 'old', inputs: [], outputs: [] }}
      onSaved={(steps) => published.push(steps)} onClose={() => { closed += 1 }}
    /></I18nProvider>))
    const editor = container.querySelector<HTMLTextAreaElement>('.markdown-editor-input')
    assert.ok(editor)
    assert.equal(editor.value, 'old')
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, 'new')
      editor.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    const saveButton = container.querySelector<HTMLButtonElement>('.dialog-footer button:last-child')
    assert.ok(saveButton)
    await act(async () => saveButton.click())
    assert.equal(saved.length, 1)
    assert.equal(saved[0].projectId, project.id)
    assert.equal(saved[0].steps.nodes[0].prompt, 'new')
    assert.equal(saved[0].steps.nodes[1].prompt, 'keep')
    assert.equal(published.length, 1)
    assert.equal(closed, 1)
  } finally {
    projectApi.saveSteps = originalSaveSteps
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('save failure keeps the prompt editor open and shows the error', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const originalSaveSteps = projectApi.saveSteps
  projectApi.saveSteps = async () => { throw new Error('Disk busy') }
  let closed = 0
  try {
    await act(async () => root.render(<I18nProvider><StepPromptEditor
      project={{ id: 'project-1', path: '/tmp/project-1', name: 'Example', workflows: [],
        steps: { nodes: [{ type: 'build', prompt: 'old' }] } }}
      projectId="project-1"
      step={{ key: 'build', label: 'Build', color: '#123456', prompt: 'old', inputs: [], outputs: [] }}
      onSaved={() => { throw new Error('unexpected success') }}
      onClose={() => { closed += 1 }}
    /></I18nProvider>))
    await act(async () => container.querySelector<HTMLButtonElement>('.dialog-footer button:last-child')!.click())
    assert.match(container.querySelector('[role="alert"]')?.textContent || '', /Disk busy/)
    assert.equal(closed, 0)
    assert.ok(container.querySelector('[role="dialog"]'))
  } finally {
    projectApi.saveSteps = originalSaveSteps
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

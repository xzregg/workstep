import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import ArtifactOutputsEditor from '../src/components/ArtifactOutputsEditor'
import { loadCanvasData } from '../src/components/flowCanvasData'

test('canvas import keeps templates on both nested and flat outputs', () => {
  const output = { name: 'report', type: 'md', template: '# Summary\n[One sentence]' }
  const parsed = loadCanvasData({ nodes: [{ id: 1, type: 'build', inputs: [{ name: 'request', type: 'md', outputs: [output] }], outputs: [output] }], connections: [] })
  assert.equal(parsed.nodes[0].outputs[0].template, output.template)
  assert.equal(parsed.nodes[0].inputs[0].outputs[0].template, output.template)
})

test('template editor is a dialog before suffix; save and clear do not rename a protected output', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const updates: any[] = []
  try {
    await act(async () => root.render(<I18nProvider><ArtifactOutputsEditor outputs={[{ name: 'report', type: 'md' }]}
      protectedCount={1} onChange={outputs => updates.push(outputs)} /></I18nProvider>))
    const button = container.querySelector<HTMLButtonElement>('.artifact-template-button')!
    assert.ok(button)
    assert.equal(button.disabled, false)
    assert.equal(container.querySelector('[role="dialog"]'), null)
    await act(async () => button.click())
    const editor = document.querySelector<HTMLTextAreaElement>('.artifact-template-dialog textarea')!
    assert.ok(editor)
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, '# Simple')
      editor.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await act(async () => document.querySelector<HTMLButtonElement>('.artifact-template-dialog .dialog-footer button:last-child')!.click())
    assert.deepEqual(updates[0], [{ name: 'report', type: 'md', template: '# Simple' }])
    assert.equal(document.querySelector('.artifact-template-dialog'), null)
  } finally { await act(async () => root.unmount()); container.remove(); await window.happyDOM.close() }
})

import ArtifactTemplateDialog from '../src/components/ArtifactTemplateDialog'
import TaskArtifactTemplateEditor, { setOutputTemplate } from '../src/components/TaskArtifactTemplateEditor'
import TaskStepIoPanel from '../src/components/TaskStepIoPanel'
import { taskWorkflowApi } from '../src/api/taskWorkflow'

async function editText(window: any, value: string) {
  const editor = document.querySelector<HTMLTextAreaElement>('.artifact-template-dialog textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, value)
    editor.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

test('dirty close is guarded, failed save retains draft, blank saves disable the template', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let closed = 0
  let failed = true
  const saved: string[] = []
  try {
    await act(async () => root.render(<I18nProvider><ArtifactTemplateDialog name="report" value="# Original"
      onClose={() => closed++} onSave={value => { if (failed) throw new Error('Conflict'); saved.push(value) }} /></I18nProvider>))
    await editText(window, '# Changed')
    await act(async () => document.querySelector<HTMLButtonElement>('.artifact-template-dialog .dialog-footer button:first-child')!.click())
    assert.ok(document.querySelector('.confirm-dialog-panel'))
    assert.equal(closed, 0)
    await act(async () => document.querySelector<HTMLButtonElement>('.confirm-dialog-footer button:first-child')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('.artifact-template-dialog .dialog-footer button:last-child')!.click())
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /Conflict/)
    assert.equal(document.querySelector<HTMLTextAreaElement>('.artifact-template-dialog textarea')!.value, '# Changed')
    failed = false
    await editText(window, '')
    await act(async () => document.querySelector<HTMLButtonElement>('.artifact-template-dialog .dialog-footer button:last-child')!.click())
    assert.deepEqual(saved, [''])
    assert.equal(closed, 1)
  } finally { await act(async () => root.unmount()); container.remove(); await window.happyDOM.close() }
})

test('task template updates only its output, restores source, and preserves source JSON', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const source = { nodes: [{ type: 'build', outputs: [{ name: 'report', type: 'md', template: '# Source' }],
    inputs: [{ name: 'request', type: 'md', outputs: [{ name: 'report', type: 'md', template: '# Source' }] }] }] }
  const workflow = setOutputTemplate(source, 'build', 0, '# Local')
  assert.equal(source.nodes[0].outputs[0].template, '# Source')
  assert.equal(workflow.nodes[0].inputs[0].outputs[0].template, '# Local')
  const configuration = { source, workflow, revision: 'r1', editable: true, conflict: null, has_overrides: true }
  const originalSave = taskWorkflowApi.save
  const calls: any[] = []
  taskWorkflowApi.save = async (...args) => { calls.push(args); return configuration }
  try {
    await act(async () => root.render(<I18nProvider><TaskArtifactTemplateEditor taskId="task" projectId="project"
      stepKey="build" outputIndex={0} name="report" value="# Local" configuration={configuration}
      onSaved={() => {}} onClose={() => {}} /></I18nProvider>))
    await act(async () => document.querySelector<HTMLButtonElement>('.artifact-template-reset')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('.artifact-template-dialog .dialog-footer button:last-child')!.click())
    assert.equal(calls[0][0], 'task')
    assert.equal(calls[0][1], 'project')
    assert.equal(calls[0][3], 'r1')
    assert.deepEqual(calls[0][2], source)
  } finally { taskWorkflowApi.save = originalSave; await act(async () => root.unmount()); container.remove(); await window.happyDOM.close() }
})

test('shared task can view templates; icon click never opens artifact or enables save', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let opened = 0
  const step = { key: 'build', label: 'Build', prompt: '', inputs: [{ name: 'request', type: 'md' }],
    outputs: [{ name: 'report', type: 'md', template: '# Shared' }] }
  const artifact = { name: 'report', logical_name: 'report', step_key: 'build', round: 1,
    path: 'report.md', output_port: 0, declared_output: true } as any
  try {
    await act(async () => root.render(<I18nProvider><TaskStepIoPanel currentStep={step} steps={[step]}
      workflowConnections={[]} artifacts={[artifact]} artifactInputSnapshots={[]} canChat={false}
      locale="zh-CN" onOpenArtifact={() => opened++} /></I18nProvider>))
    const icon = container.querySelector<HTMLButtonElement>('.artifact-template-button')!
    assert.equal(icon.dataset.configured, 'true')
    assert.equal(icon.previousElementSibling?.className, 'task-step-io-name')
    await act(async () => icon.click())
    assert.equal(opened, 0)
    const editor = document.querySelector<HTMLTextAreaElement>('.artifact-template-dialog textarea')!
    assert.equal(editor.value, '# Shared')
    assert.equal(editor.readOnly, true)
    assert.equal(document.querySelectorAll('.artifact-template-dialog .dialog-footer button').length, 1)
  } finally { await act(async () => root.unmount()); container.remove(); await window.happyDOM.close() }
})

test('root step without input ports still exposes its output template', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const step = { key: 'root', label: 'Root', prompt: '', inputs: [], outputs: [{ name: 'report', type: 'md' }] }
  try {
    await act(async () => root.render(<I18nProvider><TaskStepIoPanel currentStep={step} steps={[step]}
      workflowConnections={[]} artifacts={[]} artifactInputSnapshots={[]} canChat={false}
      locale="zh-CN" onOpenArtifact={() => {}} /></I18nProvider>))
    assert.equal(container.querySelectorAll('.task-step-io-input').length, 0)
    const icon = container.querySelector<HTMLButtonElement>('.artifact-template-button')!
    assert.ok(icon)
    assert.equal(icon.dataset.configured, 'false')
    await act(async () => icon.click())
    assert.ok(document.querySelector('.artifact-template-dialog'))
  } finally { await act(async () => root.unmount()); container.remove(); await window.happyDOM.close() }
})

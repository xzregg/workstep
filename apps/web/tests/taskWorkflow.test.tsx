import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import { taskApi, workflowApi } from '../src/api/client'
import { taskWorkflowApi, type TaskWorkflowConfiguration } from '../src/api/taskWorkflow'
import { useTaskStore } from '../src/stores/taskStore'
import { useTaskWorkflow } from '../src/hooks/useTaskWorkflow'
import ArtifactOutputsEditor from '../src/components/ArtifactOutputsEditor'
import StepPromptEditor from '../src/components/StepPromptEditor'
import TaskWorkflowTools from '../src/components/TaskWorkflowTools'
import { isTaskCompleted } from '../src/pages/taskDetailChat'

const config = (): TaskWorkflowConfiguration => ({
  workflow: { nodes: [{ id: 'build', type: 'build', prompt: 'task prompt', inputs: [], outputs: [] }], connections: [] },
  source: { nodes: [{ id: 'build', type: 'build', prompt: 'source prompt', inputs: [], outputs: [] }], connections: [] },
  revision: 'revision-1', editable: true, has_overrides: true, conflict: null,
})

test('historical stages removed by sync do not prevent completion of the current workflow', () => {
  assert.equal(isTaskCompleted([
    { status: 'passed', started_at: 'now', in_workflow: true },
    { status: 'pending', started_at: null, in_workflow: false },
  ]), true)
})

test('task prompt quick edit saves a task overlay, never the source workflow', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const originalSave = taskWorkflowApi.save
  const originalGet = workflowApi.get
  const value = config()
  const calls: any[] = []
  taskWorkflowApi.save = async (...args) => { calls.push(args); return { ...value, workflow: args[2], revision: 'revision-2' } }
  workflowApi.get = async () => { assert.fail('must not read the source workflow') }
  let saved = ''
  try {
    await act(async () => root.render(<I18nProvider><StepPromptEditor
      project={{ id: 'p' } as any} projectId="p" workflowId="flow" taskId="task" taskWorkflow={value}
      step={{ key: 'build', label: 'Build', color: '#123456', prompt: 'task prompt', inputs: [], outputs: [] }}
      onSaved={() => undefined} onTaskSaved={(result) => { saved = result.revision }} onClose={() => undefined}
    /></I18nProvider>))
    const input = document.querySelector<HTMLTextAreaElement>('.markdown-editor-input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'changed prompt')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await act(async () => (document.querySelector('.dialog-footer button:last-child') as HTMLButtonElement).click())
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].slice(0, 2), ['task', 'p'])
    assert.equal(calls[0][2].nodes[0].prompt, 'changed prompt')
    assert.equal(value.workflow.nodes[0].prompt, 'task prompt')
    assert.equal(saved, 'revision-2')
  } finally {
    taskWorkflowApi.save = originalSave
    workflowApi.get = originalGet
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('original output names and types are locked while appended outputs are editable', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  function Harness() {
    const [outputs, update] = useState([{ name: 'prd', type: 'md' }])
    return <ArtifactOutputsEditor outputs={outputs} protectedCount={1} onChange={update} />
  }
  try {
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
    assert.ok(Array.from(container.querySelectorAll('input')).every((input) => input.disabled))
    assert.equal(container.querySelector<HTMLButtonElement>('.artifact-output-remove')!.disabled, true)
    await act(async () => (container.querySelector('.artifact-outputs-editor > button') as HTMLButtonElement).click())
    const rows = container.querySelectorAll('.artifact-output-row')
    assert.equal(rows.length, 2)
    assert.equal(rows[1].querySelector('input')!.disabled, false)
    assert.equal(rows[1].querySelector('button')!.disabled, false)
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})

test('configuration loader ignores a response from the previous task', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let first!: (value: TaskWorkflowConfiguration) => void
  let second!: (value: TaskWorkflowConfiguration) => void
  const a = () => new Promise<TaskWorkflowConfiguration>((resolve) => { first = resolve })
  const b = () => new Promise<TaskWorkflowConfiguration>((resolve) => { second = resolve })
  function Harness({ id, load }: { id: string; load: typeof a }) {
    const { configuration } = useTaskWorkflow(load, id, '')
    return <span>{configuration?.revision || 'loading'}</span>
  }
  try {
    await act(async () => root.render(<Harness id="a" load={a} />))
    await act(async () => root.render(<Harness id="b" load={b} />))
    await act(async () => second({ ...config(), revision: 'b' }))
    await act(async () => first({ ...config(), revision: 'a' }))
    assert.equal(container.textContent, 'b')
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})

test('starting a stage immediately makes the configuration read-only without a revision change', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let calls = 0
  const load = async () => { calls += 1; return config() }
  function Harness({ busy }: { busy: boolean }) {
    const { configuration } = useTaskWorkflow(load, 'same-task', 'unchanged-revision', busy)
    return <span>{configuration?.editable ? 'editable' : 'read-only'}</span>
  }
  try {
    await act(async () => root.render(<Harness busy={false} />))
    assert.equal(container.textContent, 'editable')
    await act(async () => root.render(<Harness busy />))
    assert.equal(container.textContent, 'read-only')
    assert.equal(calls, 2)
    await act(async () => root.render(<Harness busy={false} />))
    assert.equal(container.textContent, 'editable')
    assert.equal(calls, 3)
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})

test('a task save event and editor refresh share one in-flight task request', async () => {
  const original = taskApi.get
  let resolve!: (task: any) => void
  let calls = 0
  taskApi.get = () => { calls += 1; return new Promise((done) => { resolve = done }) }
  try {
    const first = useTaskStore.getState().refreshTask('workflow-test', 'p')
    const second = useTaskStore.getState().refreshTask('workflow-test', 'p')
    assert.equal(calls, 1)
    resolve({ id: 'workflow-test', title: 'Test' })
    await Promise.all([first, second])
  } finally { taskApi.get = original }
})

test('read-only task workflow entry remains available without mutation controls', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><TaskWorkflowTools
      taskId="task" projectId="p" configuration={config()} readOnly onChanged={() => assert.fail('read-only')}
    /></I18nProvider>))
    assert.match(container.textContent || '', /查看任务流程/)
    assert.equal(container.querySelectorAll('button').length, 1)
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})

test('task prompt draft is retained when the parent refreshes its configuration', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const value = config()
  const original = taskWorkflowApi.save
  const calls: any[] = []
  taskWorkflowApi.save = async (...args) => { calls.push(args); throw new Error('流程配置已变化') }
  const render = (configuration: TaskWorkflowConfiguration) => <I18nProvider><StepPromptEditor
    project={{ id: 'p' } as any} projectId="p" workflowId="flow" taskId="task" taskWorkflow={configuration}
    step={{ key: 'build', label: 'Build', color: '#123456', prompt: configuration.workflow.nodes[0].prompt, inputs: [], outputs: [] }}
    onSaved={() => undefined} onClose={() => undefined} /></I18nProvider>
  try {
    await act(async () => root.render(render(value)))
    const input = container.querySelector<HTMLTextAreaElement>('.markdown-editor-input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'unsaved draft')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    const next = config()
    next.revision = 'revision-2'
    next.workflow.nodes[0].prompt = 'background source update'
    await act(async () => root.render(render(next)))
    assert.equal(input.value, 'unsaved draft')
    await act(async () => (container.querySelector('.dialog-footer button:last-child') as HTMLButtonElement).click())
    assert.equal(calls[0][3], 'revision-1')
    assert.match(container.querySelector('[role="alert"]')!.textContent || '', /流程配置已变化/)
    assert.equal(input.value, 'unsaved draft')
  } finally {
    taskWorkflowApi.save = original
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('workflow sync requires confirmation and keeps the editor open on failure', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const oldFetch = globalThis.fetch
  const oldSync = taskWorkflowApi.sync
  Object.assign(globalThis, { ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
  globalThis.fetch = async () => Response.json({ engines: [], templates: [], resolved_engine: 'pydantic_ai' })
  let calls = 0
  taskWorkflowApi.sync = async () => { calls += 1; throw new Error('sync failed') }
  try {
    await import('../src/components/FlowCanvas')
    await act(async () => root.render(<I18nProvider><TaskWorkflowTools
      taskId="task" projectId="p" configuration={config()} onChanged={() => assert.fail('failed sync')}
    /></I18nProvider>))
    await act(async () => (container.querySelector('.task-workflow-tools button') as HTMLButtonElement).click())
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)) })
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === '同步主流程')
    assert.ok(button)
    await act(async () => button.click())
    assert.equal(calls, 0)
    await act(async () => (document.querySelector('.confirm-dialog-confirm') as HTMLButtonElement).click())
    assert.equal(calls, 1)
    assert.match(container.textContent || '', /sync failed/)
    assert.ok(container.querySelector('.task-workflow-panel'))
  } finally {
    globalThis.fetch = oldFetch
    taskWorkflowApi.sync = oldSync
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

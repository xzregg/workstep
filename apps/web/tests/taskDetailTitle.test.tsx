import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import TaskDetailTitle from '../src/components/TaskDetailTitle'
import { useTaskStore } from '../src/stores/taskStore'

test('title double click edits, saves, cancels, validates and retains failed drafts', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const original = useTaskStore.getState().renameTask
  const calls: string[] = []
  let fail = false
  let headerDoubleClicks = 0
  useTaskStore.setState({ renameTask: async (id, title, projectId) => {
    assert.equal(id, 'task'); assert.equal(projectId, 'project'); calls.push(title)
    if (fail) throw new Error('保存失败')
    return { id, title } as never
  } })
  const render = (editable = true) => root.render(<I18nProvider><div onDoubleClick={() => { headerDoubleClicks += 1 }}><TaskDetailTitle
    task={{ id: 'task', title: 'Original' }} projectId="project" editable={editable} />
  </div></I18nProvider>)
  const open = async () => act(async () => {
    container.querySelector<HTMLElement>('[data-task-title]')!.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }))
  })
  const change = async (value: string) => act(async () => {
    const input = container.querySelector('input')!
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  const key = async (key: string) => act(async () => {
    container.querySelector('input')!.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }))
  })
  try {
    await act(async () => render())
    await open()
    assert.equal(document.activeElement, container.querySelector('input'))
    await change('  Renamed  '); await key('Enter')
    assert.deepEqual(calls, ['Renamed'])
    assert.equal(container.querySelector('input'), null)
    await open(); await change('Cancel'); await key('Escape')
    assert.deepEqual(calls, ['Renamed'])
    await open(); await change('   '); await key('Enter')
    assert.ok(container.querySelector('input'))
    assert.deepEqual(calls, ['Renamed'])
    fail = true
    await change('Retry'); await key('Enter')
    assert.equal(container.querySelector('input')!.value, 'Retry')
    assert.match(container.querySelector('[role="alert"]')!.textContent!, /保存失败/)
    fail = false
    await act(async () => container.querySelector('input')!.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })))
    assert.deepEqual(calls, ['Renamed', 'Retry', 'Retry'])
    assert.equal(headerDoubleClicks, 0)
    await act(async () => render(false)); await open()
    assert.equal(container.querySelector('input'), null)
  } finally {
    await act(async () => root.unmount())
    useTaskStore.setState({ renameTask: original })
    container.remove(); await window.happyDOM.close()
  }
})


test('rename sends only the title and updates the task list after saving', async () => {
  const previousFetch = globalThis.fetch
  const previousTasks = useTaskStore.getState().tasks
  const task = { id: 'task', title: 'Original', description: 'Keep context' } as never
  useTaskStore.setState({ tasks: [task] })
  let resolve!: (response: Response) => void
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /task\/task\?project_id=project/)
    assert.equal(options?.method, 'PATCH')
    assert.deepEqual(JSON.parse(String(options?.body)), { title: 'Renamed' })
    return new Promise<Response>(done => { resolve = done })
  }
  try {
    const pending = useTaskStore.getState().renameTask('task', 'Renamed', 'project')
    assert.equal(useTaskStore.getState().tasks[0].title, 'Original')
    resolve(Response.json({ id: 'task', title: 'Renamed', description: 'Keep context' }))
    await pending
    assert.equal(useTaskStore.getState().tasks[0].title, 'Renamed')
    assert.equal(useTaskStore.getState().tasks[0].description, 'Keep context')
  } finally {
    globalThis.fetch = previousFetch
    useTaskStore.setState({ tasks: previousTasks })
  }
})

// React DOM needs the test DOM before it is imported.
import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import { useTaskStore } from '../src/stores/taskStore'
import TaskDetailDescription from '../src/components/TaskDetailDescription'

const task = {
  id: 'task-1', description: 'Original description',
  steps: [{ step_key: 'build', status: 'pending', started_at: null }],
  scheduled_start_at: null, scheduled_start_state: null,
}

test('an editable description saves its draft through the task store', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const originalUpdate = useTaskStore.getState().updateTaskDescription
  const calls: unknown[][] = []
  await act(async () => useTaskStore.setState({ updateTaskDescription: async (...args) => {
    calls.push(args)
    return {} as never
  } }))
  try {
    await act(async () => root.render(<I18nProvider><TaskDetailDescription
      task={task} projectId="project-1" editable
    /></I18nProvider>))
    const edit = container.querySelector<HTMLButtonElement>('.task-description-edit')
    assert.ok(edit)
    await act(async () => edit.click())
    const editor = container.querySelector<HTMLTextAreaElement>('.markdown-editor-input')
    assert.ok(editor)
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, 'Updated description')
      editor.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await act(async () => container.querySelector<HTMLButtonElement>('.task-description-actions button:last-child')!.click())
    assert.deepEqual(calls, [['task-1', 'Updated description', 'project-1']])
    assert.ok(container.querySelector('.markdown-editor-input') === null)
  } finally {
    await act(async () => useTaskStore.setState({ updateTaskDescription: originalUpdate }))
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('scheduled start is shown beside the description and editable before save actions', async () => {
  const { window } = installDomEnvironment()
  const originalDescription = useTaskStore.getState().updateTaskDescription
  const originalSchedule = useTaskStore.getState().updateScheduledStart
  const calls: unknown[][] = []
  await act(async () => useTaskStore.setState({
    updateTaskDescription: async (...args) => { calls.push(['description', ...args]); return {} as never },
    updateScheduledStart: async (...args) => { calls.push(['schedule', ...args]); return {} as never },
  }))
  const previousSvgElement = globalThis.SVGElement
  const previousResizeObserver = globalThis.ResizeObserver
  const previousShadowRoot = globalThis.ShadowRoot
  globalThis.SVGElement = (window.SVGElement || window.HTMLElement) as typeof SVGElement
  globalThis.ShadowRoot = (window.ShadowRoot || class {}) as typeof ShadowRoot
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver
  assert.equal(typeof globalThis.SVGElement, 'function')
  assert.equal(typeof globalThis.HTMLElement, 'function')
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><TaskDetailDescription
      task={{ ...task, scheduled_start_at: '2026-10-01T04:00:00Z', scheduled_start_state: 'pending' }}
      projectId="project-1" editable
    /></I18nProvider>))
    const header = container.querySelector('.task-description-header')
    assert.match(header?.querySelector('.task-description-schedule')?.textContent || '', /10\/1\/26/)
    await act(async () => container.querySelector<HTMLButtonElement>('.task-description-edit')!.click())
    const schedule = container.querySelector('.task-description-schedule-editor')
    const actions = container.querySelector('.task-description-actions')
    assert.ok(schedule)
    assert.ok(schedule.querySelector('.ant-picker'))
    assert.ok(actions)
    assert.ok((schedule.compareDocumentPosition(actions.lastElementChild!) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)
    await act(async () => schedule.querySelector<HTMLInputElement>('.ant-picker-input input')!.click())
    assert.ok(document.querySelector('.ant-picker-dropdown'))
    const tomorrow = [...document.querySelectorAll<HTMLButtonElement>('.ant-picker-dropdown button')]
      .find((button) => /Tomorrow|明天/.test(button.textContent || ''))
    assert.ok(tomorrow)
    await act(async () => tomorrow.click())
    assert.match(schedule.querySelector<HTMLInputElement>('.ant-picker-input input')?.value || '', /^\d{4}-\d{2}-\d{2}/)
    await act(async () => container.querySelector<HTMLButtonElement>('.task-description-actions > button:last-child')!.click())
    assert.equal(calls[0][0], 'description')
    assert.equal(calls[1][0], 'schedule')
    assert.equal(calls[1][1], 'task-1')
    assert.equal(calls[1][3], 'project-1')
    assert.ok(new Date(calls[1][2] as string).getTime() > Date.now())
  } finally {
    await act(async () => root.unmount())
    await act(async () => useTaskStore.setState({
      updateTaskDescription: originalDescription,
      updateScheduledStart: originalSchedule,
    }))
    globalThis.SVGElement = previousSvgElement
    globalThis.ResizeObserver = previousResizeObserver
    globalThis.ShadowRoot = previousShadowRoot
    container.remove()
    await window.happyDOM.close()
  }
})

test('a read-only task description has no edit control', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><TaskDetailDescription
      task={task} projectId="project-1"
    /></I18nProvider>))
    assert.match(container.textContent || '', /Original description/)
    assert.ok(container.querySelector('.task-description-edit') === null)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('saving failure keeps description edits visible for retry', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const originalUpdate = useTaskStore.getState().updateTaskDescription
  await act(async () => useTaskStore.setState({
    updateTaskDescription: async () => { throw new Error('Database busy') },
  }))
  try {
    await act(async () => root.render(<I18nProvider><TaskDetailDescription
      task={task} projectId="project-1" editable
    /></I18nProvider>))
    await act(async () => container.querySelector<HTMLButtonElement>('.task-description-edit')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('.task-description-actions > button:last-child')!.click())
    assert.match(container.querySelector('[role="alert"]')?.textContent || '', /Database busy/)
    assert.ok(container.querySelector('.markdown-editor-input'))
  } finally {
    await act(async () => useTaskStore.setState({ updateTaskDescription: originalUpdate }))
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

for (const action of ['save', 'cancel', 'retry'] as const) {
  test(`image description inline preview ${action} preserves the image and saved value`, async () => {
    const { window } = installDomEnvironment()
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    const initial = '# 旧标题\n\n![截图](.workstep/uploads/keep.png)'
    let stored = initial
    let fail = action === 'retry'
    const calls: string[] = []
    const previous = useTaskStore.getState().updateTaskDescription
    let refresh = () => {}
    useTaskStore.setState({ updateTaskDescription: async (_id, description) => {
      calls.push(description)
      if (fail) throw new Error('Save failed')
      stored = description
      refresh()
      return {} as never
    } })
    function Description() {
      const [, render] = useState(0)
      refresh = () => render(v => v + 1)
      return <I18nProvider><TaskDetailDescription task={{ ...task, description: stored }} projectId="project-1" editable /></I18nProvider>
    }
    try {
      await act(async () => root.render(<Description />))
      await act(async () => host.querySelector<HTMLButtonElement>('.task-description-edit')!.click())
      await act(async () => host.querySelector<HTMLButtonElement>('.markdown-editor-action[data-active]')!.click())
      assert.equal(host.querySelector('textarea') === null, true)
      const editor = host.querySelector<HTMLElement>('.markdown-editor-preview [contenteditable="true"]')
      assert.ok(editor)
      await act(async () => {
        editor.focus()
        editor.textContent = '改好的标题'
        editor.dispatchEvent(new window.Event('input', { bubbles: true }))
      })
      assert.equal(host.querySelectorAll('.markdown-editor-preview img').length, 1)
      await act(async () => editor.blur())
      const actions = host.querySelectorAll<HTMLButtonElement>('.task-description-actions > button')
      await act(async () => actions[action === 'cancel' ? 0 : 1].click())
      if (action === 'retry') {
        assert.match(host.querySelector('[role="alert"]')?.textContent ?? '', /Save failed/)
        assert.equal(host.querySelector('.markdown-editor-preview h1')?.textContent, '改好的标题')
        assert.equal(host.querySelectorAll('.markdown-editor-preview img').length, 1)
        fail = false
        await act(async () => actions[1].click())
      }
      assert.equal(host.querySelector('.task-description-content h1')?.textContent, action === 'cancel' ? '旧标题' : '改好的标题')
      assert.equal(host.querySelectorAll('.task-description-content img').length, 1)
      assert.equal(stored.includes('![截图](.workstep/uploads/keep.png)'), true)
      assert.equal(calls.length, action === 'cancel' ? 0 : action === 'retry' ? 2 : 1)
      await act(async () => host.querySelector<HTMLButtonElement>('.task-description-edit')!.click())
      assert.equal(host.querySelector<HTMLTextAreaElement>('textarea')?.value, stored)
    } finally {
      await act(async () => useTaskStore.setState({ updateTaskDescription: previous }))
      await act(async () => root.unmount())
      host.remove()
      await window.happyDOM.close()
    }
  })
}

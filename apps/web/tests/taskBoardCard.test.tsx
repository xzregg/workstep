import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Task } from '../src/api/client'
import { I18nProvider } from '../src/i18n'
import TaskBoardCard from '../src/components/TaskBoardCard'

const task: Task = {
  id: 'task-1', title: 'Build feature', description: 'Implement the design',
  cwd: '/tmp/project', status: 'ready', engine: 'codex', creator_name: 'Alice',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  steps: [{ step_key: 'build', status: 'pending', engine: null,
    started_at: null, ended_at: null, error: null }],
}

test('an unstarted board card shows its metadata and keeps action clicks separate from opening', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const calls: string[] = []
  try {
    await act(async () => root.render(<I18nProvider><TaskBoardCard
      task={task} durationNowMs={Date.now()} showArchived={false} starting={false}
      onOpen={() => calls.push('open')} onStart={() => calls.push('start')}
      onArchive={() => calls.push('archive')} onRestore={() => calls.push('restore')}
      onDelete={() => calls.push('delete')}
      onDragStart={() => {}} onDragEnd={() => {}}
    /></I18nProvider>))
    assert.match(container.textContent || '', /Build feature/)
    assert.match(container.textContent || '', /Alice/)
    assert.doesNotMatch(container.textContent || '', /Creator:\s*Alice/)
    assert.match(container.textContent || '', /Implement the design/)
    const start = container.querySelector<HTMLButtonElement>('[data-task-action="start"]')
    assert.ok(start)
    await act(async () => start.click())
    assert.deepEqual(calls, ['start'])
    await act(async () => container.querySelector<HTMLButtonElement>('[data-task-action="archive"]')!.click())
    assert.deepEqual(calls, ['start', 'archive'])
    await act(async () => container.querySelector<HTMLElement>('[data-task-status="ready"]')!.click())
    assert.deepEqual(calls, ['start', 'archive', 'open'])
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('completed tasks can still enter the archive flow outside the running state', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let archived = 0
  try {
    await act(async () => root.render(<I18nProvider><TaskBoardCard
      task={{ ...task, status: 'done', steps: [{ ...task.steps[0], status: 'passed', started_at: '2026-01-01T00:00:00Z' }] }}
      durationNowMs={Date.now()} showArchived={false} starting={false}
      onOpen={() => {}} onStart={() => {}} onArchive={() => { archived++ }}
      onRestore={() => {}} onDelete={() => {}}
      onDragStart={() => {}} onDragEnd={() => {}}
    /></I18nProvider>))
    await act(async () => container.querySelector<HTMLButtonElement>('[data-task-action="archive"]')!.click())
    assert.equal(archived, 1)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('a running card hides destructive actions and shows an active status', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><TaskBoardCard
      task={{ ...task, status: 'running', recovered_count: 1,
        steps: [{ ...task.steps[0], status: 'running', started_at: '2026-01-01T00:00:00Z' }] }}
      durationNowMs={Date.now()} showArchived={false} starting={false}
      onOpen={() => {}} onStart={() => {}} onArchive={() => {}}
      onRestore={() => {}} onDelete={() => {}}
      onDragStart={() => {}} onDragEnd={() => {}}
    /></I18nProvider>))
    assert.equal(container.querySelector('[data-task-action="start"]'), null)
    assert.equal(container.querySelector('[data-task-action="delete"]'), null)
    assert.ok(container.querySelector('.task-status-spinner'))
    const recovered = container.querySelector('.task-card-recovered-badge')
    const status = container.querySelector('.task-card-status-badge')
    assert.ok(recovered && status)
    assert.ok((recovered.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('scheduled time and description preview stay within the task card', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><TaskBoardCard
      task={{ ...task, scheduled_start_at: '2026-10-01T04:00:00Z', scheduled_start_state: 'pending' }}
      durationNowMs={Date.now()} showArchived={false} starting={false}
      onOpen={() => {}} onStart={() => {}} onArchive={() => {}}
      onRestore={() => {}} onDelete={() => {}}
      onDragStart={() => {}} onDragEnd={() => {}}
    /></I18nProvider>))
    const scheduled = container.querySelector('.task-board-card-scheduled')
    const status = container.querySelector('.task-card-status-badge')
    assert.ok(scheduled && status)
    assert.ok(scheduled.querySelector('svg'))
    assert.ok((scheduled.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)
    assert.equal(container.querySelector('.task-board-card-description')?.textContent, 'Implement the design')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})


test('a readonly card retains viewing and metadata while hiding mutations and drag', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let opened = false
  try {
    await act(async () => root.render(<I18nProvider><TaskBoardCard
      task={task} durationNowMs={Date.now()} showArchived={false} starting={false} readOnly
      onOpen={() => { opened = true }} onStart={() => assert.fail('start')}
      onArchive={() => assert.fail('archive')} onRestore={() => assert.fail('restore')}
      onDelete={() => assert.fail('delete')} onDragStart={() => {}} onDragEnd={() => {}}
    /></I18nProvider>))
    assert.match(container.textContent || '', /Alice/)
    assert.equal(container.querySelector('[data-task-action]'), null)
    const card = container.querySelector<HTMLElement>('.task-board-card')!
    assert.equal(card.getAttribute('draggable'), 'false')
    await act(async () => card.click())
    assert.equal(opened, true)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

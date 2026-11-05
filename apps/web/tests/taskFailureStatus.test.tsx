import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import TaskBoardCard from '../src/components/TaskBoardCard'
import TaskTableView from '../src/components/TaskTableView'
import TaskDetailHeader from '../src/components/TaskDetailHeader'
import type { Task } from '../src/api/task'

test('failure reasons change labels consistently without changing task state or actions', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.getState().setLocale('zh-CN')
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const noop = () => {}
  const cases = [
    { reason: 'step_failed', label: '步骤失败' },
    { reason: 'workflow_blocked', label: '流程阻塞' },
    { reason: 'engine_error', label: '引擎调用失败' },
    { reason: 'future_reason', label: '失败' },
    { reason: undefined, label: '失败' },
  ]
  try {
    for (const { reason, label } of cases) {
      const task = Object.freeze({
        id: 'remote-task', title: '研发任务', description: '', cwd: '/tmp/project',
        status: 'failed', status_reason: reason, engine: 'codex_sdk',
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
        steps: [{ step_key: 'build', status: 'failed', error: 'original error', engine: null,
          started_at: null, ended_at: null }],
      }) as Task
      const before = JSON.stringify(task)
      await act(async () => root.render(<I18nProvider>
        <section id="board"><TaskBoardCard task={task} durationNowMs={0} showArchived={false} starting={false}
          onOpen={noop} onStart={noop} onArchive={noop} onRestore={noop} onDelete={noop}
          onDragStart={noop} onDragEnd={noop} /></section>
        <section id="table"><TaskTableView lanes={[{ key: 'build', label: '开发', color: 'blue' }]}
          tasksByLane={{ build: [task] }} showArchived={false} durationNowMs={0}
          onOpenTask={noop} onAddTask={noop} onArchiveTask={async () => {}}
          onDeleteTask={async () => {}} onError={noop} /></section>
        <section id="detail"><TaskDetailHeader task={task} locale="zh-CN"
          activeStep={{ key: 'build', label: '开发', color: 'blue', prompt: '', inputs: [], outputs: [] }}
          activeStepColor="blue" taskCompleted={false} /></section>
      </I18nProvider>))
      for (const selector of ['#board .task-card-status-badge', '#table .status-badge[data-s]', '#detail [data-status]']) {
        const badge = container.querySelector(selector)
        assert.equal(badge?.textContent, label, selector)
        assert.equal(badge?.getAttribute('data-s') || badge?.getAttribute('data-status'), 'failed')
      }
      assert.equal(container.querySelector('#board .task-board-card')?.getAttribute('data-task-status'), 'failed')
      assert.ok(container.querySelector('#board [data-task-action="archive"]'))
      assert.ok(container.querySelector('#board [data-task-action="delete"]'))
      assert.equal(container.querySelector('.task-status-spinner'), null)
      assert.equal(JSON.stringify(task), before)
    }
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

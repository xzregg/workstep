// Must stay first so react-dom detects a DOM environment.
import { installDomEnvironment } from './helpers/domEnv.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Task } from '../src/api/client.ts'
import TaskTableView from '../src/components/TaskTableView.tsx'
import { I18nProvider, useLocaleStore } from '../src/i18n/index.tsx'

function task(id: string, title: string): Task {
  return {
    id,
    title,
    description: null,
    cwd: '/tmp/project',
    status: 'ready',
    engine: 'codex',
    created_at: '2026-09-21T08:00:00Z',
    updated_at: '2026-09-21T08:00:00Z',
    steps: [],
  }
}

test('table search sits after select all, filters tasks, and limits select all to matches', async () => {
  const { window, document } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)

  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <TaskTableView
            lanes={[{ key: 'todo', label: '待办', color: '#f00' }]}
            tasksByLane={{ todo: [task('one', '修复登录'), task('two', '更新文档')] }}
            showArchived={false}
            durationNowMs={0}
            onOpenTask={() => {}}
            onAddTask={() => {}}
            onArchiveTask={async () => {}}
            onDeleteTask={async () => {}}
            onError={() => {}}
          />
        </I18nProvider>,
      )
    })

    const search = container.querySelector<HTMLInputElement>('input[type="search"]')
    const selectAll = container.querySelector<HTMLInputElement>('input[aria-label="选择全部可操作任务"]')
    assert.ok(search)
    assert.ok(selectAll)
    assert.ok(selectAll.compareDocumentPosition(search) & window.Node.DOCUMENT_POSITION_FOLLOWING)

    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, '登录')
      search.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.match(container.textContent ?? '', /修复登录/)
    assert.doesNotMatch(container.textContent ?? '', /更新文档/)
    assert.match(container.textContent ?? '', /1 个任务/)

    await act(async () => selectAll.click())
    assert.equal(container.querySelector<HTMLInputElement>('input[aria-label="选择任务“修复登录”"]')?.checked, true)

    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, '')
      search.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.equal(container.querySelector<HTMLInputElement>('input[aria-label="选择任务“修复登录”"]')?.checked, true)
    assert.equal(container.querySelector<HTMLInputElement>('input[aria-label="选择任务“更新文档”"]')?.checked, false)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

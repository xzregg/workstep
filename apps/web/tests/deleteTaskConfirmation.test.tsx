import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import { useLocaleStore } from '../src/i18n'
import type { Task } from '../src/api/client'
import DeleteTaskConfirmation from '../src/components/DeleteTaskConfirmation'
import TaskTableView from '../src/components/TaskTableView'

test('task deletion includes the full task workspace and artifacts', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const choices: boolean[] = []
  const render = async (open: boolean) => act(async () => root.render(
    <I18nProvider><DeleteTaskConfirmation open={open} count={1} onConfirm={choice => choices.push(choice)} onCancel={() => {}} /></I18nProvider>,
  ))
  try {
    await render(true)
    assert.equal(document.querySelector('[role="dialog"] input[type="checkbox"]'), null)
    assert.match(document.querySelector('[role="dialog"]')?.textContent || '', /workspace|工作区/i)
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].at(-1)!.click())
    assert.deepEqual(choices, [true])
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('bulk task deletion passes the workspace choice to every selected task', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const calls: [string, boolean][] = []
  const tasks = ['one', 'two'].map(id => ({ id, title: id, description: null, cwd: '/project', status: 'ready', engine: 'codex', created_at: '', updated_at: '', steps: [] }) as Task)
  try {
    await act(async () => root.render(<I18nProvider><TaskTableView
      lanes={[{ key: 'todo', label: '待办', color: '#f00' }]}
      tasksByLane={{ todo: tasks }} showArchived={false} durationNowMs={0}
      onOpenTask={() => {}} onAddTask={() => {}} onArchiveTask={async () => {}}
      onDeleteTask={async (id, choice) => { calls.push([id, choice]) }} onError={() => {}}
    /></I18nProvider>))
    await act(async () => container.querySelector<HTMLInputElement>('input[aria-label="选择全部可操作任务"]')!.click())
    const bulkDelete = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('批量删除'))!
    await act(async () => bulkDelete.click())
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].at(-1)!.click())
    assert.deepEqual(calls.sort(), [['one', true], ['two', true]])
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

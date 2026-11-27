import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import type { Task } from '../src/api/client'
import MobileTaskSelection from '../src/components/MobileTaskSelection'
import MobileTaskRow from '../src/components/MobileTaskRow'

const tasks = ['one', 'two', 'running'].map(id => ({
  id, title: id, status: id === 'running' ? 'running' : 'ready', steps: [],
})) as Task[]

test('mobile selection toggles, selects actionable tasks, prunes invisible tasks and resets on scope change', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  let opens = 0
  const calls: [string, boolean | undefined][] = []
  const render = async (scope = 'active', list = tasks) => act(async () => root.render(<I18nProvider>
    <MobileTaskSelection key={scope} tasks={list} showArchived={false} canArchive canDelete canCleanWorkspace={false}
      onArchiveTask={async (id, clean) => { calls.push([id, clean]) }}
      onDeleteTask={async () => {}} onError={() => {}}>
      {selection => <div className="mobile-task-list">{list.map(task => <MobileTaskRow
        key={task.id} taskId={task.id} title={task.title} status={task.status} archived={false} canArchive canDelete
        selectionMode={selection.active} selected={selection.selectedIds.includes(task.id)}
        selectionDisabled={selection.disabled || task.status === 'running'} onSelect={() => selection.select(task.id)}
        onOpen={() => opens++} onArchive={() => {}} onRestore={() => {}} onDelete={() => {}}>{task.title}</MobileTaskRow>)}</div>}
    </MobileTaskSelection>
  </I18nProvider>))
  const row = (id: string) => document.querySelector<HTMLButtonElement>(`[data-board-task-id="${id}"]`)!
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text)!
  try {
    await render()
    await act(async () => {
      row('one').dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', button: 0 }))
      await new Promise(resolve => setTimeout(resolve, 520))
      row('one').dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true })); row('one').click()
    })
    assert.match(document.querySelector('[role="status"]')!.textContent!, /1/)
    await act(async () => row('two').click())
    assert.match(document.querySelector('[role="status"]')!.textContent!, /2/)
    await act(async () => row('one').click())
    assert.match(document.querySelector('[role="status"]')!.textContent!, /1/)
    await act(async () => button('全选').click())
    assert.deepEqual([...document.querySelectorAll('[aria-pressed="true"][data-board-task-id]')].map(r => r.getAttribute('data-board-task-id')), ['one', 'two'])
    assert.equal(opens, 0)
    await render('active', tasks.slice(1))
    assert.match(document.querySelector('[role="status"]')!.textContent!, /1/)
    await act(async () => button('批量归档').click())
    await act(async () => document.querySelector<HTMLButtonElement>('.confirm-dialog-confirm')!.click())
    assert.deepEqual(calls, [['two', false]])
    assert.equal(button('批量归档').disabled, true)
    await act(async () => button('取消').click())
    await act(async () => row('two').click())
    assert.equal(opens, 1)
    await render('archived')
    assert.equal(Boolean(document.querySelector('[role="toolbar"]')), false)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('archive/delete permissions, confirmation cancellation, failures and in-flight duplicate protection share PC rules', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const calls: [string, boolean][] = []
  const errors: string[] = []
  let fail = true
  let finish: (() => void) | undefined
  const render = async (canDelete = true) => act(async () => root.render(<I18nProvider>
    <MobileTaskSelection tasks={tasks} showArchived canArchive={false} canDelete={canDelete} canCleanWorkspace={false}
      onArchiveTask={async () => { throw new Error('unexpected archive') }}
      onDeleteTask={async (id, clean) => {
        calls.push([id, clean])
        if (!fail) return
        if (id === 'one') throw new Error('403 Forbidden')
        await new Promise<void>(resolve => { finish = resolve })
      }} onError={message => errors.push(message)}>
      {selection => <button data-select onClick={() => { selection.select('one'); selection.select('two') }}>select</button>}
    </MobileTaskSelection>
  </I18nProvider>))
  const click = async (selector: string) => act(async () => document.querySelector<HTMLButtonElement>(selector)!.click())
  try {
    await render()
    await click('[data-select]')
    assert.equal(Boolean(document.querySelector('.mobile-task-bulk-actions button:not(.mobile-task-delete)')), false)
    await click('.mobile-task-delete')
    await click('.confirm-dialog-footer .btn-ghost')
    assert.equal(calls.length, 0)
    await click('.mobile-task-delete')
    await render(false)
    await click('.confirm-dialog-confirm')
    assert.equal(calls.length, 0, 'permission revoked while confirming')
    await render()
    await act(async () => {
      document.querySelector<HTMLButtonElement>('.confirm-dialog-confirm')!.click()
      document.querySelector<HTMLButtonElement>('.confirm-dialog-confirm')!.click()
    })
    assert.deepEqual(calls, [['one', true], ['two', true]])
    assert.equal(errors.length, 0, 'wait for remaining requests before unlocking retry')
    assert.equal(document.querySelector<HTMLButtonElement>('.mobile-task-delete')!.disabled, true)
    await click('.confirm-dialog-footer .btn-ghost')
    assert.equal(Boolean(document.querySelector('[role="dialog"]')), true)
    await act(async () => finish!())
    assert.match(errors[0], /403 Forbidden/)
    assert.equal(Boolean(document.querySelector('[role="dialog"]')), true)
    assert.match(document.querySelector('[role="status"]')!.textContent!, /2/)
    await click('.confirm-dialog-footer .btn-ghost')
    assert.equal(Boolean(document.querySelector('[role="dialog"]')), false)
    fail = false
    await click('.mobile-task-delete')
    await click('.confirm-dialog-confirm')
    assert.equal(calls.length, 4)
    assert.equal(Boolean(document.querySelector('[role="dialog"]')), false)
    assert.match(document.querySelector('[role="status"]')!.textContent!, /0/)
    assert.equal(document.querySelector<HTMLButtonElement>('.mobile-task-delete')!.disabled, true)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

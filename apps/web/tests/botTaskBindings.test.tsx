import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import BotTaskBindings from '../src/components/BotTaskBindings'
import { channelBotApi } from '../src/api/channelBots'

for (const count of [undefined, 0, 100]) test(`task binding dialog handles ${count ?? 'unavailable'} bindings without expanding the card`, async () => {
  const { window } = installDomEnvironment()
  const node = document.body.appendChild(document.createElement('div'))
  const root = createRoot(node)
  const bindings = count === undefined ? undefined : Array.from({ length: count }, (_, index) => ({
    bot_id: 'b', project_id: 'p', task_id: `t${index}`, group_id: `g${index}`,
    group_name: `群${index}`, project_name: '项目', task_title: `任务${index}`,
  }))
  try {
    await act(async () => root.render(<I18nProvider><BotTaskBindings bindings={bindings} onChanged={async () => {}} /></I18nProvider>))
    assert.equal(node.querySelectorAll('li').length, 0)
    const trigger = node.querySelector<HTMLButtonElement>('button')!
    trigger.focus()
    await act(async () => trigger.click())
    const dialog = document.querySelector('[role="dialog"]')!
    assert.equal(dialog.querySelectorAll('li').length, count ?? 0)
    if (count === undefined) assert.match(dialog.textContent!, /重启后端/)
    if (count === 0) assert.match(dialog.textContent!, /暂无绑定任务/)
    await act(async () => dialog.querySelector<HTMLButtonElement>('.bot-task-bindings-close')!.click())
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.equal(document.activeElement, trigger)
  } finally {
    await act(async () => root.unmount()); node.remove(); await window.happyDOM.close()
  }
})

test('bound tasks show project and group; cross removes only the selected binding and supports retry', async () => {
  const { window } = installDomEnvironment()
  const rootNode = document.body.appendChild(document.createElement('div'))
  const root = createRoot(rootNode)
  const original = channelBotApi.unbindGroup
  const calls: unknown[] = []
  let fail = true
  let refreshed = 0
  const bindings = [{ bot_id: 'b1', project_id: 'p1', task_id: 't1', group_id: 'g1', group_name: '研发群', project_name: '项目一', task_title: '修复登录' }]
  channelBotApi.unbindGroup = async (...args) => {
    calls.push(args)
    if (fail) throw new Error('解绑失败')
    return { deleted: true }
  }
  try {
    await act(async () => root.render(<I18nProvider><BotTaskBindings bindings={bindings} onChanged={async () => { refreshed++; root.render(<I18nProvider><BotTaskBindings bindings={[]} onChanged={async () => {}} /></I18nProvider>) }} /></I18nProvider>))
    const trigger = rootNode.querySelector<HTMLButtonElement>('.bot-task-bindings-trigger')!
    assert.match(trigger.textContent!, /1/)
    assert.doesNotMatch(rootNode.textContent!, /修复登录/)
    assert.equal(document.querySelector('[role="dialog"]'), null)
    await act(async () => trigger.click())
    const dialog = document.querySelector('[role="dialog"]')!
    assert.match(dialog.textContent!, /修复登录/)
    assert.match(dialog.textContent!, /项目一/)
    assert.match(dialog.textContent!, /研发群/)
    const close = dialog.querySelector<HTMLButtonElement>('.bot-task-binding-remove')!
    assert.match(close.getAttribute('aria-label')!, /解除绑定.*修复登录/)
    await act(async () => close.click())
    assert.match(dialog.querySelector('[role="alert"]')!.textContent!, /解绑失败/)
    assert.equal(refreshed, 0)
    assert.match(dialog.textContent!, /修复登录/)
    fail = false
    await act(async () => close.click())
    assert.deepEqual(calls, [['t1', 'p1', 'b1', 'g1'], ['t1', 'p1', 'b1', 'g1']])
    assert.equal(refreshed, 1)
    assert.equal(dialog.querySelector('.bot-task-binding-remove'), null)
    assert.match(dialog.textContent!, /暂无绑定任务/)
    assert.match(trigger.textContent!, /0/)
    await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.equal(document.querySelector('[role="dialog"]'), null)
    await act(async () => trigger.click())
    assert.equal(document.querySelector('[role="alert"]'), null)
    await act(async () => (document.querySelector('.bot-task-bindings-backdrop') as HTMLElement).click())
    assert.equal(document.querySelector('[role="dialog"]'), null)
  } finally {
    channelBotApi.unbindGroup = original
    await act(async () => root.unmount())
    rootNode.remove()
    await window.happyDOM.close()
  }
})

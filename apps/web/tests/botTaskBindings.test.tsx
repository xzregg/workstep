import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import BotTaskBindings from '../src/components/BotTaskBindings'
import { channelBotApi } from '../src/api/channelBots'

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
    assert.match(rootNode.textContent!, /修复登录/)
    assert.match(rootNode.textContent!, /项目一/)
    assert.match(rootNode.textContent!, /研发群/)
    const close = rootNode.querySelector<HTMLButtonElement>('button')!
    assert.match(close.getAttribute('aria-label')!, /解除绑定.*修复登录/)
    await act(async () => close.click())
    assert.match(rootNode.querySelector('[role="alert"]')!.textContent!, /解绑失败/)
    assert.equal(refreshed, 0)
    assert.match(rootNode.textContent!, /修复登录/)
    fail = false
    await act(async () => close.click())
    assert.deepEqual(calls, [['t1', 'p1', 'b1', 'g1'], ['t1', 'p1', 'b1', 'g1']])
    assert.equal(refreshed, 1)
    assert.equal(rootNode.querySelector('button'), null)
  } finally {
    channelBotApi.unbindGroup = original
    await act(async () => root.unmount())
    rootNode.remove()
    await window.happyDOM.close()
  }
})

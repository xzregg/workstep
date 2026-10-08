import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import BotPrivateWhitelist from '../src/components/BotPrivateWhitelist'
import { channelBotApi, type PrivateWhitelist } from '../src/api/channelBots'

for (const scope of ['private', 'group'] as const) test(`${scope}: restore, multi-select, refresh, retry, and unsaved close protection`, async () => {
  const loadKey = scope === 'group' ? 'groupWhitelist' : 'privateWhitelist'
  const saveKey = scope === 'group' ? 'saveGroupWhitelist' : 'savePrivateWhitelist'
  const title = scope === 'group' ? '群聊白名单' : '私聊白名单'
  const { window } = installDomEnvironment()
  const node = document.body.appendChild(document.createElement('div')); const root = createRoot(node)
  const originals = [channelBotApi[loadKey], channelBotApi[saveKey]] as const
  const a = { sender_id: 'a', sender_name: '已保存' }, b = { sender_id: 'b', sender_name: '新用户' }
  let state: PrivateWhitelist = { enabled: true, users: [a], candidates: [a, b] }, fail = true
  channelBotApi[loadKey] = async id => { assert.equal(id, 'bot'); return state }
  channelBotApi[saveKey] = async (id, value) => {
    assert.equal(id, 'bot'); if (fail) throw new Error('保存失败')
    state = { ...state, ...value }; return state
  }
  const button = (text: string) => { const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')]; const found = buttons.find(b => b.textContent?.trim() === text); assert.ok(found, text + ': ' + buttons.map(b => b.textContent).join('|')); return found }
  const checks = () => [...document.querySelectorAll<HTMLInputElement>('.bot-private-whitelist input[type=checkbox]')]
  try {
    await act(async () => root.render(<I18nProvider><BotPrivateWhitelist botId="bot" scope={scope} /></I18nProvider>))
    await act(async () => button(title).click())
    assert.deepEqual(checks().map(c => c.checked), [true, true, false])
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!
    assert.ok(search)
    await act(async () => { search.value = '新用户'; search.dispatchEvent(new window.Event('input', { bubbles: true })) })
    assert.equal(checks().length, 2)
    await act(async () => checks()[1].click())
    await act(async () => { search.value = 'a'; search.dispatchEvent(new window.Event('input', { bubbles: true })) })
    assert.equal(checks()[1].checked, true)
    await act(async () => { search.value = ''; search.dispatchEvent(new window.Event('input', { bubbles: true })) })
    await act(async () => button(scope === 'group' ? '刷新群列表' : '刷新用户列表').click())
    assert.equal(checks()[2].checked, true)
    await act(async () => button('Save').click())
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /保存失败/)
    fail = false
    await act(async () => button('Save').click())
    assert.deepEqual(state.users, [a, b]); assert.equal(document.querySelector('[role="dialog"]'), null)
    await act(async () => button(title).click())
    assert.deepEqual(checks().map(c => c.checked), [true, true, true])
    await act(async () => checks()[1].click())
    await act(async () => button('Cancel').click())
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 2)
  } finally {
    channelBotApi[loadKey] = originals[0]; channelBotApi[saveKey] = originals[1]
    await act(async () => root.unmount()); node.remove(); await window.happyDOM.close()
  }
})

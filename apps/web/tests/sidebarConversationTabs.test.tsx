import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import SidebarConversationTabs from '../src/components/SidebarConversationTabs'
import type { ChatSessionSummary } from '../src/api/conversations'

const sessions: ChatSessionSummary[] = [
  { id: 'ordinary', title: '普通内容', project_id: 'p', workflow_id: '', engine: 'codex', message_count: 1 },
  { id: 'channel', title: 'Echo', source: 'channel', project_id: 'p', workflow_id: '', engine: 'codex', message_count: 1 },
]

test('conversation tabs isolate channel sessions, follow navigation and clear selection on switch', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let switches = 0
  const render = (activeSessionId: string, rows = sessions) => act(async () => root.render(
    <I18nProvider><SidebarConversationTabs sessions={rows} activeSessionId={activeSessionId} onSwitch={() => switches++} header={(tabs, tab) => <header><span>对话</span>{tabs}{tab === "chat" && <button aria-label="新建对话">+</button>}</header>}>
      {visible => <div>{visible.map(session => <span key={session.id}>{session.title}</span>)}</div>}
    </SidebarConversationTabs></I18nProvider>,
  ))
  try {
    await render('ordinary')
    assert.ok(container.querySelector('header [role="tablist"]'))
    const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    assert.equal(tabs()[0].textContent, '普通1')
    assert.equal(tabs()[1].textContent, '渠道1')
    assert.ok(container.querySelector('[aria-label="新建对话"]'))
    assert.equal(tabs()[0].getAttribute('aria-selected'), 'true')
    assert.match(container.querySelector('[role="tabpanel"]')!.textContent!, /普通内容/)
    assert.doesNotMatch(container.querySelector('[role="tabpanel"]')!.textContent!, /Echo/)
    await act(async () => tabs()[1].click())
    assert.equal(switches, 1)
    assert.equal(container.querySelector('[aria-label="新建对话"]'), null)
    assert.match(container.querySelector('[role="tabpanel"]')!.textContent!, /Echo/)
    assert.doesNotMatch(container.querySelector('[role="tabpanel"]')!.textContent!, /普通内容/)
    await act(async () => tabs()[1].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
    assert.equal(tabs()[0].getAttribute('aria-selected'), 'true')
    await render('channel')
    assert.equal(tabs()[1].getAttribute('aria-selected'), 'true')
    await render('channel', [])
    assert.match(container.querySelector('[role="tabpanel"]')!.textContent!, /暂无渠道对话/)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

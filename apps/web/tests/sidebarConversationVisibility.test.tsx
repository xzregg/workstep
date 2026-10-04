import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import { I18nProvider } from '../src/i18n'
import SidebarConversationTabs from '../src/components/SidebarConversationTabs'
import type { ChatSessionSummary } from '../src/api/conversations'

const ordinary: ChatSessionSummary = {
  id: 'ordinary', title: '普通对话', project_id: 'p', workflow_id: '', engine: 'codex', message_count: 1,
}
const channel: ChatSessionSummary = {
  id: 'channel', title: '渠道对话', source: 'channel', project_id: 'p', workflow_id: '', engine: 'codex', message_count: 1,
}

test('conversation switch disappears when the last channel session is removed', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const render = (rows: ChatSessionSummary[], activeSessionId: string | null) => act(async () => root.render(
    <I18nProvider>
      <SidebarConversationTabs
        sessions={rows}
        activeSessionId={activeSessionId}
        onSwitch={() => {}}
        header={(tabs) => <header><span>对话</span>{tabs}</header>}
      >
        {(visible) => <div>{visible.map((session) => session.title).join('、')}</div>}
      </SidebarConversationTabs>
    </I18nProvider>,
  ))
  try {
    await render([ordinary, channel], 'channel')
    assert.ok(container.querySelector('[role="tablist"]'))
    assert.match(container.querySelector('[role="tabpanel"]')!.textContent!, /渠道对话/)

    await render([ordinary], null)
    assert.equal(container.querySelector('[role="tablist"]'), null)
    assert.match(container.textContent!, /普通对话/)
    assert.doesNotMatch(container.textContent!, /渠道对话/)

    await render([ordinary, channel], null)
    assert.equal(container.querySelector('[role="tab"]')?.getAttribute('aria-selected'), 'true')
    assert.match(container.querySelector('[role="tabpanel"]')!.textContent!, /普通对话/)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

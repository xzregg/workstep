import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import AssistantChatPanel from '../src/components/AssistantChatPanel'
import { I18nProvider } from '../src/i18n'
import type { ActionRun } from '../src/api/client'

test('shortcut messages and output follow the conversation and respect upward scrolling', async () => {
  const { window } = installDomEnvironment()
  let height = 1000
  const messages: never[] = []
  const run = {
    run_id: 'run', user_message_id: 'action-user', reply_message_id: 'action-reply',
    title: '构建', output: '', status: 'running', started_at: '2026-10-08T10:00:00Z',
  } as ActionRun
  function Harness({ runs }: { runs: ActionRun[] }) {
    return <AssistantChatPanel projectId="" sessionId="s" title="Chat" messages={messages}
      actionRuns={runs} running={false} stopping={false} input="" locale="zh-CN" config={{} as never}
      copy={{ emptyIntro: '', thinking: '', me: '用户', meInitials: 'U', agent: '助手', agentInitials: 'AI', placeholder: '', fullPrompt: '', closePrompt: '' }}
      attachmentPrefix="test" onInputChange={() => {}} onSend={() => {}}
      onSendContent={async () => true} onStop={() => {}} />
  }
  const root = createRoot(window.document.body.appendChild(window.document.createElement('div')) as never)
  const render = (runs: ActionRun[]) => act(async () => root.render(<I18nProvider><Harness runs={runs} /></I18nProvider>))
  try {
    await render([])
    const list = window.document.querySelector<HTMLDivElement>('.chat-history-scroll')!
    Object.defineProperties(list, { scrollHeight: { get: () => height }, clientHeight: { value: 400 } })
    await render([run])
    assert.equal(list.scrollTop, 600)
    height = 1400
    await render([{ ...run, output: '构建输出' }])
    assert.equal(list.scrollTop, 1000)
    await act(async () => list.dispatchEvent(new window.WheelEvent('wheel', { bubbles: true, deltaY: -10 })))
    list.scrollTop = 200
    await act(async () => list.dispatchEvent(new window.Event('scroll')))
    height = 1800
    await render([{ ...run, output: '构建输出\n完成', status: 'succeeded' }])
    assert.equal(list.scrollTop, 200)
    assert.ok(window.document.querySelector('.conversation-new-messages-button.has-label'))
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('upward history paging preserves viewport and does not mark old messages unread', async () => {
  const { window } = installDomEnvironment()
  let requests = 0
  let height = 1000
  const message = (id: string) => ({ id, role: 'user' as const, content: id, status: 'succeeded' as const })
  function Harness() {
    const [messages, setMessages] = useState([message('latest')])
    return <AssistantChatPanel projectId="" sessionId="s" title="Chat" messages={messages}
      running={false} stopping={false} input="" locale="zh-CN" config={{} as never}
      copy={{ emptyIntro: '', thinking: '', me: '用户', meInitials: 'U', agent: '助手', agentInitials: 'AI', placeholder: '', fullPrompt: '', closePrompt: '' }}
      attachmentPrefix="test" onInputChange={() => {}} onSend={() => {}}
      onSendContent={async () => true} onStop={() => {}}
      onLoadOlderHistory={async (beforePrepend) => {
        requests++
        beforePrepend?.()
        height = 1600
        setMessages(current => [message('older'), ...current])
      }} />
  }
  const root = createRoot(window.document.body.appendChild(window.document.createElement('div')) as never)
  try {
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
    const list = window.document.querySelector<HTMLDivElement>('.chat-history-scroll')!
    Object.defineProperties(list, { scrollHeight: { get: () => height }, clientHeight: { value: 400 } })
    list.scrollTop = 60
    await act(async () => list.dispatchEvent(new window.Event('scroll')))
    assert.equal(requests, 0)
    list.scrollTop = 30
    await act(async () => list.dispatchEvent(new window.Event('scroll')))
    assert.equal(requests, 1)
    assert.equal(list.scrollTop, 630)
    assert.equal(window.document.querySelector('.conversation-new-messages-button.has-label'), null)
    assert.match(list.textContent || '', /older.*latest/s)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

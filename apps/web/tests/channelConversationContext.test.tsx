import assert from 'node:assert/strict'
import test from 'node:test'
import { installDomEnvironment } from './helpers/domEnv'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import ChannelConversationContext from '../src/components/ChannelConversationContext'
import { useChatListStore } from '../src/stores/chatSessionStore'

test('channel context shows group name, stable ID, initiator and current sender', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const previous = useChatListStore.getState()
  const render = async () => {
    await act(async () => root.render(<I18nProvider><ChannelConversationContext projectId="p" sessionId="s" /></I18nProvider>))
    return container.textContent || ''
  }
  try {
    const base = { id: 's', project_id: 'p', workflow_id: '', title: '渠道', engine: 'codex', message_count: 1 }
    useChatListStore.setState({ sessionsByProject: { p: [{ ...base, source: 'channel', channel_platform: 'dingtalk',
      channel_name: '研发机器人', channel_conversation_type: 'group', channel_peer_name: '研发群', channel_group_name: '研发群',
      channel_conversation_id: 'room-1', channel_initiator_name: '小王', channel_initiator_id: 'u1',
      channel_sender_name: '小李', channel_sender_id: 'u2' }] } })
    const html = await render()
    for (const text of ['研发群', 'room-1', '小王', 'u1', '小李', 'u2', '对话发起者', '最近发送者']) assert.ok(html.includes(text))
    await act(async () => useChatListStore.setState({ sessionsByProject: { p: [{ ...base, source: 'chat' }] } }))
    assert.equal(await render(), '')
  } finally {
    await act(async () => root.unmount())
    useChatListStore.setState(previous)
    container.remove()
    await window.happyDOM.close()
  }
})

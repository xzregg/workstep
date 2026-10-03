import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import ChatSessionSourceBadge from '../src/components/ChatSessionSourceBadge'
import { I18nProvider } from '../src/i18n'

test('channel source shows a visible label while ordinary and legacy sessions do not', () => {
  const render = (source?: 'channel' | 'chat', platform?: string, botName?: string) => renderToStaticMarkup(
    <I18nProvider><ChatSessionSourceBadge source={source} platform={platform} botName={botName} /></I18nProvider>,
  )
  assert.match(render('channel', 'wecom'), /企业微信/)
  assert.match(render('channel', 'dingtalk'), /钉钉/)
  assert.match(render('channel', 'wecom', 'Echo'), />企业微信</)
  assert.match(render('channel'), /chat-session-source-badge/)
  assert.equal(render('chat'), '')
  assert.equal(render(), '')
})


test('channel conversations stay pinned when loading, adding and manually reordering sessions', async () => {
  const { useChatListStore } = await import('../src/stores/chatSessionStore')
  const { chatSessionApi } = await import('../src/api/client')
  const channel = { id: 'channel', title: 'Echo', source: 'channel' as const, project_id: 'p', workflow_id: '', engine: 'codex', message_count: 1 }
  const ordinary = { ...channel, id: 'ordinary', source: 'chat' as const }
  const other = { ...ordinary, id: 'other' }
  const list = chatSessionApi.list
  const reorder = chatSessionApi.reorder
  chatSessionApi.list = async () => ({ sessions: [ordinary, channel, other] })
  chatSessionApi.reorder = async () => ({ ok: true })
  useChatListStore.setState({ sessionsByProject: {}, listLoadingByProject: {} })
  const ids = () => useChatListStore.getState().sessionsByProject.p.map(item => item.id)
  try {
    await useChatListStore.getState().fetchSessions('p')
    assert.deepEqual(ids(), ['channel', 'ordinary', 'other'])
    useChatListStore.getState().addSession({ ...ordinary, id: 'new' })
    assert.deepEqual(ids(), ['channel', 'new', 'ordinary', 'other'])
    await useChatListStore.getState().reorderSessions('p', ['other', 'ordinary', 'new', 'channel'])
    assert.deepEqual(ids(), ['channel', 'other', 'ordinary', 'new'])
  } finally {
    chatSessionApi.list = list
    chatSessionApi.reorder = reorder
    useChatListStore.setState({ sessionsByProject: {} })
  }
})

test('channel badge shows only the platform and conversation type', () => {
  const render = (conversationType: 'single' | 'group', peerName: string) => renderToStaticMarkup(
    <I18nProvider><ChatSessionSourceBadge source="channel" platform="dingtalk" botName="Echo"
      conversationType={conversationType} peerName={peerName} /></I18nProvider>,
  )
  assert.match(render('single', '小王'), />钉钉 · 私聊</)
  assert.match(render('single', '小王'), /title="钉钉 · 私聊"/)
  assert.match(render('group', 'group-123'), />钉钉 · 群聊</)
  assert.doesNotMatch(render('group', 'group-123'), /私聊|group-123|Echo/)
  assert.doesNotMatch(render('single', '小王'), /小王|Echo/)
})

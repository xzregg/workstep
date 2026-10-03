import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import ChatSessionSourceBadge from '../src/components/ChatSessionSourceBadge'
import { I18nProvider } from '../src/i18n'

test('channel source shows a visible label while ordinary and legacy sessions do not', () => {
  const render = (source?: 'channel' | 'chat') => renderToStaticMarkup(
    <I18nProvider><ChatSessionSourceBadge source={source} /></I18nProvider>,
  )
  assert.match(render('channel'), /渠道/)
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

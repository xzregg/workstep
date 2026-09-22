import assert from 'node:assert/strict'
import test from 'node:test'

import { useChannelStore } from '../src/stores/channelStore.ts'

const channel = (id: string) => ({
  id: 'wechat', channel_type: 'wechat', display_name: '微信', icon: 'wechat',
  enabled: false, status: 'not_logged_in' as const, account_id: id,
  assistant_id: 'channel_chat', model: '', config: {}, error_message: null,
})

test('accepts WeChat login updates only from channel custom events', () => {
  useChannelStore.setState({ projectId: 'project-1', login: null })
  useChannelStore.getState().handleWsEvent({
    type: 'TEXT_MESSAGE_CHUNK',
    channel: 'channel_wechat',
    delta: 'ignored',
  })
  assert.equal(useChannelStore.getState().login, null)

  useChannelStore.getState().handleWsEvent({
    type: 'CUSTOM',
    name: 'channel.qr_code',
    channel: 'channel_wechat',
    project_id: 'project-1',
    value: {
      status: 'pending',
      qr_code: 'data:image/png;base64,QR',
    },
  })
  assert.deepEqual(useChannelStore.getState().login, {
    status: 'pending',
    qr_code: 'data:image/png;base64,QR',
    account_id: null,
    error: null,
  })
})

test('ignores channel events belonging to another project', () => {
  useChannelStore.setState({ projectId: 'project-a', login: null })
  useChannelStore.getState().handleWsEvent({
    type: 'CUSTOM',
    name: 'channel.qr_code',
    channel: 'channel_wechat',
    project_id: 'project-b',
    value: { status: 'pending', qr_code: 'secret-project-b' },
  })
  assert.equal(useChannelStore.getState().login, null)
})

test('clears old state and ignores stale project load responses', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const pending = new Map<string, (response: Response) => void>()
  globalThis.fetch = async (input) => new Promise<Response>((resolve) => {
    pending.set(String(input), resolve)
  })
  useChannelStore.setState({
    projectId: 'old', channels: [channel('old')],
    login: { status: 'success', qr_code: null, account_id: 'old', error: null },
    loading: false, saving: false, error: '',
  })

  const first = useChannelStore.getState().load('project-a')
  assert.deepEqual(useChannelStore.getState().channels, [])
  assert.equal(useChannelStore.getState().login, null)
  const second = useChannelStore.getState().load('project-b')
  pending.get('/api/channels?project_id=project-b')!(Response.json([channel('project-b')]))
  await second
  pending.get('/api/channels?project_id=project-a')!(Response.json([channel('project-a')]))
  await first

  assert.equal(useChannelStore.getState().projectId, 'project-b')
  assert.equal(useChannelStore.getState().channels[0].account_id, 'project-b')
})

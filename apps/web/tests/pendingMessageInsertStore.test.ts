import assert from 'node:assert/strict'
import test from 'node:test'

import { pendingMessageInsertApi } from '../src/api/client'
import { usePendingMessageInsertStore } from '../src/stores/pendingMessageInsertStore'

const pendingItem = (targetMessageId: string, suffix: string) => ({
  id: `insert-${suffix}`,
  target_message_id: targetMessageId,
  content: suffix,
  position: 0,
  username: '测试用户',
  created_at: '',
  updated_at: '',
})

test('pending insert store deduplicates initial reads across mounted pages', async () => {
  const originalList = pendingMessageInsertApi.list
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  pendingMessageInsertApi.list = async (_projectId, targetMessageId) => {
    calls += 1
    await gate
    return {
      items: [{
        id: `insert-${targetMessageId}`,
        target_message_id: targetMessageId,
        content: '补充',
        position: 0,
        username: '测试用户',
        created_at: '',
        updated_at: '',
      }],
    }
  }
  usePendingMessageInsertStore.setState({ queues: {}, loaded: {}, loading: {} })

  try {
    const first = usePendingMessageInsertStore.getState().load('project-1', 'message-1')
    const duplicate = usePendingMessageInsertStore.getState().load('project-1', 'message-1')
    assert.equal(calls, 1)
    release()
    await Promise.all([first, duplicate])

    await usePendingMessageInsertStore.getState().load('project-1', 'message-1')
    assert.equal(calls, 1)
    assert.equal(
      usePendingMessageInsertStore.getState().queues['project-1:message-1'][0].content,
      '补充',
    )
  } finally {
    pendingMessageInsertApi.list = originalList
    usePendingMessageInsertStore.setState({ queues: {}, loaded: {}, loading: {} })
  }
})

test('pending insert store discards items consumed by an immediate send', () => {
  usePendingMessageInsertStore.setState({
    queues: {
      'project-1:message-1': [
        pendingItem('message-1', 'first'),
        pendingItem('message-1', 'second'),
      ],
    },
    loaded: {},
    loading: {},
  })

  usePendingMessageInsertStore.getState().discard(
    'project-1',
    'message-1',
    ['insert-first'],
  )

  assert.deepEqual(
    usePendingMessageInsertStore.getState().queues['project-1:message-1'].map((item) => item.id),
    ['insert-second'],
  )
  usePendingMessageInsertStore.setState({ queues: {}, loaded: {}, loading: {} })
})

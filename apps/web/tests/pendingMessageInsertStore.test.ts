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

test('a slow initial queue read cannot overwrite a newly added insert', async () => {
  const originalList = pendingMessageInsertApi.list
  const originalCreate = pendingMessageInsertApi.create
  let release!: (result: { items: ReturnType<typeof pendingItem>[] }) => void
  pendingMessageInsertApi.list = () => new Promise(resolve => { release = resolve })
  pendingMessageInsertApi.create = async () => pendingItem('message-1', 'new')
  usePendingMessageInsertStore.setState({ queues: {}, loaded: {}, loading: {} })
  try {
    const loading = usePendingMessageInsertStore.getState().load('project-1', 'message-1')
    await usePendingMessageInsertStore.getState().add('project-1', 'message-1', 'new')
    release({ items: [pendingItem('message-1', 'old')] })
    await loading
    assert.deepEqual(usePendingMessageInsertStore.getState().queues['project-1:message-1'].map(i => i.id),
      ['insert-old', 'insert-new'])
  } finally {
    pendingMessageInsertApi.list = originalList
    pendingMessageInsertApi.create = originalCreate
    usePendingMessageInsertStore.setState({ queues: {}, loaded: {}, loading: {} })
  }
})

test('a late insert already consumed by the coordinator does not become a ghost queue item', async () => {
  const originalCreate = pendingMessageInsertApi.create
  pendingMessageInsertApi.create = async () => ({ ...pendingItem('message-1', 'late'), consumed: true })
  usePendingMessageInsertStore.setState({ queues: {}, loaded: {}, loading: {} })
  try {
    await usePendingMessageInsertStore.getState().add('project-1', 'message-1', 'late')
    assert.deepEqual(usePendingMessageInsertStore.getState().queues['project-1:message-1'] || [], [])
  } finally {
    pendingMessageInsertApi.create = originalCreate
    usePendingMessageInsertStore.setState({ queues: {}, loaded: {}, loading: {} })
  }
})

test('a slow queue read cannot resurrect an insert already sent manually', async () => {
  const originalList = pendingMessageInsertApi.list
  let release!: (result: { items: ReturnType<typeof pendingItem>[] }) => void
  pendingMessageInsertApi.list = () => new Promise(resolve => { release = resolve })
  usePendingMessageInsertStore.setState({ queues: { 'project-1:message-1': [pendingItem('message-1', 'old')] },
    loaded: {}, loading: {} })
  try {
    const loading = usePendingMessageInsertStore.getState().load('project-1', 'message-1')
    usePendingMessageInsertStore.getState().discard('project-1', 'message-1', ['insert-old'])
    release({ items: [pendingItem('message-1', 'old')] })
    await loading
    assert.deepEqual(usePendingMessageInsertStore.getState().queues['project-1:message-1'], [])
  } finally {
    pendingMessageInsertApi.list = originalList
    usePendingMessageInsertStore.setState({ queues: {}, loaded: {}, loading: {} })
  }
})

test('a read racing a consumed late insert cannot restore the consumed row', async () => {
  const originalList = pendingMessageInsertApi.list, originalCreate = pendingMessageInsertApi.create
  let release!: (result: { items: ReturnType<typeof pendingItem>[] }) => void
  pendingMessageInsertApi.list = () => new Promise(resolve => { release = resolve })
  pendingMessageInsertApi.create = async () => ({ ...pendingItem('message-1', 'late'), consumed: true })
  usePendingMessageInsertStore.setState({ queues: {}, loaded: {}, loading: {} })
  try {
    const loading = usePendingMessageInsertStore.getState().load('project-1', 'message-1')
    await usePendingMessageInsertStore.getState().add('project-1', 'message-1', 'late')
    release({ items: [pendingItem('message-1', 'late')] })
    await loading
    assert.deepEqual(usePendingMessageInsertStore.getState().queues['project-1:message-1'], [])
  } finally {
    pendingMessageInsertApi.list = originalList
    pendingMessageInsertApi.create = originalCreate
    usePendingMessageInsertStore.setState({ queues: {}, loaded: {}, loading: {} })
  }
})

test('a create acknowledgement merges an insert already returned by the queue read', async () => {
  const originalList = pendingMessageInsertApi.list, originalCreate = pendingMessageInsertApi.create
  const item = pendingItem('message-1', 'new')
  let accept!: (item: ReturnType<typeof pendingItem>) => void
  pendingMessageInsertApi.create = () => new Promise(resolve => { accept = resolve })
  pendingMessageInsertApi.list = async () => ({ items: [item] })
  usePendingMessageInsertStore.setState({ queues: {}, loaded: {}, loading: {} })
  try {
    const adding = usePendingMessageInsertStore.getState().add('project-1', 'message-1', 'new')
    await usePendingMessageInsertStore.getState().load('project-1', 'message-1')
    accept(item)
    await adding
    assert.deepEqual(usePendingMessageInsertStore.getState().queues['project-1:message-1'], [item])
  } finally {
    pendingMessageInsertApi.list = originalList
    pendingMessageInsertApi.create = originalCreate
    usePendingMessageInsertStore.setState({ queues: {}, loaded: {}, loading: {} })
  }
})

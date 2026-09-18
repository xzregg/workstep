import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import {
  clearInsertQueue,
  clearTaskInsertQueue,
  loadInsertQueue,
  loadTaskInsertQueue,
  saveInsertQueue,
  saveTaskInsertQueue,
} from '../src/utils/chatInsertQueue'

function installStorage() {
  const window = new Window({ url: 'http://localhost/' })
  Object.assign(globalThis, { localStorage: window.localStorage })
  return window
}

test('session queues are keyed by session id only', () => {
  const window = installStorage()
  try {
    saveInsertQueue('session-a', [{ id: 'a', content: 'A' }])
    assert.deepEqual(loadInsertQueue('session-a'), [{ id: 'a', content: 'A' }])
    assert.equal(
      window.localStorage.getItem('workstep-chat-insert-queue:session-a'),
      JSON.stringify([{ id: 'a', content: 'A' }]),
    )
    assert.equal(window.localStorage.getItem('workstep-chat-insert-queue:project-1:session-a'), null)
  } finally {
    void window.happyDOM.close()
  }
})

test('task queues are keyed by task id only', () => {
  const window = installStorage()
  try {
    saveTaskInsertQueue('task-a', [{ id: 'task-insert', content: '任务队列' }])
    assert.deepEqual(loadTaskInsertQueue('task-a'), [{ id: 'task-insert', content: '任务队列' }])
    assert.equal(
      window.localStorage.getItem('workstep-task-insert-queue:task-a'),
      JSON.stringify([{ id: 'task-insert', content: '任务队列' }]),
    )
    assert.equal(window.localStorage.getItem('workstep-task-insert-queue:project-1:task-a'), null)
  } finally {
    void window.happyDOM.close()
  }
})

test('legacy project-scoped queues migrate without losing items', () => {
  const window = installStorage()
  try {
    window.localStorage.setItem(
      'workstep-chat-insert-queue:project-1:session-a',
      JSON.stringify([{ id: 'legacy', content: '旧队列' }]),
    )
    assert.deepEqual(
      loadInsertQueue('session-a', 'project-1'),
      [{ id: 'legacy', content: '旧队列' }],
    )
    assert.equal(
      window.localStorage.getItem('workstep-chat-insert-queue:session-a'),
      JSON.stringify([{ id: 'legacy', content: '旧队列' }]),
    )
    assert.equal(window.localStorage.getItem('workstep-chat-insert-queue:project-1:session-a'), null)
  } finally {
    void window.happyDOM.close()
  }
})

test('clear helpers remove current session keys and task keys', () => {
  const window = installStorage()
  try {
    saveInsertQueue('session-a', [{ id: 'a', content: 'A' }])
    saveTaskInsertQueue('task-a', [{ id: 't', content: 'T' }])
    window.localStorage.setItem('workstep-chat-insert-queue:project-1:session-a', '[]')
    clearInsertQueue('session-a', 'project-1')
    clearTaskInsertQueue('task-a', 'project-1')
    assert.equal(window.localStorage.getItem('workstep-chat-insert-queue:session-a'), null)
    assert.equal(window.localStorage.getItem('workstep-chat-insert-queue:project-1:session-a'), null)
    assert.equal(window.localStorage.getItem('workstep-task-insert-queue:task-a'), null)
  } finally {
    void window.happyDOM.close()
  }
})

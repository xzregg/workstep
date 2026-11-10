import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { useChatWorkspaceStore, type ChatWorkspaceSnapshot } from '../src/stores/chatWorkspaceStore'
import { useChatListStore } from '../src/stores/chatSessionStore'
import { useRecentVisitsStore } from '../src/stores/recentVisitsStore'
import { useProjectStore } from '../src/stores/projectStore'
import { chatSessionApi } from '../src/api/client'
import { appearanceStorageKey, setAppearanceScope } from '../src/utils/appearanceStorage'

const snapshot: ChatWorkspaceSnapshot = {
  panes: [
    { id: 'one', projectId: 'p1', sessionId: 's1' },
    { id: 'two', projectId: 'p2', sessionId: null },
  ],
  layout: 'vertical',
  sizes: { vertical: { scope: 'one/two', values: [400, 600] } },
}

test('workspace metadata survives memory loss, remains account scoped and persists closed panes', async () => {
  const { window } = installDomEnvironment()
  try {
    setAppearanceScope('alice')
    const scope = appearanceStorageKey('chat-workspace')
    useChatWorkspaceStore.getState().save(scope, snapshot)
    useChatWorkspaceStore.setState({ workspaces: {} })
    assert.deepEqual(useChatWorkspaceStore.getState().restore(scope), snapshot)
    setAppearanceScope('bob')
    assert.equal(useChatWorkspaceStore.getState().restore(appearanceStorageKey('chat-workspace')), undefined)
    setAppearanceScope(null)
    assert.equal(useChatWorkspaceStore.getState().restore(appearanceStorageKey('chat-workspace')), undefined)
    useChatWorkspaceStore.getState().save(scope, { ...snapshot, panes: snapshot.panes.slice(0, 1), sizes: {} })
    useChatWorkspaceStore.setState({ workspaces: {} })
    assert.equal(useChatWorkspaceStore.getState().restore(scope)?.panes.length, 1)
    assert.doesNotMatch(localStorage.getItem(`${scope}:v1`)!, /messages|content|draft/)
  } finally {
    setAppearanceScope(null)
    useChatWorkspaceStore.setState({ workspaces: {} })
    await window.happyDOM.close()
  }
})

test('invalid workspace caches are ignored and invalid pane sizes fall back to equal sizing', async () => {
  const { window } = installDomEnvironment()
  try {
    useChatWorkspaceStore.setState({ workspaces: {} })
    for (const value of ['{', 'null', JSON.stringify({ ...snapshot, panes: [null] }),
      JSON.stringify({ ...snapshot, panes: [snapshot.panes[0], snapshot.panes[0]] }),
      JSON.stringify({ ...snapshot, layout: 'broken' })]) {
      localStorage.setItem('invalid:v1', value)
      assert.equal(useChatWorkspaceStore.getState().restore('invalid'), undefined)
    }
    localStorage.setItem('invalid:v1', JSON.stringify({ ...snapshot, sizes: { vertical: { scope: 'one/two', values: [-1, 400] } } }))
    assert.deepEqual(useChatWorkspaceStore.getState().restore('invalid'), { ...snapshot, sizes: {} })
  } finally {
    await window.happyDOM.close()
  }
})

test('removal selects unopened recent conversations in order and preserves pane sizes', async () => {
  const { window } = installDomEnvironment()
  const originalCreate = chatSessionApi.create
  try {
    chatSessionApi.create = async () => { throw new Error('must reuse existing conversations') }
    useProjectStore.setState({ projects: [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }] as never })
    useChatListStore.setState({ sessionsByProject: { p1: [{ id: 'fallback', project_id: 'p1' }] } as never })
    useRecentVisitsStore.setState({ entries: [
      { kind: 'session', id: 'open', projectId: 'p2', title: '', visitedAt: 3 },
      { kind: 'task', id: 'task', projectId: 'p1', title: '', visitedAt: 2 },
      { kind: 'session', id: 'recent', projectId: 'p2', title: '', visitedAt: 1 },
    ] })
    const scope = appearanceStorageKey('chat-workspace')
    const saved = { ...snapshot, panes: [snapshot.panes[0], { ...snapshot.panes[1], sessionId: 'open' }] }
    useChatWorkspaceStore.getState().save(scope, saved)
    await useChatWorkspaceStore.getState().removeSessions('p1', ['s1'])
    assert.deepEqual(useChatWorkspaceStore.getState().restore(scope), {
      ...saved, panes: [{ id: 'one', projectId: 'p2', sessionId: 'recent' }, saved.panes[1]],
    })
    await useChatWorkspaceStore.getState().removeSessions('p2', ['recent'])
    assert.deepEqual(useChatWorkspaceStore.getState().restore(scope)?.panes[0], { id: 'one', projectId: 'p1', sessionId: 'fallback' })
  } finally {
    chatSessionApi.create = originalCreate
    useRecentVisitsStore.setState({ entries: [] })
    useChatWorkspaceStore.setState({ workspaces: {} })
    await window.happyDOM.close()
  }
})

test('failed fallback creation preserves empty windows without undoing successful removal', async () => {
  const { window } = installDomEnvironment()
  const originalCreate = chatSessionApi.create
  try {
    useProjectStore.setState({ projects: [{ id: 'p1', name: 'One' }] as never })
    useChatListStore.setState({ sessionsByProject: {} })
    useRecentVisitsStore.setState({ entries: [] })
    chatSessionApi.create = async () => { throw new Error('create failed') }
    const scope = appearanceStorageKey('chat-workspace')
    useChatWorkspaceStore.getState().save(scope, { ...snapshot, panes: [snapshot.panes[0]] })
    assert.equal(await useChatWorkspaceStore.getState().removeSessions('p1', ['s1']), true)
    assert.deepEqual(useChatWorkspaceStore.getState().restore(scope)?.panes, [{ ...snapshot.panes[0], sessionId: null }])
  } finally {
    chatSessionApi.create = originalCreate
    useChatWorkspaceStore.setState({ workspaces: {} })
    await window.happyDOM.close()
  }
})

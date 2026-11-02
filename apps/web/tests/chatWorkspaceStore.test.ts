import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { useChatWorkspaceStore, type ChatWorkspaceSnapshot } from '../src/stores/chatWorkspaceStore'
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

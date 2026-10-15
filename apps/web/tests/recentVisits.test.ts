import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { setAppearanceScope } from '../src/utils/appearanceStorage'
import { useRecentVisitsStore, recentVisitPath } from '../src/stores/recentVisitsStore'
import { useChatListStore } from '../src/stores/chatSessionStore'
import { chatSessionApi } from '../src/api/client'

test('bulk deletion clears only successfully deleted sessions in the owning project', async () => {
  installDomEnvironment()
  setAppearanceScope(null)
  const recent = useRecentVisitsStore.getState()
  recent.visit({ kind: 'session', id: 'deleted', projectId: 'p', title: '已删除' })
  recent.visit({ kind: 'session', id: 'skipped', projectId: 'p', title: '运行中跳过' })
  recent.visit({ kind: 'session', id: 'deleted', projectId: 'other', title: '其他项目' })
  recent.visit({ kind: 'task', id: 'deleted', projectId: 'p', title: '任务' })
  const originalBulk = chatSessionApi.bulkDelete
  const originalList = useChatListStore.getState()
  chatSessionApi.bulkDelete = async () => ({ deleted: ['deleted'], skipped: ['skipped'] })
  useChatListStore.setState({ selectedIds: new Set(['deleted', 'skipped']), bulkDeleting: false })
  try {
    await useChatListStore.getState().bulkRemove('p')
    recent.hydrate()
    assert.deepEqual(useRecentVisitsStore.getState().entries.map(x => [x.kind, x.projectId, x.id]), [
      ['task', 'p', 'deleted'], ['session', 'other', 'deleted'], ['session', 'p', 'skipped'],
    ])
  } finally {
    chatSessionApi.bulkDelete = originalBulk
    useChatListStore.setState(originalList)
  }
})

test('recent visits persist locally, deduplicate by project and type, and keep the latest twenty', () => {
  installDomEnvironment()
  setAppearanceScope(null)
  const store = useRecentVisitsStore.getState()
  store.hydrate()
  for (let i = 0; i < 21; i++) store.visit({ kind: 'session', id: `${i}`, projectId: 'p', title: `对话${i}` })
  assert.deepEqual(useRecentVisitsStore.getState().entries.map(x => x.id), Array.from({ length: 20 }, (_, index) => String(20 - index)))
  store.visit({ kind: 'session', id: '2', projectId: 'p', title: '重命名对话' })
  assert.deepEqual(useRecentVisitsStore.getState().entries.map(x => x.id), ['2', ...Array.from({ length: 20 }, (_, index) => String(20 - index)).filter(id => id !== '2')])
  store.visit({ kind: 'task', id: '2', projectId: 'p', title: '同 ID 任务', workflowId: 'wf' })
  store.visit({ kind: 'session', id: '2', projectId: 'other', title: '另一项目' })
  assert.equal(useRecentVisitsStore.getState().entries.length, 20)
  assert.equal(useRecentVisitsStore.getState().entries.filter(x => x.id === '2').length, 3)
  const before = useRecentVisitsStore.getState().entries
  useRecentVisitsStore.setState({ entries: [] })
  store.hydrate()
  assert.deepEqual(useRecentVisitsStore.getState().entries, before)
})

test('metadata updates do not move an older visit above a more recent visit', () => {
  installDomEnvironment()
  const store = useRecentVisitsStore.getState()
  const older = { kind: 'task' as const, id: 'a', projectId: 'p', title: '任务' }
  store.visit(older)
  store.visit({ ...older, id: 'b' })
  store.update({ ...older, title: '新标题' })
  assert.deepEqual(useRecentVisitsStore.getState().entries.map(x => x.id), ['b', 'a'])
  assert.equal(useRecentVisitsStore.getState().entries[1].title, '新标题')
})

test('local recent visits are scoped to the current authenticated device identity', () => {
  installDomEnvironment()
  const store = useRecentVisitsStore.getState()
  setAppearanceScope('alice')
  store.visit({ kind: 'session', id: 'private', projectId: 'p', title: 'Alice' })
  setAppearanceScope('bob')
  store.hydrate()
  assert.deepEqual(useRecentVisitsStore.getState().entries, [])
  setAppearanceScope('alice')
  store.hydrate()
  assert.equal(useRecentVisitsStore.getState().entries[0].title, 'Alice')
  setAppearanceScope(null)
})

test('recent links return to the original session or task and use the current project name', () => {
  const project = { name: '演示 & 项目' }
  const session = recentVisitPath({ kind: 'session', id: 's&1', projectId: 'p', title: '对话' }, project)
  const task = recentVisitPath({ kind: 'task', id: 't&1', projectId: 'p', title: '任务', workflowId: 'wf' }, project)
  assert.equal(new URL(session, 'http://localhost').pathname, '/chat')
  assert.equal(new URL(session, 'http://localhost').searchParams.get('session'), 's&1')
  assert.equal(new URL(task, 'http://localhost').pathname, '/tasks')
  assert.equal(new URL(task, 'http://localhost').searchParams.get('task'), 't&1')
  assert.equal(new URL(task, 'http://localhost').searchParams.get('workflow'), 'wf')
  assert.equal(new URL(task, 'http://localhost').searchParams.get('project'), project.name)
})

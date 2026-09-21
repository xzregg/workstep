import test from 'node:test'
import assert from 'node:assert/strict'
import { initialWorkspaces, commitWorkspace, stageFile, switchMockBranch, worktrees } from '../src/pages/prototype/gitPrototypeModel.ts'

test('prototype staging and commit stay isolated to a worktree', () => {
  const initial = initialWorkspaces()
  const next = { ...initial, feature: stageFile(initial.feature, 'runner', true) }
  const committed = commitWorkspace(next.feature, 'fix: isolate project execution')
  assert.equal(committed.files.some(file => file.id === 'runner'), false)
  assert.equal(committed.files.some(file => file.id === 'test'), true)
  assert.deepEqual(next.main, initial.main)
  assert.equal(initial.feature.files.find(file => file.id === 'runner')?.staged, false)
  assert.equal(committed.history[0].message, 'fix: isolate project execution')
})

test('empty commit and missing staged files do not change the workspace', () => {
  const state = initialWorkspaces().feature
  assert.equal(commitWorkspace(state, '   '), state)
  assert.equal(commitWorkspace(state, 'message'), state)
})

test('branch switch updates only a clean selected worktree and keeps its path', () => {
  const result = switchMockBranch(worktrees, initialWorkspaces(), 'scroll', 'develop')
  assert.equal(result.kind, 'switched')
  if (result.kind !== 'switched') return
  assert.equal(result.trees.find(tree => tree.id === 'scroll')?.branch, 'develop')
  assert.equal(result.trees.find(tree => tree.id === 'scroll')?.path, worktrees[2].path)
  assert.equal(result.trees.find(tree => tree.id === 'main')?.branch, 'main')
  assert.equal(worktrees[2].branch, 'fix/chat-scroll')
})

test('branch switch preserves dirty files and identifies branches used by another worktree', () => {
  const spaces = initialWorkspaces()
  const before = structuredClone(spaces)
  assert.deepEqual(switchMockBranch(worktrees, spaces, 'feature', 'develop'), { kind: 'dirty' })
  assert.deepEqual(switchMockBranch(worktrees, spaces, 'scroll', 'main'), { kind: 'occupied', workspaceId: 'main' })
  assert.deepEqual(switchMockBranch(worktrees, spaces, 'scroll', 'fix/chat-scroll'), { kind: 'current' })
  assert.deepEqual(spaces, before)
})

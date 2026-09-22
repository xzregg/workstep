import assert from 'node:assert/strict'
import test from 'node:test'
import type { GitDiscovery } from '../src/api/git'
import { clampGitTreeWidth, gitReturnTarget, scopeGitDiscovery } from '../src/pages/GitWorkspace'

test('Git return target prefers its internal source and rejects external destinations', () => {
  assert.equal(gitReturnTarget('/chat?project=Project&session=session-1', 'Project'), '/chat?project=Project&session=session-1')
  assert.equal(gitReturnTarget('https://attacker.example', 'Project'), '/tasks?project=Project')
  assert.equal(gitReturnTarget('//attacker.example', 'Project'), '/tasks?project=Project')
})

test('Git sidebar resize keeps the tree usable without covering the workspace', () => {
  assert.equal(clampGitTreeWidth(100, 1200), 230)
  assert.equal(clampGitTreeWidth(360, 1200), 360)
  assert.equal(clampGitTreeWidth(900, 1200), 504)
})

test('Git workspace only exposes repositories discovered from the entry project', () => {
  const data = {
    projects: [
      { id: 'project-a', name: 'A', path: '/workspace/a' },
      { id: 'project-b', name: 'B', path: '/workspace/b' },
    ],
    repositories: [
      { id: 'repo-a', name: 'a', common_dir: '/workspace/a/.git', worktrees: [], projects: [{ id: 'project-a', relative_path: '.' }] },
      { id: 'repo-b', name: 'b', common_dir: '/workspace/b/.git', worktrees: [], projects: [{ id: 'project-b', relative_path: '.' }] },
      { id: 'shared', name: 'shared', common_dir: '/tmp/shared/.git', worktrees: [], projects: [{ id: 'project-a', relative_path: 'shared' }, { id: 'project-b', relative_path: 'shared' }] },
    ],
    depth: 5,
    scanned_at: 1,
    errors: [{ path: '/workspace/a/missing', message: 'a' }, { path: '/workspace/b/missing', message: 'b' }],
  } as GitDiscovery
  const scoped = scopeGitDiscovery(data, 'project-a')
  assert.deepEqual(scoped.projects.map(project => project.id), ['project-a'])
  assert.deepEqual(scoped.repositories.map(repo => repo.id), ['repo-a', 'shared'])
  assert.deepEqual(scoped.errors.map(error => error.message), ['a'])
})

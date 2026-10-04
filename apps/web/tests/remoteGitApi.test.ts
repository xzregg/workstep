import assert from 'node:assert/strict'
import test from 'node:test'
import { createProjectGitApi } from '../src/api/git'
import type { request } from '../src/api/client'

test('project Git client scopes reads and writes and maps discovery to the client project', async () => {
  const calls: { path: string; options?: RequestInit }[] = []
  const client = (async (path: string, options?: RequestInit) => {
    calls.push({ path, options })
    return { projects: [{ id: 'owner', name: 'Remote', path: '/remote' }], repositories: [{ id: 'repo', projects: [{ id: 'owner', relative_path: '.' }] }], errors: [] }
  }) as typeof request
  const api = createProjectGitApi('remote:abc', client)
  const data = await api.repositories()
  assert.equal(data.projects[0].id, 'remote:abc')
  assert.equal(data.repositories[0].projects[0].id, 'remote:abc')
  await api.status('tree')
  await api.diff('tree', 'a b.ts', { ref: 'HEAD' })
  await api.commit('tree', ['a b.ts'], 'fix', 'snapshot')
  await api.openTaskWorkspace('remote:abc', 'task')
  for (const call of calls) assert.equal(new URL(call.path, 'http://test').searchParams.get('project_id'), 'remote:abc')
  assert.match(calls[0].path, /projects\/remote%3Aabc\/repositories/)
  assert.equal(new URL(calls[2].path, 'http://test').searchParams.get('path'), 'a b.ts')
  assert.equal(calls[3].options?.method, 'POST')
})

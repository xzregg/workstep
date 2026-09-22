import assert from 'node:assert/strict'
import test from 'node:test'
import { gitApi, type GitDiscovery } from '../src/api/git'
import { useGitStore } from '../src/stores/gitStore'

test('scan deduplicates simultaneous callers and follows a settings change during an active scan', async () => {
  const original = { ...gitApi }
  let count = 0
  let release!: () => void
  gitApi.scan = async () => { count++; if (count === 1) await new Promise<void>(resolve => { release = resolve }); return { id: String(count), state: 'complete', completed_projects: 1, total_projects: 1 } }
  gitApi.repositories = async () => ({ projects: [], repositories: [], depth: count, scanned_at: 1, errors: [] } as GitDiscovery)
  try {
    const first = useGitStore.getState().scan('depth5')
    const same = useGitStore.getState().scan('depth5')
    assert.equal(first, same)
    void useGitStore.getState().scan('depth3')
    release()
    await first
    assert.equal(count, 2)
    assert.equal(useGitStore.getState().data?.depth, 2)
    assert.equal(useGitStore.getState().scanning, false)
  } finally { Object.assign(gitApi, original) }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { sharedTaskFilePath } from '../src/pages/sharedTaskFiles'
import type { TaskArtifact } from '../src/api/client'

test('share maps new artifact files to authorized IDs with full directory boundaries', () => {
  const artifacts = [{ source_path: 'flow/task/build/req1/new.md', path: 'artifact:authorized' }] as TaskArtifact[]
  for (const path of ['/data/project/.workstep/artifacts/flow/task/build/req1/new.md',
    '.workstep/artifacts/flow/task/build/req1/new.md', 'flow/task/build/req1/new.md']) {
    assert.equal(sharedTaskFilePath(path, artifacts), 'artifact:authorized')
  }
  for (const path of ['/data/project/.workstep/artifacts/flow/other/build/req1/new.md',
    'new.md', 'workspace:app/new.md', 'artifact:authorized']) {
    assert.equal(sharedTaskFilePath(path, artifacts), path)
  }
})

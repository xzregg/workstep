import assert from 'node:assert/strict'
import test from 'node:test'
import { createPanelGitWrites, GitPanelBusyError } from '../src/components/git/gitPanelWrites'

test('panel writes reject a second write in the same tick and release after failure', async () => {
  let finish!: () => void
  const writes = createPanelGitWrites()
  const first = writes.run(() => new Promise<void>((_, reject) => { finish = () => reject(new Error('failed')) }))
  assert.equal(writes.isBusy(), true)
  await assert.rejects(writes.run(async () => {}), GitPanelBusyError)
  finish()
  await assert.rejects(first, /failed/)
  assert.equal(writes.isBusy(), false)
  await writes.run(async () => {})
})

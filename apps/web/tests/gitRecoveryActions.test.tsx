import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import GitRecoveryActions from '../src/components/git/GitRecoveryActions'
import { gitApi, type GitStatus } from '../src/api/git'

test('recovery previews the recorded target merge before applying it', async () => {
  const { window } = installDomEnvironment()
  const original = { recoveries: gitApi.recoveries, recoveryPreview: gitApi.recoveryPreview, recoveryApply: gitApi.recoveryApply }
  const status = { id: 'repo', branch: 'feature', head: 'source-head', files: [], snapshot: 'review', active: false, operation: null } as GitStatus
  const operation = { id: 'merge-1', target: 'main', source: 'feature', before: 'old', base: 'old', after: 'head', undone_by: null }
  let applied: unknown = null
  gitApi.recoveries = async () => ({ merges: [operation] })
  gitApi.recoveryPreview = async (_id, body) => ({ head: 'head', files: ['feature.txt'], changes: [{ path: 'feature.txt', added: '0', deleted: '1' }], request: body, strategy: 'fast_forward' })
  gitApi.recoveryApply = async (_id, body) => { applied = body; return { target: 'main', head: 'new', files: ['feature.txt'], push_available: false } }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><GitRecoveryActions status={status} disabled={false} request={null} onCloseRequest={() => {}} onRefresh={async () => {}} /></I18nProvider>))
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
    assert.match(document.body.textContent || '', /feature → main/)
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('feature → main'))!.click())
    assert.match(document.body.textContent || '', /feature.txt/)
    assert.equal(applied, null)
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Apply recovery')!.click())
    assert.deepEqual(applied, { mode: 'undo_merge', target: 'main', operation_id: 'merge-1', expected_head: 'head' })
  } finally {
    await act(async () => root.unmount())
    Object.assign(gitApi, original)
    container.remove()
    await window.happyDOM.close()
  }
})

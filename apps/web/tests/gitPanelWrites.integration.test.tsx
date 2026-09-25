import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import { type GitStatus } from '../src/api/git'
import GitRemoteActions from '../src/components/git/GitRemoteActions'
import GitMergeActions from '../src/components/git/GitMergeActions'
import GitRecoveryActions from '../src/components/git/GitRecoveryActions'
import { createPanelGitWrites, PanelGitWritesContext } from '../src/components/git/gitPanelWrites'

test('one panel write disables sibling Git actions until failure releases it', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const writes = createPanelGitWrites()
  const status = { id: 'tree', branch: 'main', head: 'abc', snapshot: 'snap', files: [], active: false, operation: null } as GitStatus
  const button = (label: string) => {
    const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes(label))
    assert.ok(found, container.textContent || '')
    return found
  }
  try {
    await act(async () => root.render(<I18nProvider><PanelGitWritesContext.Provider value={writes}>
      <GitRemoteActions status={status} readOnly={false} onRefresh={async () => {}} onBusy={() => {}} />
      <GitMergeActions status={status} readOnly={false} onRefresh={async () => {}} onBusy={() => {}} />
      <GitRecoveryActions status={status} disabled={false} request={null} onCloseRequest={() => {}} onRefresh={async () => {}} />
    </PanelGitWritesContext.Provider></I18nProvider>))
    let finish!: () => void
    let pending!: Promise<void>
    await act(async () => { pending = writes.run(() => new Promise<void>((_, reject) => { finish = () => reject(new Error('failed')) })) })
    assert.equal(button('推送').disabled, true)
    assert.equal(button('Merge').disabled, true)
    assert.equal(button('Undo / restore').disabled, true)
    await act(async () => { finish(); await assert.rejects(pending, /failed/) })
    assert.equal(button('推送').disabled, false)
    assert.equal(button('Merge').disabled, false)
    assert.equal(button('Undo / restore').disabled, false)
  } finally { await act(async () => root.unmount()); container.remove(); await window.happyDOM.close() }
})

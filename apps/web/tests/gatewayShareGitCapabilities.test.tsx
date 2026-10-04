import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import { gitApi } from '../src/api/git'
import { GitApiContext } from '../src/components/git/GitApiContext'
import GitChanges from '../src/components/git/GitChanges'

test('limited share Git controls retain commit and hide unsupported file mutations', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><GitApiContext.Provider value={{ api: gitApi,
      shared: true, readOnly: false, allowedActions: ['commit'], browseWorkspace: async () => { throw Error() } }}>
      <GitChanges status={{ id: 'tree', snapshot: 'snapshot', files: [{ path: 'README.md', worktree_status: 'M', index_status: ' ', untracked: false, staged: false, conflict: false, submodule: false, old_path: null }], operation: null } as any}
        onRefresh={async () => {}} onDiff={() => {}} />
    </GitApiContext.Provider></I18nProvider>))
    assert.ok(container.querySelector('[data-commit]'))
    assert.equal(container.querySelector('.git-file-action'), null)
    assert.equal(Array.from(container.querySelectorAll('button')).some(button => button.textContent?.includes('AI')), false)
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})

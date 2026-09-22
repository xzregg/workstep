import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import { GitFileList } from '../src/components/git/GitChanges'
import type { GitFile } from '../src/api/git'

test('folders collapse together and independently without changing file selection', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let toggled = 0
  const files = ['src/a.ts', 'tests/a.ts'].map(path => ({ path, old_path: null, index_status: ' ', worktree_status: 'M', staged: false, untracked: false, conflict: false, submodule: false } as GitFile))
  const button = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes(name))!
  try {
    await act(async () => root.render(<I18nProvider><GitFileList files={files} selected={['src/a.ts']} onToggle={() => toggled++} onDiff={() => {}} /></I18nProvider>))
    await act(async () => button('全部折叠').click())
    assert.equal(container.querySelectorAll('input[type=checkbox]').length, 0)
    await act(async () => button('src').click())
    assert.equal(container.querySelectorAll('input[type=checkbox]').length, 1)
    assert.equal(container.querySelector<HTMLInputElement>('input')!.checked, true)
    await act(async () => button('全部折叠').click())
    await act(async () => button('全部展开').click())
    assert.equal(container.querySelectorAll('input[type=checkbox]').length, 2)
    assert.equal(toggled, 0)
  } finally { await act(async () => root.unmount()); container.remove(); await window.happyDOM.close() }
})

test('file rows show status colors and expose discard and ignore actions', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const discarded: string[] = []
  const ignored: string[] = []
  const files = [
    { path: 'src/added.ts', old_path: null, index_status: '?', worktree_status: '?', staged: false, untracked: true, conflict: false, submodule: false },
    { path: 'src/deleted.ts', old_path: null, index_status: ' ', worktree_status: 'D', staged: false, untracked: false, conflict: false, submodule: false },
    { path: 'src/changed.ts', old_path: null, index_status: ' ', worktree_status: 'M', staged: false, untracked: false, conflict: false, submodule: false },
  ] as GitFile[]
  try {
    await act(async () => root.render(<I18nProvider><GitFileList files={files} onDiff={() => {}} onDiscard={file => discarded.push(file.path)} onIgnore={file => ignored.push(file.path)} /></I18nProvider>))
    assert.equal(container.querySelectorAll('.git-file--added').length, 1)
    assert.equal(container.querySelectorAll('.git-file--deleted').length, 1)
    assert.equal(container.querySelectorAll('.git-file--modified').length, 1)
    const discard = container.querySelector<HTMLButtonElement>('button[aria-label="撤销修改 src/changed.ts"]')!
    const ignore = container.querySelector<HTMLButtonElement>('button[aria-label="加入 Git 忽略 src/added.ts"]')!
    await act(async () => discard.click())
    await act(async () => ignore.click())
    assert.deepEqual(discarded, ['src/changed.ts'])
    assert.deepEqual(ignored, ['src/added.ts'])
    assert.equal(container.querySelector('button[aria-label="加入 Git 忽略 src/changed.ts"]'), null)
  } finally { await act(async () => root.unmount()); container.remove(); await window.happyDOM.close() }
})

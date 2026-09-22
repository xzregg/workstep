import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import { gitApi, type GitStatus } from '../src/api/git'
import GitChanges from '../src/components/git/GitChanges'

test('commit defaults to tracked files, preserves draft on failure, and sends only checked files', async () => {
  const { window } = installDomEnvironment()
  const original = gitApi.commit
  const calls: unknown[][] = []
  gitApi.commit = async (...args) => { calls.push(args); throw new Error('内容已变化') }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const state: GitStatus = { id: 'test', path: '/repo', branch: 'main', head: 'abc', snapshot: 'review', active: false, operation: null, upstream: null, ahead: null, behind: null, files: [
    { path: 'tracked.ts', old_path: null, index_status: ' ', worktree_status: 'M', staged: false, untracked: false, conflict: false, submodule: false },
    { path: 'new.ts', old_path: null, index_status: '?', worktree_status: '?', staged: false, untracked: true, conflict: false, submodule: false },
  ] }
  try {
    await act(async () => root.render(<I18nProvider><GitChanges status={state} onRefresh={async () => {}} onDiff={() => {}} /></I18nProvider>))
    const checks = container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')
    assert.equal(checks[0].checked, true)
    assert.equal(checks[1].checked, false)
    const input = container.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'selected change')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const button = container.querySelector<HTMLButtonElement>('[data-commit]')!
    assert.equal(button.disabled, false)
    await act(async () => button.click())
    assert.deepEqual(calls[0], ['test', ['tracked.ts'], 'selected change', 'review'])
    assert.equal(input.value, 'selected change')
    assert.match(container.textContent || '', /内容已变化/)
    await act(async () => root.render(<I18nProvider><GitChanges status={{ ...state, files: [...state.files, { ...state.files[0], path: 'later.ts' }] }} onRefresh={async () => {}} onDiff={() => {}} /></I18nProvider>))
    assert.equal(container.querySelector<HTMLInputElement>('input[aria-label="later.ts"]')!.checked, false)
  } finally {
    await act(async () => root.unmount())
    gitApi.commit = original
    container.remove()
    await window.happyDOM.close()
  }
})

test('AI generation uses checked files and fills the commit message', async () => {
  const { window } = installDomEnvironment()
  const original = gitApi.generateCommitMessage
  const calls: unknown[][] = []
  gitApi.generateCommitMessage = async (...args) => { calls.push(args); return { message: 'feat(git): 生成规范提交说明' } }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const state: GitStatus = { id: 'test', path: '/repo', branch: 'main', head: 'abc', snapshot: 'review', active: false, operation: null, upstream: null, ahead: null, behind: null, files: [
    { path: 'tracked.ts', old_path: null, index_status: ' ', worktree_status: 'M', staged: false, untracked: false, conflict: false, submodule: false },
    { path: 'new.ts', old_path: null, index_status: '?', worktree_status: '?', staged: false, untracked: true, conflict: false, submodule: false },
  ] }
  try {
    await act(async () => root.render(<I18nProvider><GitChanges status={state} onRefresh={async () => {}} onDiff={() => {}} /></I18nProvider>))
    const generate = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('AI 生成'))!
    await act(async () => generate.click())
    assert.deepEqual(calls, [['test', ['tracked.ts'], 'review']])
    assert.equal(container.querySelector<HTMLTextAreaElement>('textarea')!.value, 'feat(git): 生成规范提交说明')
    assert.match(container.textContent || '', /已按 Git 规范生成提交说明/)
  } finally {
    await act(async () => root.unmount())
    gitApi.generateCommitMessage = original
    container.remove()
    await window.happyDOM.close()
  }
})

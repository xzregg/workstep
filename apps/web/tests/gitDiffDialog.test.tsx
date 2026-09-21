import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import { gitApi, type GitDiff } from '../src/api/git'
import GitDiffDialog from '../src/components/git/GitDiffDialog'

test('split diff resizes and annotates both versions with their own line attribution', async () => {
  const { window } = installDomEnvironment()
  Object.defineProperty(globalThis, 'history', { configurable: true, value: window.history })
  const original = { ...gitApi }
  const fixture = { path: 'x.ts', old_path: 'x.ts', base: 'before', target: 'after', patch: '@@ -2,2 +3,2 @@ function x()\n same\n-old\n+new\n', before: '', after: '', binary: false, truncated: false, submodule: false } as GitDiff
  gitApi.diff = async () => fixture
  const refs: string[] = []
  gitApi.blame = async (_id, _path, ref) => {
    refs.push(ref)
    return { lines: [{ line: ref === 'before' ? 2 : 3, author: ref === 'before' ? 'Alice' : 'Bob', hash: ref, time: 1700000000, message: 'change' }] }
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const render = (path: string) => <I18nProvider><GitDiffDialog id="repo" files={[path]} path={path} comparison={{}} onSelect={() => {}} onClose={() => {}} /></I18nProvider>
  try {
    await act(async () => root.render(render('x.ts')))
    const blame = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '上次修改人')!
    await act(async () => blame.click())
    assert.deepEqual(refs.sort(), ['after', 'before'])
    assert.match(document.querySelector('[data-diff-side="before"]')!.textContent!, /Alice/)
    assert.match(document.querySelector('[data-diff-side="after"]')!.textContent!, /Bob/)
    const separator = document.querySelector<HTMLElement>('[role=separator]')!
    assert.equal(separator.getAttribute('aria-valuenow'), '50')
    await act(async () => separator.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    assert.equal(separator.getAttribute('aria-valuenow'), '55')
    await act(async () => separator.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
    assert.equal(separator.getAttribute('aria-valuenow'), '20')
    fixture.target = null
    refs.length = 0
    await act(async () => root.render(render('working.ts')))
    assert.deepEqual(refs, ['before'])
    const after = document.querySelector('[data-diff-side="after"]')!
    assert.match(after.textContent!, /Alice/)
    assert.match(after.textContent!, /尚未提交/)
    assert.doesNotMatch(after.textContent!, /Bob/)
  } finally { await act(async () => root.unmount()); Object.assign(gitApi, original); await window.happyDOM.close() }
})

test('working-tree diff edits and saves the current file with its review snapshot', async () => {
  const { window } = installDomEnvironment()
  Object.defineProperty(globalThis, 'history', { configurable: true, value: window.history })
  const original = { ...gitApi }
  const fixture = { path: 'x.ts', old_path: 'x.ts', base: 'before', target: null, patch: '@@ -3 +3 @@ function x()\n-old\n+const current = true\n', before: 'a\nb\nold\n', after: 'a\nb\nconst current = true\n', binary: false, truncated: false, submodule: false, snapshot: 'a'.repeat(64) } as GitDiff
  gitApi.diff = async () => fixture
  let saved: unknown[] = []
  gitApi.saveFile = async (...args) => { saved = args; return {} as never }
  let refreshed = 0
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider><GitDiffDialog id="repo" files={['x.ts']} path="x.ts" comparison={{}} onSelect={() => {}} onSaved={async () => { refreshed++ }} onClose={() => {}} /></I18nProvider>))
    const edit = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('编辑当前文件'))!
    await act(async () => edit.click())
    const editor = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="可编辑的当前文件"]')!
    assert.equal(editor.closest('.git-source-editor')?.getAttribute('data-target-line'), '3')
    assert.equal(editor.selectionStart, 4)
    assert.ok(editor.closest('.git-source-editor')?.querySelector('.hljs-keyword'))
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => { setter.call(editor, 'edited\n'); editor.dispatchEvent(new window.Event('input', { bubbles: true })) })
    const save = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('保存文件'))!
    await act(async () => save.click())
    assert.deepEqual(saved, ['repo', 'x.ts', 'edited\n', 'a'.repeat(64)])
    assert.equal(refreshed, 1)
  } finally { await act(async () => root.unmount()); Object.assign(gitApi, original); await window.happyDOM.close() }
})

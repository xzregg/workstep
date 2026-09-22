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
    const beforeCell = document.querySelector<HTMLElement>('[data-diff-side="before"] .git-code-cell')!
    const afterCell = document.querySelector<HTMLElement>('[data-diff-side="after"] .git-code-cell')!
    assert.equal(beforeCell.firstElementChild?.tagName, 'CODE')
    assert.ok(beforeCell.lastElementChild?.classList.contains('git-line-number'))
    assert.ok(afterCell.firstElementChild?.classList.contains('git-line-number'))
    assert.equal(afterCell.lastElementChild?.tagName, 'CODE')
    const line = document.querySelector<HTMLElement>('[data-diff-side="after"] .git-code-cell')!
    await act(async () => line.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 80 })))
    const contextMenu = document.querySelector<HTMLElement>('[role="menu"]')!
    assert.ok(contextMenu)
    assert.match(contextMenu.textContent!, /上次修改人/)
    const blame = contextMenu.querySelector<HTMLButtonElement>('[role="menuitem"]')!
    await act(async () => blame.click())
    assert.deepEqual(refs.sort(), ['after', 'before'])
    assert.equal(document.querySelector('[role="menu"]'), null)
    assert.match(document.querySelector('[data-diff-side="before"]')!.textContent!, /Alice/)
    assert.match(document.querySelector('[data-diff-side="after"]')!.textContent!, /Bob/)
    assert.equal(document.querySelector('[data-diff-side="before"] .git-blame .ws-marquee')?.textContent, 'Alice')
    assert.equal(document.querySelector('[data-diff-side="after"] .git-blame .ws-marquee')?.textContent, 'Bob')
    const author = document.querySelector<HTMLElement>('[data-diff-side="before"] .git-blame-author')!
    await act(async () => author.click())
    const commit = document.querySelector<HTMLElement>('[data-git-commit-popover]')!
    assert.match(commit.textContent!, /Alice/)
    assert.match(commit.textContent!, /change/)
    assert.match(commit.textContent!, /before/)
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
    const sourceEditors = [...document.querySelectorAll<HTMLElement>('.git-file-editor>.git-source-editor')]
    assert.ok(sourceEditors[0].classList.contains('gutter-right'))
    assert.ok(sourceEditors[1].classList.contains('gutter-left'))
    const leftLine = sourceEditors[0].querySelector<HTMLElement>('.code-preview-line')!
    const rightLine = sourceEditors[1].querySelector<HTMLElement>('.code-preview-line')!
    assert.ok(leftLine.firstElementChild?.classList.contains('code-preview-line-content'))
    assert.ok(leftLine.lastElementChild?.classList.contains('code-preview-line-number'))
    assert.ok(rightLine.firstElementChild?.classList.contains('code-preview-line-number'))
    const leftScroll = sourceEditors[0].querySelector<HTMLPreElement>('.git-source-highlight')!
    await act(async () => { editor.scrollTop = 120; editor.dispatchEvent(new window.Event('scroll', { bubbles: true })) })
    assert.equal(leftScroll.scrollTop, 120)
    await act(async () => { leftScroll.scrollTop = 60; leftScroll.dispatchEvent(new window.Event('scroll', { bubbles: true })) })
    assert.equal(editor.scrollTop, 60)
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

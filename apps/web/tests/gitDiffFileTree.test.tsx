import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import GitDiffFileTree from '../src/components/git/GitDiffFileTree'

const files = ['/project/apps/web/src/a.ts', 'apps/web/src/b.ts', 'docs/guide.md', 'README.md']

test('diff tree merges directory chains, selects original paths and supports collapse, expand and filename search', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const selected: string[] = []
  try {
    await act(async () => root.render(<I18nProvider><GitDiffFileTree files={files} path={files[0]}
      projectRoot="/project" onSelect={path => selected.push(path)} /></I18nProvider>))
    const labels = () => [...document.querySelectorAll('[role="treeitem"]')].map(node => node.textContent)
    assert.ok(labels().includes('apps/web/src'))
    assert.ok(labels().includes('a.ts'))
    assert.equal(document.querySelector('[aria-selected="true"]')?.getAttribute('title'), 'apps/web/src/a.ts')
    await act(async () => (document.querySelector('[title="apps/web/src/b.ts"]') as HTMLElement).click())
    assert.deepEqual(selected, ['apps/web/src/b.ts'])
    await act(async () => (document.querySelectorAll('.git-diff-tree-toolbar button')[1] as HTMLElement).click())
    assert.ok(!labels().includes('a.ts'))
    assert.ok(labels().includes('README.md'))
    await act(async () => (document.querySelectorAll('.git-diff-tree-toolbar button')[0] as HTMLElement).click())
    assert.ok(labels().includes('a.ts'))
    await act(async () => (document.querySelector('[title="apps/web/src/a.ts"]') as HTMLElement).click())
    assert.equal(selected[1], '/project/apps/web/src/a.ts')
    const search = document.querySelector('input')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(search, 'B.TS')
      search.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.deepEqual(labels(), ['apps/web/src', 'b.ts'])
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, 'missing')
      search.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.ok(document.querySelector('.git-diff-tree-empty'))
    assert.equal(document.querySelectorAll('[role="treeitem"]').length, 0)
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})

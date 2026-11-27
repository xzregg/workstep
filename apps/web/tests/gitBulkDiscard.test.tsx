import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import { gitApi, type GitStatus } from '../src/api/git'
import GitChanges from '../src/components/git/GitChanges'
import { GitApiContext } from '../src/components/git/GitApiContext'
import { createPanelGitWrites, PanelGitWritesContext } from '../src/components/git/gitPanelWrites'

for (const outcome of ['success', 'partial', 'failure', 'refresh failure', 'denied'] as const) test(`bulk discard: ${outcome}`, async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container)
  let state = { id: `bulk-${outcome}`, snapshot: 's0', files: ['a.ts', 'b.ts', 'c.ts', 'untouched.ts'].map(path => ({ path, old_path: null, index_status: ' ', worktree_status: 'M', staged: false, untracked: path === 'b.ts', conflict: false, submodule: false })) } as GitStatus
  const contents = new Map(state.files.map(f => [f.path, 'modified']))
  const calls: unknown[][] = []
  let refreshes = 0, release!: () => void
  const api = { ...gitApi, discard: async (...args: Parameters<typeof gitApi.discard>) => {
    calls.push(args)
    if (calls.length === 1) await new Promise<void>(resolve => { release = resolve })
    if (outcome === 'failure' || (outcome === 'partial' && args[1] === 'b.ts')) throw new Error('permission denied')
    assert.equal(args[2], state.snapshot)
    contents.set(args[1], 'restored')
    state = { ...state, snapshot: `s${calls.length}`, files: state.files.filter(f => f.path !== args[1]) }
    return state
  } }
  function Harness() {
    const [status, setStatus] = useState(state)
    return <GitApiContext.Provider value={{ api, readOnly: false, shared: false, allowedActions: outcome === 'denied' ? ['commit'] : undefined, browseWorkspace: async () => { throw new Error('unused') } }}><GitChanges status={status} onDiff={() => {}} onRefresh={async () => { refreshes++; setStatus(state); if (outcome === 'refresh failure') throw new Error('refresh failed') }} /></GitApiContext.Provider>
  }
  const button = (text: string) => {
    const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text)
    assert.ok(found, container.textContent || '')
    return found
  }
  const check = (path: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${path}"]`)!
  try {
    await act(async () => root.render(<I18nProvider><PanelGitWritesContext.Provider value={createPanelGitWrites()}><Harness /></PanelGitWritesContext.Provider></I18nProvider>))
    if (outcome === 'denied') {
      assert.equal([...container.querySelectorAll('button')].some(b => b.textContent === '批量撤销文件修改'), false)
      return
    }
    const bulk = button('批量撤销文件修改')
    assert.equal(bulk.previousElementSibling?.textContent, '清空选择')
    await act(async () => button('清空选择').click())
    assert.equal(bulk.disabled, true)
    await act(async () => { check('a.ts').click(); check('b.ts').click(); check('c.ts').click() })
    await act(async () => bulk.click())
    assert.match(container.querySelector('[role="dialog"]')?.textContent || '', /3.*未提交.*删除/)
    await act(async () => container.querySelector<HTMLButtonElement>('.confirm-dialog-footer button')!.click())
    assert.equal(calls.length, 0)
    assert.deepEqual([...contents.values()], ['modified', 'modified', 'modified', 'modified'])
    assert.equal(check('a.ts').checked && check('b.ts').checked && check('c.ts').checked, true)
    await act(async () => bulk.click())
    const confirm = container.querySelector<HTMLButtonElement>('.confirm-dialog-confirm')!
    await act(async () => { confirm.click(); confirm.click() })
    assert.equal(calls.length, 1)
    assert.equal(confirm.disabled, true)
    assert.equal(container.querySelector<HTMLFieldSetElement>('fieldset')!.disabled, true)
    await act(async () => release())
    const successful = outcome === 'success' || outcome === 'refresh failure'
    assert.deepEqual(calls.map(c => c[1]), successful ? ['a.ts', 'b.ts', 'c.ts'] : outcome === 'partial' ? ['a.ts', 'b.ts'] : ['a.ts'])
    assert.equal(contents.get('untouched.ts'), 'modified')
    assert.equal(check('untouched.ts').checked, false)
    assert.equal(refreshes, 1)
    assert.equal(container.querySelector('[role="dialog"]') === null, true)
    assert.equal(container.querySelectorAll('input[type="checkbox"]').length, successful ? 1 : outcome === 'partial' ? 3 : 4)
    if (!successful) {
      assert.match(container.textContent || '', /permission denied/)
      assert.match(container.textContent || '', /未执行.*c.ts/s)
      assert.equal(check('b.ts').checked, true)
    }
    if (outcome === 'refresh failure') assert.match(container.textContent || '', /refresh failed/)
    if (successful) assert.equal(bulk.disabled, true)
  } finally { await act(async () => root.unmount()); container.remove(); await window.happyDOM.close() }
})


test('select all excludes conflicts and submodules; single discard keeps its scope', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container)
  const state = { id: 'bulk-ineligible', snapshot: 'review', files: ['tracked', 'new', 'conflict', 'submodule'].map(path => ({ path, old_path: null, index_status: ' ', worktree_status: 'M', staged: false, untracked: path === 'new', conflict: path === 'conflict', submodule: path === 'submodule' })) } as GitStatus
  const calls: unknown[][] = []
  let refreshes = 0
  const api = { ...gitApi, discard: async (...args: Parameters<typeof gitApi.discard>) => { calls.push(args); return { ...state, snapshot: 'next', files: state.files.filter(f => f.path !== args[1]) } } }
  try {
    await act(async () => root.render(<I18nProvider><GitApiContext.Provider value={{ api, shared: false, readOnly: false, browseWorkspace: async () => { throw new Error('unused') } }}><GitChanges status={state} onRefresh={async () => { refreshes++ }} onDiff={() => {}} /></GitApiContext.Provider></I18nProvider>))
    const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === label)!
    await act(async () => button('全选').click())
    assert.deepEqual([...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map(c => [c.getAttribute('aria-label'), c.checked, c.disabled]), [['tracked', true, false], ['new', true, false], ['conflict', false, true], ['submodule', false, true]])
    await act(async () => button('批量撤销文件修改').click())
    assert.match(container.querySelector('[role="dialog"]')?.textContent || '', /2 个文件/)
    await act(async () => container.querySelector<HTMLButtonElement>('.confirm-dialog-footer button')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="撤销修改 new"]')!.click())
    assert.match(container.querySelector('[role="dialog"]')?.textContent || '', /new/)
    await act(async () => container.querySelector<HTMLButtonElement>('.confirm-dialog-confirm')!.click())
    assert.deepEqual(calls, [['bulk-ineligible', 'new', 'review']])
    assert.equal(refreshes, 1)
    assert.equal(container.querySelector<HTMLInputElement>('input[aria-label="tracked"]')!.checked, true)
    assert.equal(container.querySelector('[role="dialog"]') === null, true)
    assert.match(container.textContent || '', /已撤销：new/)
  } finally { await act(async () => root.unmount()); container.remove(); await window.happyDOM.close() }
})

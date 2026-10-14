import { installDomEnvironment } from './helpers/domEnv.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import FileContextMenu from '../src/components/FileContextMenu'
import { I18nProvider } from '../src/i18n'
import { MarkdownAssetUrlProvider } from '../src/contexts/MarkdownAssetUrlContext'

const target = { path: 'src/file.ts', name: 'file.ts', x: 100, y: 100 }

test('desktop open-with, reveal and save send the complete file path, and unavailable apps are excluded', async () => {
  const { window } = installDomEnvironment()
  const calls: unknown[] = []
  window.workstepDesktop = {
    notify: () => {},
    directories: { open: async () => ({ opened: true, path: '' }), openers: async () => ({ openers: [
      { id: 'vscode', label: 'VS Code', available: true },
      { id: 'sublime', label: 'Sublime Text', available: false },
      { id: 'file_manager', label: 'Finder', available: true },
    ] }) },
    files: { action: async (...args) => { calls.push(args); return {} } },
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let dismisses = 0
  const dismiss = () => { dismisses++ }
  const render = (x = 100) => root.render(<I18nProvider><FileContextMenu target={{ ...target, x }} projectId="p"
    projectRoot="/project" localProject onDismiss={dismiss} /></I18nProvider>)
  const click = async (label: string) => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent === label)
    assert.ok(button, label)
    await act(async () => button.click())
  }
  try {
    await act(async () => render())
    await click('在 VS Code 中打开')
    assert.deepEqual(calls[0], ['/project/src/file.ts', 'open', 'vscode'])
    await click('打开方式 ›')
    assert.doesNotMatch(document.body.textContent!, /Sublime/)
    await click('默认应用')
    assert.deepEqual(calls[1], ['/project/src/file.ts', 'open', 'default'])
    await click('在 Finder 中显示')
    assert.deepEqual(calls[2], ['/project/src/file.ts', 'reveal', undefined])
    await click('另存为…')
    assert.deepEqual(calls[3], ['/project/src/file.ts', 'save', undefined])
    assert.equal(dismisses, 4)
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})

test('shared files copy complete raw content through the share resolver and show read errors', async () => {
  const { window } = installDomEnvironment()
  window.history.replaceState({}, '', '/share/token')
  const copied: string[] = [], fetched: string[] = []
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text) } } })
  const originalFetch = globalThis.fetch
  let fail = false
  globalThis.fetch = (async (url: string) => {
    fetched.push(url)
    return { ok: !fail, status: fail ? 403 : 200, text: async () => 'complete file contents', headers: new Headers() }
  }) as typeof fetch
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let dismisses = 0
  const dismiss = () => { dismisses++ }
  const preview = { load: async () => ({ type: 'text' as const, content: 'truncated preview', content_type: 'text/plain', file_size: 100 }),
    rawUrl: (path: string) => `/api/share/token/files/raw?path=${encodeURIComponent(path)}` }
  try {
    await act(async () => root.render(<I18nProvider><MarkdownAssetUrlProvider filePreview={preview}>
      <FileContextMenu target={target} onDismiss={dismiss} />
    </MarkdownAssetUrlProvider></I18nProvider>))
    assert.doesNotMatch(document.body.textContent!, /打开方式|VS Code|Finder/)
    const button = [...document.querySelectorAll('button')].find(item => item.textContent === '复制文件内容')!
    await act(async () => button.click())
    assert.deepEqual(copied, ['complete file contents'])
    assert.deepEqual(fetched, ['/api/share/token/files/raw?path=src%2Ffile.ts'])
    assert.equal(dismisses, 1)
    fail = true
    await act(async () => button.click())
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /403/)
    assert.equal(dismisses, 1)
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

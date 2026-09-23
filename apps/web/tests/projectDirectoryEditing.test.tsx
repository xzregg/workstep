import './helpers/domEnv.ts'

import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import ProjectDirectoryBrowser from '../src/components/ProjectDirectoryBrowser.tsx'
import ProjectDirectoryBrowserDialog from '../src/components/ProjectDirectoryBrowserDialog.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'
import { installDomEnvironment } from './helpers/domEnv.ts'

const json = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'Content-Type': 'application/json' },
})

test('directory context menu creates, renames and deletes a file; edit mode saves its text', async () => {
  const { window, document } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  const files = new Map<string, string>()
  const mutations: Array<{ url: string; body: Record<string, string> }> = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {}
    const bodyPath = body.path?.startsWith('/') ? body.path : `/srv/demo/${body.path}`
    if (url.includes('/fs/browse')) {
      return json({
        path: '/srv/demo', relative_path: '', name: 'demo', parent: null, parent_relative_path: null,
        entries: [...files.keys()].map((path) => ({
          name: path.split('/').pop(), type: 'file', path, relative_path: path.split('/').pop(),
        })),
      })
    }
    if (url.includes('/fs/preview')) {
      const path = new URL(url, 'http://localhost').searchParams.get('path') || ''
      return json({ type: 'text', content_type: 'text/plain', content: files.get(path) || '', file_size: 0, extension: '.txt' })
    }
    mutations.push({ url, body })
    if (url.endsWith('/fs/entry') && init?.method === 'POST') files.set(`/srv/demo/${body.name}`, '')
    if (url.endsWith('/fs/entry') && init?.method === 'PATCH') {
      files.set(`/srv/demo/${body.name}`, files.get(bodyPath) || '')
      files.delete(bodyPath)
    }
    if (url.endsWith('/fs/entry') && init?.method === 'DELETE') files.delete(bodyPath)
    if (url.endsWith('/fs/content')) files.set(bodyPath, body.content)
    return json({ path: `/srv/demo/${body.name || ''}`, saved: true, deleted: true })
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const flush = async () => { await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) }) }
  const click = async (element: Element | null) => {
    assert.ok(element)
    await act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    await flush()
  }
  const setInput = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set
      setter?.call(element, value)
      element.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
  }
  const contextMenu = async (path: string) => {
    const entry = document.querySelector<HTMLElement>(`[title="${path}"]`)
    assert.ok(entry)
    await act(async () => entry.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 })))
  }
  const menuItem = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    .find((item) => item.textContent === text) || null
  const confirm = () => document.querySelector<HTMLButtonElement>('[role="dialog"] .btn-primary, [role="dialog"] .btn-danger')

  try {
    await act(async () => root.render(<I18nProvider><ProjectDirectoryBrowser projectId="remote:one" /></I18nProvider>))
    await flush()

    await contextMenu('/srv/demo')
    await click(menuItem('New file'))
    const nameInput = document.querySelector<HTMLInputElement>('.project-directory-action-field input')
    assert.ok(nameInput)
    await setInput(nameInput, 'note.txt')
    await click(confirm())
    assert.ok(document.querySelector('[title="/srv/demo/note.txt"]'))
    assert.equal(mutations[0].body.project_id, 'remote:one')

    await click(document.querySelector('[title="/srv/demo/note.txt"]'))
    const editButton = document.querySelector<HTMLButtonElement>('.project-directory-preview [aria-label="Edit mode"]')
    const downloadButton = document.querySelector('.project-directory-preview .artifact-download-button')
    assert.ok(editButton)
    assert.equal(downloadButton?.previousElementSibling, editButton)
    assert.equal(editButton.style.justifyContent, 'center')
    await click(editButton)
    const editor = document.querySelector<HTMLTextAreaElement>('.project-directory-editor-textarea')
    assert.ok(editor)
    const headingActions = document.querySelector('.project-directory-editor-heading .project-directory-editor-actions')
    assert.ok(headingActions)
    assert.equal(headingActions.querySelectorAll('button').length, 2)
    await setInput(editor, 'changed')
    await click(Array.from(document.querySelectorAll('.project-directory-editor-heading button'))
      .find((button) => button.textContent === 'Show preview') || null)
    assert.ok(document.querySelector('[role="dialog"][aria-label="Unsaved changes"]'))
    await click(Array.from(document.querySelectorAll('[role="dialog"] button'))
      .find((button) => button.textContent === 'Cancel') || null)
    assert.equal(document.querySelector<HTMLTextAreaElement>('.project-directory-editor-textarea')?.value, 'changed')
    await click(Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Save') || null)
    assert.equal(files.get('/srv/demo/note.txt'), 'changed')
    assert.equal(mutations.find((item) => item.url.endsWith('/fs/content'))?.body.expected_content, '')

    await contextMenu('/srv/demo/note.txt')
    assert.ok(menuItem('Show preview'))
    await click(menuItem('Rename'))
    const renameInput = document.querySelector<HTMLInputElement>('.project-directory-action-field input')
    assert.ok(renameInput)
    await setInput(renameInput, 'renamed.txt')
    await click(confirm())
    assert.ok(document.querySelector('[title="/srv/demo/renamed.txt"]'))

    await contextMenu('/srv/demo/renamed.txt')
    await click(menuItem('Delete'))
    await click(confirm())
    assert.equal(files.size, 0)
    assert.equal(document.querySelector('[title="/srv/demo/renamed.txt"]'), null)
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})

test('code files open a highlighted code editor and save their content', async () => {
  const { window, document } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  let savedContent = ''
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.includes('/fs/preview')) {
      return json({ type: 'text', content_type: 'text/typescript', content: 'const value = 1', file_size: 15, extension: '.ts' })
    }
    if (url.endsWith('/fs/content')) {
      savedContent = (JSON.parse(String(init?.body)) as { content: string }).content
      return json({ saved: true })
    }
    return json({
      path: '/srv/demo', name: 'demo', relative_path: '', parent: null, parent_relative_path: null,
      entries: [{ name: 'index.ts', type: 'file', path: '/srv/demo/index.ts', relative_path: 'index.ts' }],
    })
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider><ProjectDirectoryBrowser projectId="remote:one" /></I18nProvider>))
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })
    await act(async () => document.querySelector<HTMLElement>('[title="/srv/demo/index.ts"]')?.click())
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })
    await act(async () => document.querySelector<HTMLButtonElement>('.project-directory-preview [aria-label="Edit mode"]')?.click())
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })
    const codeEditor = document.querySelector<HTMLElement>('.project-directory-editor .git-source-editor.is-editable')
    assert.ok(codeEditor)
    assert.equal(codeEditor.dataset.language, 'typescript')
    assert.ok(codeEditor.querySelector('.code-preview-line-number'))
    assert.equal(codeEditor.style.getPropertyValue('--code-line-digits'), '1ch')
    const input = codeEditor.querySelector<HTMLTextAreaElement>('textarea')
    assert.ok(input)
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set?.call(input, `${'// line\n'.repeat(99)}const value = 2`)
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.equal(codeEditor.style.getPropertyValue('--code-line-digits'), '3ch')
    await act(async () => document.querySelector<HTMLButtonElement>('.project-directory-editor-heading .btn-primary')?.click())
    assert.equal(savedContent, `${'// line\n'.repeat(99)}const value = 2`)
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})

test('closing the directory dialog asks before discarding an unsaved edit', async () => {
  const { window, document } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    if (String(input).includes('/fs/preview')) {
      return json({ type: 'text', content_type: 'text/plain', content: 'original', file_size: 8, extension: '.txt' })
    }
    return json({
      path: '/srv/demo', name: 'demo', relative_path: '', parent: null, parent_relative_path: null,
      entries: [{ name: 'note.txt', type: 'file', path: '/srv/demo/note.txt', relative_path: 'note.txt' }],
    })
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  let closed = false
  const click = async (element: Element | null) => {
    assert.ok(element)
    await act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
  }
  try {
    await act(async () => root.render(
      <I18nProvider>
        <ProjectDirectoryBrowserDialog projectId="remote:one" title="Files" onClose={() => { closed = true }} />
      </I18nProvider>,
    ))
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })
    await click(document.querySelector('[title="/srv/demo/note.txt"]'))
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })
    await click(document.querySelector('.project-directory-preview [aria-label="Edit mode"]'))
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })
    const editor = document.querySelector<HTMLTextAreaElement>('.project-directory-editor-textarea')
    assert.ok(editor)
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set?.call(editor, 'changed')
      editor.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await click(document.querySelector('.project-directory-dialog-header button[title="Close"]'))
    assert.equal(closed, false)
    assert.ok(document.querySelector('[role="dialog"][aria-label="Unsaved changes"]'))
    await click(Array.from(document.querySelectorAll('[role="dialog"] button'))
      .find((button) => button.textContent === 'Discard changes') || null)
    assert.equal(closed, true)
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})

test('directory dialog resizes from its edges and corners', async () => {
  const { window, document } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => json({
    path: '/srv/demo', name: 'demo', relative_path: '', parent: null, parent_relative_path: null, entries: [],
  })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(
      <I18nProvider><ProjectDirectoryBrowserDialog projectId="remote:one" title="Files" onClose={() => {}} /></I18nProvider>,
    ))
    const dialog = document.querySelector<HTMLElement>('.project-directory-dialog')
    assert.ok(dialog)
    const handles = dialog.querySelectorAll<HTMLElement>('.project-directory-dialog-resize-handle')
    assert.equal(handles.length, 8)
    const east = dialog.querySelector<HTMLElement>('.project-directory-dialog-resize-e')
    assert.ok(east)
    await act(async () => {
      east.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, clientX: 900, clientY: 300 }))
      window.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 860, clientY: 300 }))
      window.dispatchEvent(new window.PointerEvent('pointerup'))
    })
    assert.match(dialog.style.width, /px$/)
    const narrowerWidth = parseFloat(dialog.style.width)
    assert.ok(narrowerWidth < window.innerWidth * 0.9)

    const northwest = dialog.querySelector<HTMLElement>('.project-directory-dialog-resize-nw')
    assert.ok(northwest)
    await act(async () => northwest.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' })))
    assert.ok(parseFloat(dialog.style.width) < narrowerWidth)
    assert.ok(parseFloat(dialog.style.left) > window.innerWidth * 0.05)

    const left = parseFloat(dialog.style.left)
    const top = parseFloat(dialog.style.top)
    const header = dialog.querySelector<HTMLElement>('.project-directory-dialog-header')!
    await act(async () => {
      header.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, clientX: 200, clientY: 100 }))
      window.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 230, clientY: 120 }))
      window.dispatchEvent(new window.PointerEvent('pointerup'))
    })
    assert.equal(parseFloat(dialog.style.left), left + 30)
    assert.equal(parseFloat(dialog.style.top), top + 20)
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})

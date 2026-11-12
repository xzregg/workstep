import './helpers/domEnv.ts'

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import FilePreviewDialog from '../src/components/FilePreviewDialog.tsx'
import TaskArtifactPreviewDialog from '../src/components/TaskArtifactPreviewDialog.tsx'
import { I18nProvider, useLocaleStore } from '../src/i18n/index.tsx'
import { installDomEnvironment } from './helpers/domEnv.ts'

test('file preview resizes from edges and corners within the viewport', async () => {
  const { window, document } = installDomEnvironment()
  window.innerWidth = 1400
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    type: 'text', content_type: 'text/plain', content: 'preview', file_size: 7, extension: '.txt',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(
      <I18nProvider><FilePreviewDialog path="/demo.txt" name="demo.txt" projectId="demo" onClose={() => {}} /></I18nProvider>,
    ))
    const dialog = document.querySelector<HTMLElement>('.file-preview-dialog')
    assert.ok(dialog)
    assert.equal(dialog.querySelectorAll('.resizable-panel-handle').length, 8)

    const east = dialog.querySelector<HTMLElement>('.resizable-panel-e')
    assert.ok(east)
    await act(async () => {
      east.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, clientX: 1000, clientY: 400 }))
      window.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 1100, clientY: 400 }))
      window.dispatchEvent(new window.PointerEvent('pointerup'))
    })
    const narrowerWidth = parseFloat(dialog.style.width)
    assert.ok(narrowerWidth >= 520)
    assert.ok(narrowerWidth < window.innerWidth)

    const northwest = dialog.querySelector<HTMLElement>('.resizable-panel-nw')
    assert.ok(northwest)
    await act(async () => northwest.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' })))
    assert.ok(parseFloat(dialog.style.width) < narrowerWidth)
    assert.ok(parseFloat(dialog.style.left) > 0)

    await act(async () => {
      east.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, clientX: 800, clientY: 400 }))
      window.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 5000, clientY: 400 }))
      window.dispatchEvent(new window.PointerEvent('pointerup'))
    })
    assert.ok(parseFloat(dialog.style.left) + parseFloat(dialog.style.width) <= window.innerWidth)

    window.innerWidth = 1100
    await act(async () => window.dispatchEvent(new window.Event('resize')))
    assert.ok(parseFloat(dialog.style.left) + parseFloat(dialog.style.width) <= 1100)
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})


test('mobile file and task artifact dialogs share viewport height for all preview formats', async () => {
  const { window, document } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  const oldHistory = globalThis.history
  globalThis.history = window.history as unknown as History
  const styles = document.head.appendChild(document.createElement('style'))
  styles.textContent = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8') + readFileSync(new URL('../src/mobile.css', import.meta.url), 'utf8') + readFileSync(new URL('../src/components/TaskArtifactPreviewDialog.css', import.meta.url), 'utf8')
  document.documentElement.style.setProperty('--app-viewport-height', '800px')
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    for (const width of [320, 390, 1023]) {
      window.innerWidth = width
      await act(async () => window.dispatchEvent(new window.Event('resize')))
      for (const extension of ['.html', '.md', '.pdf', '.png', '.ts', '.txt', '.zip']) {
        for (const entry of ['file', 'task']) {
        globalThis.fetch = async () => Response.json({ type: extension === '.png' ? 'image' : extension === '.zip' ? 'binary' : 'text', content_type: extension === '.pdf' ? 'application/pdf' : extension === '.html' ? 'text/html' : extension === '.png' ? 'image/png' : 'text/plain', content: 'Preview', file_size: 7, extension })
        await act(async () => root.render(<I18nProvider>{entry === 'file' ? <FilePreviewDialog key={entry + width + extension} path={'/demo' + extension} name={'demo' + extension} projectId="demo" onClose={() => {}} /> : <TaskArtifactPreviewDialog key={entry + width + extension} artifact={{path: '/demo' + extension, name: 'demo' + extension, is_dir: false, step_key: 'step', round: 1, is_latest: true, is_selected: true, manifest_status: null, eligible_for_downstream: true, logical_name: null, artifact_type: null, relative_path: 'demo' + extension, size: 7}} projectId="demo" onClose={() => {}} />}</I18nProvider>))
        const dialog = document.querySelector<HTMLElement>(entry === 'file' ? '.file-preview-dialog' : '.task-artifact-preview-dialog')!
        assert.equal(window.getComputedStyle(dialog).height, 'calc(800px - 16px)', `${entry} ${width}px ${extension}`)
        assert.equal(dialog.querySelectorAll('.resizable-panel-handle').length, 0)
        if (extension === '.html') {
          assert.ok(dialog.querySelector('.artifact-html-preview'))
          assert.equal(window.getComputedStyle(dialog.querySelector('iframe')!).flex, '1 1 0%')
        }
        }
      }
    }
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    globalThis.history = oldHistory
    await window.happyDOM.close()
  }
})


for (const entry of ['file', 'task']) test(`${entry} preview hands its modal to the prototype editor and refreshes on return`, async () => {
  const { window, document } = installDomEnvironment()
  window.innerWidth = 1400
  const originalFetch = globalThis.fetch
  useLocaleStore.setState({locale:'zh-CN'})
  let reads = 0
  globalThis.fetch = async (input) => {
    const path = new URL(String(input), 'http://localhost').pathname
    if (path.includes('/prototype/')) return Response.json({detail:'simulated unavailable workspace'}, {status:500})
    reads++
    return Response.json({type:'text',content_type:'text/html',content:'<h1>Demo</h1>',extension:'.html',file_size:13})
  }
  let closed = 0
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider>{entry === 'file' ? <FilePreviewDialog path="/demo.html" name="demo.html" projectId="demo" onClose={() => {closed++}} /> : <TaskArtifactPreviewDialog artifact={{path:'/demo.html',name:'demo.html',is_dir:false,step_key:'step',round:1,is_latest:true,is_selected:true,manifest_status:null,eligible_for_downstream:true,logical_name:null,artifact_type:null,relative_path:'demo.html',size:13}} projectId="demo" onClose={() => {closed++}} />}</I18nProvider>))
    const edit = [...document.querySelectorAll('button')].find(button => button.textContent === '原型编辑')!
    assert.ok(edit)
    await act(async () => edit.click())
    assert.ok(document.querySelector('.prototype-editor'))
    assert.ok(!document.querySelector('.file-preview-backdrop, .task-artifact-preview-backdrop'), 'empty preview must not cover the editor')
    await act(async () => (document.querySelector('.prototype-backdrop') as HTMLElement).click())
    assert.ok(document.querySelector('.prototype-editor'), 'outside clicks must keep the editor open')
    assert.equal(closed, 0)
    const before = reads
    await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', {key:'Escape', bubbles:true})))
    assert.equal(closed, 0, 'Escape returns to preview without closing its owner')
    assert.equal(document.querySelector('.prototype-backdrop'), null)
    assert.ok(document.querySelector('.artifact-html-preview iframe'))
    assert.ok(reads > before, 'returning reloads the edited source')
    if (entry === 'file') {
      await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', {key:'Escape', bubbles:true})))
      assert.equal(closed, 1)
    }
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})

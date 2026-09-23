import './helpers/domEnv.ts'

import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import FilePreviewDialog from '../src/components/FilePreviewDialog.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'
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

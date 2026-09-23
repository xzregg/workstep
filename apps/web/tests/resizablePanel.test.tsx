import './helpers/domEnv.ts'

import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ResizablePanel from '../src/components/ResizablePanel.tsx'
import ImagePreview from '../src/components/ImagePreview.tsx'
import MermaidPreviewDialog from '../src/components/MermaidPreviewDialog.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'
import { installDomEnvironment } from './helpers/domEnv.ts'

test('desktop dialogs resize from every edge and stay in the viewport', async () => {
  const { window, document } = installDomEnvironment()
  window.innerWidth = 1400
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider>
      <div className="modal-overlay"><ResizablePanel className="modal" style={{ width: 900, height: 600 }} minWidth={520} minHeight={320}>Preview</ResizablePanel></div>
    </I18nProvider>))
    const panel = document.querySelector<HTMLElement>('.modal')
    assert.ok(panel)
    assert.equal(panel.querySelectorAll('.resizable-panel-handle').length, 8)
    const east = panel.querySelector<HTMLElement>('.resizable-panel-e')
    assert.ok(east)
    await act(async () => {
      east.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, clientX: 1100, clientY: 300 }))
      window.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 800, clientY: 300 }))
      window.dispatchEvent(new window.PointerEvent('pointerup'))
    })
    assert.ok(parseFloat(panel.style.width) >= 520)
    const width = parseFloat(panel.style.width)
    const northwest = panel.querySelector<HTMLElement>('.resizable-panel-nw')
    assert.ok(northwest)
    await act(async () => northwest.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' })))
    assert.ok(parseFloat(panel.style.width) < width)
    assert.ok(parseFloat(panel.style.left) > 0)
    window.innerWidth = 1100
    await act(async () => window.dispatchEvent(new window.Event('resize')))
    assert.ok(parseFloat(panel.style.left) + parseFloat(panel.style.width) <= 1100)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('image and diagram previews expose resize handles', async () => {
  const { window, document } = installDomEnvironment()
  window.innerWidth = 1400
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider><ImagePreview src="/sample.png" onClose={() => {}} /></I18nProvider>))
    const imagePanel = document.querySelector<HTMLElement>('.image-preview-window')
    assert.ok(imagePanel)
    assert.equal(imagePanel.querySelectorAll('.resizable-panel-handle').length, 8)
    const corner = imagePanel.querySelector<HTMLElement>('.resizable-panel-se')
    assert.ok(corner)
    await act(async () => {
      corner.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, clientX: 600, clientY: 400 }))
      window.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 700, clientY: 450 }))
      window.dispatchEvent(new window.PointerEvent('pointerup'))
    })
    assert.equal(imagePanel.getAttribute('data-resized'), 'true')
    const imageLeft = parseFloat(imagePanel.style.left)
    const imageGrip = imagePanel.querySelector<HTMLElement>('[data-dialog-drag-handle]')!
    await act(async () => {
      imageGrip.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, clientX: 500, clientY: 300 }))
      window.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 540, clientY: 300 }))
      window.dispatchEvent(new window.PointerEvent('pointerup'))
    })
    assert.equal(parseFloat(imagePanel.style.left), imageLeft + 40)
    await act(async () => root.render(<I18nProvider><MermaidPreviewDialog svg="<svg></svg>" onClose={() => {}} /></I18nProvider>))
    assert.equal(document.querySelectorAll('.mermaid-preview__viewport .resizable-panel-handle').length, 8)
    const diagramPanel = document.querySelector<HTMLElement>('.mermaid-preview__viewport')!
    await act(async () => diagramPanel.querySelector<HTMLElement>('[data-dialog-drag-handle]')!
      .dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' })))
    assert.match(diagramPanel.style.left, /px$/)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('dialog title moves the panel without dragging its buttons or leaving the viewport', async () => {
  const { window, document } = installDomEnvironment()
  window.innerWidth = 1400
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider>
      <ResizablePanel style={{ width: 900, height: 600 }}>
        <div className="modal-header"><strong>Settings</strong><button type="button">Close</button></div>
      </ResizablePanel>
    </I18nProvider>))
    const panel = document.querySelector<HTMLElement>('.resizable-panel')!
    const header = panel.querySelector<HTMLElement>('.modal-header')!
    await act(async () => {
      header.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, clientX: 300, clientY: 100 }))
      window.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 400, clientY: 140 }))
      window.dispatchEvent(new window.PointerEvent('pointerup'))
    })
    assert.equal(parseFloat(panel.style.left), 350)
    assert.equal(parseFloat(panel.style.top), 124)
    await act(async () => {
      panel.querySelector('button')!.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, clientX: 400, clientY: 140 }))
      window.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 600, clientY: 340 }))
      window.dispatchEvent(new window.PointerEvent('pointerup'))
    })
    assert.equal(parseFloat(panel.style.left), 350)
    await act(async () => {
      header.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, clientX: 400, clientY: 140 }))
      window.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 5000, clientY: 5000 }))
      window.dispatchEvent(new window.PointerEvent('pointerup'))
    })
    assert.equal(parseFloat(panel.style.left), 500)
    assert.equal(parseFloat(panel.style.top), 168)

    await act(async () => root.render(<I18nProvider>
      <ResizablePanel style={{ width: 900, height: 600 }}>
        <div className="schedule-page"><div className="schedule-header"><strong>Schedules</strong><button type="button">New</button></div></div>
      </ResizablePanel>
    </I18nProvider>))
    const schedulePanel = document.querySelector<HTMLElement>('.resizable-panel')!
    const scheduleHeader = schedulePanel.querySelector<HTMLElement>('.schedule-header')!
    const scheduleLeft = parseFloat(schedulePanel.style.left)
    await act(async () => {
      scheduleHeader.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, clientX: 300, clientY: 100 }))
      window.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 280, clientY: 100 }))
      window.dispatchEvent(new window.PointerEvent('pointerup'))
    })
    assert.equal(parseFloat(schedulePanel.style.left), scheduleLeft - 20)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

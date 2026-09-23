import './helpers/domEnv.ts'

import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { TaskArtifact } from '../src/api/client.ts'
import TaskArtifactPreviewDialog from '../src/components/TaskArtifactPreviewDialog.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'
import { installDomEnvironment } from './helpers/domEnv.ts'

const artifact: TaskArtifact = {
  step_key: 'review', round: 1, is_latest: true, is_selected: true,
  manifest_status: null, eligible_for_downstream: true, name: 'report.txt',
  logical_name: 'Report', artifact_type: 'file', path: '/demo/report.txt',
  relative_path: 'report.txt', size: 6,
}

test('task input and output file preview resizes while keeping its content', async () => {
  const { window, document } = installDomEnvironment()
  window.innerWidth = 1400
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    type: 'text', content_type: 'text/plain', content: 'report', file_size: 6, extension: '.txt',
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider><TaskArtifactPreviewDialog artifact={artifact} projectId="demo" onClose={() => {}} /></I18nProvider>))
    const panel = document.querySelector<HTMLElement>('[role="dialog"] .resizable-panel')
    assert.ok(panel)
    assert.equal(panel.querySelectorAll('.resizable-panel-handle').length, 8)
    const east = panel.querySelector<HTMLElement>('.resizable-panel-e')
    assert.ok(east)
    await act(async () => {
      east.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, clientX: 1100, clientY: 300 }))
      window.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 850, clientY: 300 }))
      window.dispatchEvent(new window.PointerEvent('pointerup'))
    })
    assert.ok(parseFloat(panel.style.width) >= 520)
    assert.ok(panel.textContent?.includes('Report'))
    assert.ok(panel.textContent?.includes('report'))
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})

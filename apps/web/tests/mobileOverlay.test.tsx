import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import MobileSheet from '../src/components/MobileSheet'
import { I18nProvider } from '../src/i18n'

test('Back closes only the top sheet and a dirty editor can keep its draft', async () => {
  const window = new Window({ width: 390, url: 'http://localhost/tasks?task=one' })
  Object.assign(globalThis, { window, document: window.document, history: window.history, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  function Surface() {
    const [open, setOpen] = useState(true)
    const [confirm, setConfirm] = useState(false)
    return <MobileSheet open={open} title="编辑任务" onClose={() => setConfirm(true)}>
      <input defaultValue="保留这个草稿" />
      <MobileSheet open={confirm} title="放弃修改？" onClose={() => setConfirm(false)}>
        <button onClick={() => { setConfirm(false); setOpen(false) }}>放弃</button>
      </MobileSheet>
    </MobileSheet>
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  await act(async () => root.render(<I18nProvider><Surface /></I18nProvider>))
  await act(async () => { history.back(); await new Promise(resolve => setTimeout(resolve, 20)) })
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 2)
  await act(async () => { history.back(); await new Promise(resolve => setTimeout(resolve, 20)) })
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1)
  assert.equal(document.querySelector('input')!.value, '保留这个草稿')
  assert.equal(window.location.search, '?task=one')
  await act(async () => root.unmount())
  await window.happyDOM.close()
})

import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import MobileTaskRow from '../src/components/MobileTaskRow'

test('mobile task long press opens actions without navigating; movement cancels and a tap opens', async () => {
  const { window } = installDomEnvironment()
  Object.assign(globalThis, { history: window.history })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  let opened = 0
  let archived = 0
  let deleted = 0
  const pointer = (type: string, x = 0) => new window.PointerEvent(type, { bubbles: true, pointerType: 'touch', button: 0, clientX: x })
  try {
    await act(async () => root.render(<I18nProvider><MobileTaskRow title="演示任务" status="paused" archived={false} canArchive canDelete onOpen={() => opened++} onArchive={() => archived++} onRestore={() => {}} onDelete={() => deleted++}>演示任务</MobileTaskRow></I18nProvider>))
    const row = document.querySelector<HTMLButtonElement>('.mobile-task-row')!
    await act(async () => { row.dispatchEvent(pointer('pointerdown')); await new Promise(resolve => setTimeout(resolve, 550)) })
    assert.ok(document.querySelector('[role="dialog"]'))
    await act(async () => { row.dispatchEvent(pointer('pointerup')); row.click() })
    assert.equal(opened, 0)
    const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('.mobile-task-menu button')]
    await act(async () => buttons().find(button => button.textContent?.includes('Archive'))!.click())
    assert.equal(archived, 1)
    assert.equal(document.querySelector('[role="dialog"]'), null)
    await act(async () => row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
    await act(async () => buttons().find(button => button.textContent?.includes('Delete'))!.click())
    assert.equal(deleted, 1)
    await act(async () => { row.dispatchEvent(pointer('pointerdown')); row.dispatchEvent(pointer('pointermove', 30)); await new Promise(resolve => setTimeout(resolve, 550)) })
    assert.equal(document.querySelector('[role="dialog"]'), null)
    await act(async () => { row.dispatchEvent(pointer('pointerdown')); row.dispatchEvent(pointer('pointerup')); row.click() })
    assert.equal(opened, 1)
    for (const cancel of ['pointerup', 'pointercancel', 'pointerout']) {
      await act(async () => { row.dispatchEvent(pointer('pointerdown')); row.dispatchEvent(pointer(cancel)); await new Promise(resolve => setTimeout(resolve, 550)) })
      assert.equal(document.querySelector('[role="dialog"]'), null)
    }
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('task menu respects archive state, permissions and running status', async () => {
  const { window } = installDomEnvironment()
  Object.assign(globalThis, { history: window.history })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  let restored = 0
  try {
    for (const scenario of [
      { status: 'paused', archived: true, canArchive: true, canDelete: false, expected: ['Restore to board'] },
      { status: 'running', archived: false, canArchive: true, canDelete: true, expected: [] },
      { status: 'paused', archived: false, canArchive: false, canDelete: false, expected: [] },
    ]) {
      await act(async () => root.render(<I18nProvider><MobileTaskRow key={JSON.stringify(scenario)} title="任务" {...scenario} onOpen={() => {}} onArchive={() => {}} onRestore={() => restored++} onDelete={() => {}}>任务</MobileTaskRow></I18nProvider>))
      await act(async () => document.querySelector('.mobile-task-row')!.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
      const actions = [...document.querySelectorAll<HTMLButtonElement>('.mobile-task-menu button')]
      assert.deepEqual(actions.map(button => button.textContent), scenario.expected)
      if (actions.length) await act(async () => actions[0].click())
    }
    assert.equal(restored, 1)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

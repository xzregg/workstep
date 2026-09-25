import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import SessionRowActions from '../src/components/SessionRowActions'
import { I18nProvider } from '../src/i18n'

test('touch time reveals archive, and a row click hides it again', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const archived: string[] = []
  let rowPointerDown = 0
  const session = { id: 'session-1', title: '讨论', created_at: '2026-09-25T00:00:00Z', updated_at: '2026-09-25T01:00:00Z' }
  try {
    await act(async () => root.render(<I18nProvider><div className="ws-row" onPointerDown={() => { rowPointerDown += 1 }}>
      <SessionRowActions session={session} hovered={false} now={Date.now()} onArchive={() => archived.push(session.id)} onMore={() => {}} />
    </div></I18nProvider>))
    const time = container.querySelector<HTMLButtonElement>('.ws-session-time-button')
    assert.ok(time)
    assert.equal(container.querySelector('.ws-more-btn'), null)
    await act(async () => time.click())
    const archive = container.querySelector<HTMLButtonElement>('.ws-more-btn')
    assert.ok(archive)
    assert.equal(container.querySelectorAll('.ws-more-btn').length, 1)
    assert.equal(container.querySelector('.ws-session-time-button'), null)
    await act(async () => archive.dispatchEvent(new window.Event('pointerdown', { bubbles: true })))
    assert.equal(rowPointerDown, 0, 'archive press must not start the row long-press menu')
    await act(async () => archive.click())
    assert.deepEqual(archived, ['session-1'])
    await act(async () => container.querySelector('.ws-row')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    assert.ok(container.querySelector('.ws-session-time-button'))
    assert.equal(container.querySelector('.ws-more-btn'), null)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('mouse hover exposes archive and more actions without replacing the time button state', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><SessionRowActions
      session={{ id: 'session-2', title: '讨论', created_at: '2026-09-25T00:00:00Z' }}
      hovered now={Date.now()} onArchive={() => {}} onMore={() => {}}
    /></I18nProvider>))
    assert.equal(container.querySelectorAll('.ws-more-btn').length, 2)
    assert.equal(container.querySelector('.ws-session-time-button'), null)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

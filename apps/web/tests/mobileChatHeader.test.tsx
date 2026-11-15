import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import MobileHeaderActions, { MobileHeaderActionsProvider, MobileHeaderActionsSlot } from '../src/components/MobileHeaderActions'

test('header handoff renders one action set and ignores the previous owner cleanup', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const previous = <MobileHeaderActions key="old"><button>previous</button></MobileHeaderActions>
  const next = <MobileHeaderActions key="next"><button>current</button></MobileHeaderActions>
  const render = (old: boolean, current: boolean) => root.render(<MobileHeaderActionsProvider>
    <div className="mobile-header-session-actions"><MobileHeaderActionsSlot /></div>
    {old && previous}{current && next}
  </MobileHeaderActionsProvider>)
  try {
    await act(async () => render(true, false))
    assert.equal(document.querySelector('.mobile-header-session-actions')!.textContent, 'previous')
    await act(async () => render(true, true))
    assert.equal(document.querySelectorAll('button').length, 1, 'overlapping publishers never duplicate controls')
    assert.equal(document.querySelector('button')!.textContent, 'current')
    await act(async () => render(false, true))
    assert.equal(document.querySelector('button')!.textContent, 'current', 'stale cleanup cannot clear the current controls')
    await act(async () => render(false, false))
    assert.equal(document.querySelectorAll('button').length, 0)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import { speechApi } from '../src/api/speech'
import { useSpeechEnabled } from '../src/hooks/useSpeechEnabled'

test('speech availability ignores window focus and refreshes on foreground, reconnect and setting changes', async () => {
  const { window } = installDomEnvironment()
  const original = speechApi.status
  let calls = 0, enabled = true, hidden = false
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' })
  speechApi.status = async () => { calls++; return { enabled } as Awaited<ReturnType<typeof speechApi.status>> }
  function Harness() { return <output>{String(useSpeechEnabled('project', true))}</output> }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<Harness />))
    assert.equal(calls, 1)
    assert.equal(container.textContent, 'true')
    await act(async () => {
      for (let i = 0; i < 3; i++) window.dispatchEvent(new window.Event('focus'))
    })
    assert.equal(calls, 1)
    hidden = true
    await act(async () => document.dispatchEvent(new window.Event('visibilitychange')))
    assert.equal(calls, 1)
    hidden = false; enabled = false
    await act(async () => document.dispatchEvent(new window.Event('visibilitychange')))
    assert.equal(calls, 2)
    assert.equal(container.textContent, 'false')
    enabled = true
    await act(async () => window.dispatchEvent(new window.Event('workstep:reconnected')))
    assert.equal(calls, 3)
    assert.equal(container.textContent, 'true')
    await act(async () => window.dispatchEvent(new window.Event('workstep:speech-settings-changed')))
    assert.equal(calls, 4)
    await act(async () => root.unmount())
    await act(async () => document.dispatchEvent(new window.Event('visibilitychange')))
    assert.equal(calls, 4)
  } finally {
    await act(async () => root.unmount())
    speechApi.status = original
    await window.happyDOM.close()
  }
})

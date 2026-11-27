import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import test from 'node:test'

import WebRtcP2pSettings from '../src/components/webrtc/WebRtcP2pSettings'
import { I18nProvider } from '../src/i18n'

test('WebRtcP2pSettings loads, toggles pair key visibility, validates URL, saves, and rotates with confirmation', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL('http://127.0.0.1:8765/')
  let stored = {
    enabled: false,
    signal_url: '',
    device_id: 'dev-local-1',
    device_name: 'My Mac',
    pair_key: 'initial-pair-secret',
    p2p_url: '',
    online: false,
    active_peers: 0,
    direct_only: true,
    last_error: '',
  }
  const calls: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init?.method || 'GET').toUpperCase()
    calls.push(`${method} ${url}`)
    if (url.endsWith('/api/webrtc-p2p/settings') && method === 'GET') {
      return new Response(JSON.stringify(stored), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.endsWith('/api/webrtc-p2p/settings') && method === 'PUT') {
      const body = JSON.parse(String(init?.body || '{}'))
      stored = {
        ...stored,
        enabled: body.enabled,
        signal_url: body.signal_url,
        p2p_url: body.signal_url ? `${body.signal_url}/p2p/${stored.device_id}/` : '',
      }
      return new Response(JSON.stringify(stored), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (url.endsWith('/api/webrtc-p2p/rotate-key') && method === 'POST') {
      stored = { ...stored, pair_key: 'rotated-pair-secret' }
      return new Response(JSON.stringify(stored), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch

  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => {
      root.render(<I18nProvider><WebRtcP2pSettings /></I18nProvider>)
    })
    await act(async () => { await Promise.resolve() })

    const keyInput = document.getElementById('webrtc-pair-key') as HTMLInputElement
    assert.equal(keyInput.type, 'password')
    assert.equal(keyInput.value, 'initial-pair-secret')

    // Reveal and hide pair key
    const toggleBtn = document.querySelector('[data-testid="webrtc-pair-key-toggle"]') as HTMLButtonElement
    await act(async () => { toggleBtn.click() })
    assert.equal(keyInput.type, 'text')
    await act(async () => { toggleBtn.click() })
    assert.equal(keyInput.type, 'password')

    // Enable and fill valid signaling URL
    const enabledBox = document.getElementById('webrtc-p2p-enabled') as HTMLInputElement
    const urlInput = document.getElementById('webrtc-signal-url') as HTMLInputElement
    const submitBtn = document.querySelector('[data-testid="webrtc-save-btn"]') as HTMLButtonElement

    await act(async () => {
      enabledBox.click()
    })
    // Empty URL when enabled disables save button
    assert.equal(submitBtn.disabled, true)

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(urlInput, 'https://signal.example.com:8780')
      urlInput.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.equal(submitBtn.disabled, false)

    await act(async () => {
      submitBtn.click()
    })
    assert.ok(calls.some((c) => c.startsWith('PUT ') && c.endsWith('/api/webrtc-p2p/settings')))
    const linkEl = document.querySelector('[data-testid="webrtc-p2p-url"]')
    assert.equal(linkEl?.textContent, 'https://signal.example.com:8780/p2p/dev-local-1/')

    // Rotate key requires ConfirmDialog confirmation
    const rotateBtn = document.querySelector('[data-testid="webrtc-rotate-btn"]') as HTMLButtonElement
    await act(async () => { rotateBtn.click() })
    assert.equal(Boolean(document.querySelector('.confirm-dialog-backdrop')), true)
    const confirmBtn = document.querySelector('.confirm-dialog-confirm') as HTMLButtonElement
    await act(async () => { confirmBtn.click() })
    assert.equal(keyInput.value, 'rotated-pair-secret')
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})

test('WebRtcP2pSettings disables edits when accessed from remote WebRTC or Gateway browser', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL('https://signal.example.com/p2p/dev-1/chat')
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response('{}', { status: 403 })) as typeof fetch

  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => {
      root.render(<I18nProvider><WebRtcP2pSettings /></I18nProvider>)
    })
    assert.equal(Boolean(document.querySelector('.webrtc-p2p-readonly')), true)
    assert.equal(document.getElementById('webrtc-signal-url') === null, true)
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})

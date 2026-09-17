import './helpers/domEnv.ts'

import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import SharedTaskView from '../src/pages/SharedTaskView.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'
import { installDomEnvironment } from './helpers/domEnv.ts'

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const task = {
  id: 'task-1',
  title: 'Shared interactive task',
  description: 'Task description',
  status: 'running',
  steps: [{ step_key: 'build', status: 'running' }],
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  workflow_definition: {
    steps: [
      { key: 'build', label: 'Build', engine: 'codex', inputs: [], outputs: [] },
    ],
  },
}

test('interactive task share window shows the task-detail message composer', async () => {
  const { window, document } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  const originalWebSocket = globalThis.WebSocket
  class FakeWebSocket {
    onopen: (() => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: (() => void) | null = null
    onclose: (() => void) | null = null
    readyState = 0
    close() {}
    send() {}
  }
  Object.assign(globalThis, { WebSocket: FakeWebSocket })
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/meta')) {
      return jsonResponse({ mode: 'interactive', title: 'Shared', password_required: false })
    }
    if (url.endsWith('/unlock')) return jsonResponse({ session_token: 'session-1' })
    if (url.endsWith('/task')) return jsonResponse(task)
    if (url.includes('/history?')) return jsonResponse({ messages: [], limit: 30000, offset: 0 })
    if (url.endsWith('/artifacts')) return jsonResponse({ artifacts: [] })
    if (url.endsWith('/reviews')) return jsonResponse({ reviews: [] })
    return jsonResponse({})
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')))

  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <MemoryRouter initialEntries={['/share/token-1']}>
            <Routes>
              <Route path="/share/:token" element={<SharedTaskView />} />
            </Routes>
          </MemoryRouter>
        </I18nProvider>,
      )
    })
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    const composer = document.querySelector<HTMLTextAreaElement>('textarea')
    assert.ok(composer, 'interactive share should expose the shared task-detail composer')
    assert.equal(composer.disabled, false)
    assert.match(
      composer.getAttribute('placeholder') ?? '',
      /输入|发送|type a message|insert message|stage execution/i,
    )
    assert.match(document.body.textContent ?? '', /build/i)
    assert.ok(
      document.body.textContent?.includes('Agent')
      || document.body.textContent?.includes('Coordinator'),
    )
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    globalThis.WebSocket = originalWebSocket
    await window.happyDOM.close()
  }
})

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
  workflow: {
    id: 'workflow-1',
    name: 'Workflow',
    steps: {
      nodes: [
        { key: 'build', title: 'Build', prompt: 'Build step prompt', engine: 'codex', inputs: [], outputs: [] },
      ],
      connections: [],
    },
  },
}

async function renderShare(mode: 'read_only' | 'interactive') {
  const { window, document } = installDomEnvironment()
  window.history.replaceState({}, "", "/share/token-1")
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
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/operation')) {
      const operation = JSON.parse(String(init?.body))
      const path = operation.path.split('?')[0]
      if (path === '/task/list') return jsonResponse({ tasks: [task] })
      if (path.endsWith('/step/build/config')) return jsonResponse({ editable: true, configured: { engine: 'codex', config: {} }, resolved: { engine: 'codex', config: {} }, available_engines: [] })
      if (path.endsWith('/coordinator-config')) return jsonResponse({ configured: { engine: 'codex', config: {} }, resolved: { engine: 'codex', config: {} }, available_engines: [] })
      if (path.endsWith('/actions')) return jsonResponse({ buttons: [], runs: [] })
      if (path.endsWith('/discussion-groups') || path === '/provider/list' || path === '/engine/list') return jsonResponse([])
      return jsonResponse({})
    }
    if (url.endsWith('/meta')) {
      return jsonResponse({ mode, title: 'Shared', password_required: false })
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

    const displayClone = document.body.cloneNode(true) as HTMLElement
    displayClone.querySelector('.task-detail-composer')?.remove()
    return {
      hasComposer: Boolean(document.querySelector<HTMLTextAreaElement>('.task-detail-composer textarea')),
      hasAnalysisTab: Array.from(document.querySelectorAll('[role="tab"]'))
        .some((tab) => /执行分析/.test(tab.textContent ?? '')),
      hasAttachment: Boolean(document.querySelector('.chat-input-attach')),
      fileInputCount: document.querySelectorAll('input[type="file"]').length,
      text: document.body.textContent ?? '',
      hasDescriptionEdit: Boolean(document.querySelector('[aria-label*="描述"], [aria-label*="description"]')),
      displayHtml: displayClone.innerHTML,
    }
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    globalThis.WebSocket = originalWebSocket
    await window.happyDOM.close()
  }
}

test('interactive task share window shows the task-detail message composer', async () => {
  const rendered = await renderShare('interactive')
  assert.equal(rendered.hasComposer, true)
  assert.equal(rendered.hasAttachment, true)
  assert.equal(rendered.fileInputCount, 2)
  assert.match(rendered.text, /build/i)
})

test('editable shares expose task operations while both modes retain task content', async () => {
  const interactive = await renderShare('interactive')
  const readOnly = await renderShare('read_only')

  assert.equal(interactive.hasComposer, true)
  assert.equal(readOnly.hasComposer, false)
  assert.equal(interactive.hasAnalysisTab, true)
  assert.equal(readOnly.hasAnalysisTab, true)
  assert.equal(interactive.hasDescriptionEdit, true)
  assert.equal(readOnly.hasDescriptionEdit, false)
  for (const label of ['Shared interactive task', 'Task description', 'build']) {
    assert.match(interactive.text, new RegExp(label, 'i'))
    assert.match(readOnly.text, new RegExp(label, 'i'))
  }
  assert.match(interactive.text, /Build step prompt/)
  assert.notEqual(interactive.displayHtml, readOnly.displayHtml)
})

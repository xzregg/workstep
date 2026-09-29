import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { SharedInteractionPanel } from '../src/SharedInteractionPanel'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://gateway.test/share/token',
})
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver,
  Event: dom.window.Event })
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

test('interactive share displays a pending tool permission and submits its selected option', async () => {
  const calls: Array<{ url: string; method: string; headers?: HeadersInit; body?: BodyInit | null }> = []
  let answered = false
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers, body: init?.body })
    if (url.endsWith('/interventions')) return Response.json({ interventions: answered ? [] : [{
      interaction_id: 'permission-1', step_key: 'build', request: {
        interaction_id: 'permission-1', method: 'session/request_permission',
        tool_call: { title: 'Run command', raw_input: { command: 'echo hello' } },
        options: [{ option_id: 'allow_once', name: '允许一次', kind: 'allow_once' },
          { option_id: 'reject_once', name: '拒绝', kind: 'reject_once' }],
      },
    }] })
    if (url.endsWith('/interventions/permission-1/respond')) {
      answered = true
      return Response.json({ delivered: true })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<SharedInteractionPanel base="/api/public/shares/token" csrf="csrf-1" />)
  await screen.findByText('Run command')
  assert.match(document.body.textContent ?? '', /echo hello/)
  fireEvent.change(screen.getByLabelText('是否允许这项操作？'), { target: { value: 'allow_once' } })
  fireEvent.click(screen.getByRole('button', { name: '提交回复' }))
  fireEvent.click(screen.getByRole('button', { name: '确认提交' }))
  await screen.findByText('暂无待处理的引擎交互。')
  const posted = calls.find(call => call.url.endsWith('/interventions/permission-1/respond'))
  assert.equal((posted?.headers as Record<string, string>)?.['X-Share-CSRF'], 'csrf-1')
  assert.equal(posted?.body, JSON.stringify({ data: {
    outcome: { outcome: 'selected', option_id: 'allow_once' },
  } }))
})

test('interactive share validates required elicitation fields', async () => {
  const calls: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/interventions')) return Response.json({ interventions: [{
      interaction_id: 'question-1', step_key: 'build', request: {
        interaction_id: 'question-1', method: 'elicitation/create', message: 'Choose environment',
        requested_schema: { type: 'object', required: ['environment'], properties: {
          environment: { type: 'string', title: 'Environment', enum: ['staging', 'production'] },
        } },
      },
    }] })
    if (url.endsWith('/interventions/question-1/respond')) return Response.json({ delivered: true })
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<SharedInteractionPanel base="/api/public/shares/token" csrf="csrf-1" />)
  await screen.findByText('Choose environment')
  assert.equal((screen.getByRole('button', { name: '提交回复' }) as HTMLButtonElement).disabled, true)
  fireEvent.change(screen.getByLabelText('Environment'), { target: { value: 'staging' } })
  assert.equal((screen.getByRole('button', { name: '提交回复' }) as HTMLButtonElement).disabled, false)
  assert.equal(calls.some(url => url.endsWith('/interventions/question-1/respond')), false)
})

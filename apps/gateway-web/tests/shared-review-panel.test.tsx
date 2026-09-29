import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { SharedReviewPanel } from '../src/SharedReviewPanel'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://gateway.test/share/token',
})
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver,
  Event: dom.window.Event })
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

test('interactive review shows its report and sends a confirmed scoped decision', async () => {
  const calls: Array<{ url: string; method: string; headers?: HeadersInit; body?: BodyInit | null }> = []
  let decided = false
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers, body: init?.body })
    if (url.endsWith('/reviews')) return Response.json({ reviews: decided ? [] : [{
      id: 'review-1', step_key: 'build', report: { summary: 'Check generated output' },
    }] })
    if (url.endsWith('/steps/build/review/approve')) {
      decided = true
      return Response.json({ decision: 'approve', resumed: true })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  let updates = 0
  render(<SharedReviewPanel base="/api/public/shares/token" csrf="csrf-1"
    onUpdated={async () => { updates++ }} />)
  await screen.findByText('Check generated output')
  fireEvent.change(screen.getByLabelText('审核备注'), { target: { value: 'Looks good' } })
  fireEvent.click(screen.getByRole('button', { name: '提交审核决定' }))
  const dialog = await screen.findByRole('dialog', { name: '确认审核决定' })
  assert.match(dialog.textContent ?? '', /build/)
  fireEvent.click(screen.getByRole('button', { name: '确认提交' }))
  await screen.findByText('暂无待处理的手工审核。')
  const posted = calls.find(call => call.url.endsWith('/steps/build/review/approve'))
  assert.equal(posted?.method, 'POST')
  assert.equal((posted?.headers as Record<string, string>)?.['X-Share-CSRF'], 'csrf-1')
  assert.equal(posted?.body, JSON.stringify({ review_run_id: 'review-1', comment: 'Looks good' }))
  assert.equal(updates, 1)
})

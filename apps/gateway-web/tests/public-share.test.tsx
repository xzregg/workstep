import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { PublicSharePage } from '../src/PublicSharePage'

const dom = new JSDOM('<html><body></body></html>', { url: 'http://localhost:8700/share/token' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, Event: dom.window.Event })
const { cleanup, render, screen } = await import('@testing-library/react')

test('portal share navigation reloads the canonical WorkStep entry', () => {
  let opened = 0
  try {
    render(<PublicSharePage openViewer={() => { opened++ }} />)
    assert.equal(opened, 1)
    assert.equal(screen.getByRole('status').textContent, '正在打开任务详情…')
  } finally { cleanup() }
})

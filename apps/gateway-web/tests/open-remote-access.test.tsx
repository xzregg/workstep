import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { openRemoteAccess } from '../src/openRemoteAccess'

for (const [origin, url, expected] of [
  ['http://127.0.0.1:8700', 'https://gateway.test/workspace/device/', 'http://127.0.0.1:8700/workspace/device/api/remote/redeem'],
  ['https://gateway.test', 'https://gateway.test/workspace/device/', 'https://gateway.test/workspace/device/api/remote/redeem'],
  ['https://gateway.test', 'https://d-device.gateway.test/', 'https://d-device.gateway.test/api/remote/redeem'],
]) {
  test(`workspace access keeps its current gateway address: ${origin} ${url}`, () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: origin })
    Object.assign(globalThis, { window: dom.window, document: dom.window.document })
    let action = '', ticket = '', next = ''
    dom.window.HTMLFormElement.prototype.submit = function () {
      action = this.action
      ticket = (this.elements.namedItem('ticket') as HTMLInputElement).value
      next = (this.elements.namedItem('next') as HTMLInputElement).value
    }
    openRemoteAccess({ url, ticket: 'one-time-ticket', next: 'chat?session=keep' })
    assert.equal(action, expected)
    assert.equal(ticket, 'one-time-ticket')
    assert.equal(next, 'chat?session=keep')
    assert.equal(dom.window.document.querySelector('form'), null)
    dom.window.close()
  })
}

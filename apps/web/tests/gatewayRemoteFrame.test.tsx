import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToString } from 'react-dom/server'
import GatewayRemoteFrame from '../src/components/GatewayRemoteFrame'
import { I18nProvider } from '../src/i18n'

test('remote host keeps device context and return link above the workspace', () => {
  const existing = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { hostname: 'd-device-1.gateway.test', protocol: 'https:' } },
  })
  try {
    const html = renderToString(<I18nProvider><GatewayRemoteFrame>
      <div>workspace</div>
    </GatewayRemoteFrame></I18nProvider>)
    assert.match(html, /gateway-remote-banner/)
    assert.match(html, /https:\/\/gateway\.test\/devices/)
    assert.match(html, /workspace/)
  } finally {
    if (existing) Object.defineProperty(globalThis, 'window', existing)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

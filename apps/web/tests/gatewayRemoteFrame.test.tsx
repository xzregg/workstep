import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToString } from 'react-dom/server'
import GatewayRemoteFrame from '../src/components/GatewayRemoteFrame'
import ProjectConnectionDialog from '../src/components/ProjectConnectionDialog'
import { I18nProvider } from '../src/i18n'
import { gatewayRemotePortalUrl } from '../src/utils/gatewayRemote'

for (const [protocol, hostname, port, expected] of [
  ['http:', 'd-device-1.localhost', '8700', 'http://localhost:8700/devices'],
  ['http:', 'd-device-1.gateway.localhost', '8700', 'http://gateway.localhost:8700/devices'],
  ['https:', 'd-device-1.gateway.test', '8700', 'https://gateway.test:8700/devices'],
  ['http:', 'd-device-1.gateway.test', '8700', null],
] as const) {
  test(`remote return link respects ${protocol}//${hostname}:${port}`, () => {
    const existing = Object.getOwnPropertyDescriptor(globalThis, 'window')
    Object.defineProperty(globalThis, 'window', {
      configurable: true, value: { location: { protocol, hostname, port } },
    })
    try { assert.equal(gatewayRemotePortalUrl(), expected) }
    finally {
      if (existing) Object.defineProperty(globalThis, 'window', existing)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  })
}

test('remote host reserves a desktop Tab header while waiting for device context', () => {
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
    assert.doesNotMatch(html, />workspace</)
    assert.match(html, /gateway-remote-loading/)
    const projectDialog = renderToString(<I18nProvider><ProjectConnectionDialog
      open onClose={() => undefined} onConnected={() => undefined}
    /></I18nProvider>)
    assert.match(projectDialog, /本机目录与桌面应用操作仅在电脑本机可用/)
  } finally {
    if (existing) Object.defineProperty(globalThis, 'window', existing)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('embedded workspace hides duplicate gateway navigation', () => {
  const existing = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    parent: {}, frameElement: { getAttribute: () => 'true' },
    location: { hostname: 'd-device-1.gateway.test', protocol: 'https:' },
  } })
  try {
    const html = renderToString(<I18nProvider><GatewayRemoteFrame><div>workspace</div></GatewayRemoteFrame></I18nProvider>)
    assert.doesNotMatch(html, /gateway-remote-banner/)
    assert.doesNotMatch(html, /gateway-device-sidebar/)
    assert.match(html, /gateway-remote-loading/)
  } finally {
    if (existing) Object.defineProperty(globalThis, 'window', existing)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

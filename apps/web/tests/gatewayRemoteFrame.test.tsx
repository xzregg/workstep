import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToString } from 'react-dom/server'
import GatewayRemoteFrame from '../src/components/GatewayRemoteFrame'
import ProjectConnectionDialog from '../src/components/ProjectConnectionDialog'
import { I18nProvider } from '../src/i18n'
import { gatewayRemotePortalUrl } from '../src/utils/gatewayRemote'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useGatewaySessionStore } from '../src/stores/gatewaySessionStore'
import { useGatewayRecoveryStore } from '../src/stores/gatewayRecoveryStore'

test('failed gateway session polls stop after three retries and expose a dismissible manual recovery dialog', async (context) => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL('https://gateway.test/workspace/device/chat')
  const original = useGatewaySessionStore.getState()
  let requests = 0
  useGatewaySessionStore.setState({ session: null, loading: false, errorStatus: 503, load: async () => {
    requests++
    throw new Error('Unavailable')
  } })
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  context.mock.method(window, 'setTimeout', ((callback: () => void, delay: number) => setTimeout(callback, delay)) as unknown as typeof window.setTimeout)
  context.mock.method(window, 'clearTimeout', ((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer)) as unknown as typeof window.clearTimeout)
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider><GatewayRemoteFrame>workspace</GatewayRemoteFrame></I18nProvider>))
    for (let i = 0; i < 3; i++) await act(async () => context.mock.timers.tick(5000))
    assert.equal(requests, 4)
    assert.equal(useGatewayRecoveryStore.getState().paused, true)
    assert.ok(document.querySelector('.confirm-dialog-backdrop'), 'exhaustion must display the problem')
    await act(async () => (document.querySelector('.confirm-dialog-footer button') as HTMLButtonElement).click())
    assert.equal(document.querySelector('.confirm-dialog-backdrop'), null)
    assert.ok(document.querySelector('.gateway-connection-paused button'), 'manual retry remains after dismissal')
    await act(async () => {
      window.dispatchEvent(new window.Event('online'))
      window.dispatchEvent(new window.Event('workstep:resume'))
      context.mock.timers.tick(120000)
    })
    assert.equal(requests, 4)
    await act(async () => (document.querySelector('.gateway-connection-paused button') as HTMLButtonElement).click())
    assert.equal(requests, 5)
    assert.equal(useGatewayRecoveryStore.getState().paused, false)
  } finally {
    await act(async () => root.unmount())
    context.mock.timers.reset()
    useGatewaySessionStore.setState(original)
    useGatewayRecoveryStore.getState().retry()
    await window.happyDOM.close()
  }
})

for (const status of [401, 403]) test(`authorization failure ${status} still requires entry rather than automatic retries`, async (context) => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL('https://gateway.test/workspace/device/chat')
  const original = useGatewaySessionStore.getState()
  let requests = 0
  useGatewaySessionStore.setState({ session: null, loading: false, error: 'Authorization required', errorStatus: status, load: async () => {
    requests++
    throw new Error('Authorization required')
  } })
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider><GatewayRemoteFrame>workspace</GatewayRemoteFrame></I18nProvider>))
    await act(async () => context.mock.timers.tick(120000))
    assert.equal(requests, 1)
    assert.equal(useGatewayRecoveryStore.getState().paused, false)
    assert.equal(document.querySelector('.confirm-dialog-backdrop'), null)
    assert.ok(document.querySelector('.gateway-recovery-actions a'), 'gateway entry remains available')
  } finally {
    await act(async () => root.unmount())
    context.mock.timers.reset()
    useGatewaySessionStore.setState(original)
    useGatewayRecoveryStore.getState().retry()
    await window.happyDOM.close()
  }
})

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
    // SSR has not resolved the remote permission request yet; creation fields
    // must remain unavailable until the client finishes that check.
    assert.match(projectDialog, /aria-busy="true"/)
    assert.doesNotMatch(projectDialog, /id="project-path"/)
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

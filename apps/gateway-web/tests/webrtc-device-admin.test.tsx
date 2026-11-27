import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'
import { DeviceAdminPage } from '../src/DeviceAdminPage'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://gateway.test/admin/devices' })
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  MutationObserver: dom.window.MutationObserver,
  Event: dom.window.Event,
})
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })

const { cleanup, fireEvent, render, screen, within } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

test('DeviceAdminPage renders WebRTC registered devices table and details without affecting managed device actions', async () => {
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
    if (url.startsWith('/api/admin/devices?')) {
      return Response.json({
        devices: [
          {
            id: 'gw-dev-1',
            name: 'Office Mac',
            owner_name: 'Alice',
            status: 'active',
            online: true,
            connection_ip: '10.0.0.10',
            version: '1.0.0',
            app_instance_id: 'inst-1',
            webrtc_online: true,
            webrtc_p2p_path: '/p2p/rtc-bound-1/',
          },
        ],
        webrtc_devices: [
          {
            device_id: 'rtc-bound-1',
            name: 'Office Mac',
            online: true,
            connection_ip: '203.0.113.10',
            connected_at: 1732680000,
            active_sessions: 2,
            p2p_path: '/p2p/rtc-bound-1/',
            gateway_bound: true,
            bound_device_id: 'gw-dev-1',
            bound_device_name: 'Office Mac',
            bound_device_status: 'active',
            owner_user_id: 'u-alice',
            owner_name: 'Alice',
          },
          {
            device_id: 'rtc-signal-2',
            name: 'Home Linux',
            online: true,
            connection_ip: '198.51.100.8',
            connected_at: 1732680100,
            active_sessions: 0,
            p2p_path: '/p2p/rtc-signal-2/',
            gateway_bound: false,
          },
        ],
        total: 1,
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }

  render(<MemoryRouter><DeviceAdminPage /></MemoryRouter>)

  const section = await screen.findByRole('region', { name: 'WebRTC 直连设备' })
  assert.ok(await within(section).findByText('Home Linux'))
  assert.ok(within(section).getByText('203.0.113.10'))
  assert.ok(within(section).getByText('/p2p/rtc-signal-2/'))
  assert.ok(within(section).getByText('仅信令注册'))
  assert.ok(within(section).getByText('支持网关账号直连'))

  // Managed device row indicates WebRTC P2P online status too.
  assert.ok(screen.getByText('WebRTC P2P 在线'))

  // Details dialog displays binding & endpoint details.
  fireEvent.click(within(section).getByRole('button', { name: 'Home Linux · WebRTC 详情' }))
  const dialog = screen.getByRole('dialog', { name: 'Home Linux · WebRTC 详情' })
  assert.ok(within(dialog).getByText('rtc-signal-2'))
  assert.ok(within(dialog).getByText('仅信令配对'))
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭弹窗' }))
  assert.ok(screen.queryByRole('dialog') === null)
})

test('DeviceAdminPage shows quiet empty state when no WebRTC devices are online and clears stale rows on 403', async () => {
  let step = 0
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
    step += 1
    if (step === 1) {
      return Response.json({
        devices: [],
        webrtc_devices: [],
        total: 0,
      })
    }
    if (step === 2) {
      return Response.json({
        devices: [],
        webrtc_devices: [
          {
            device_id: 'rtc-temp',
            name: 'Temp Box',
            online: true,
            connection_ip: '192.0.2.5',
            active_sessions: 1,
            p2p_path: '/p2p/rtc-temp/',
            gateway_bound: false,
          },
        ],
        total: 0,
      })
    }
    return new Response(null, { status: 403 })
  }

  render(<MemoryRouter><DeviceAdminPage /></MemoryRouter>)
  await screen.findByText('当前没有在线的 WebRTC 注册设备。')
  const section = screen.getByRole('region', { name: 'WebRTC 直连设备' })
  assert.ok(section.querySelector('table') === null)

  fireEvent.click(screen.getByRole('button', { name: '刷新设备' }))
  await within(section).findByText('Temp Box')

  fireEvent.click(screen.getByRole('button', { name: '刷新设备' }))
  await screen.findByRole('alert')
  assert.ok(within(section).queryByText('Temp Box') === null)
})

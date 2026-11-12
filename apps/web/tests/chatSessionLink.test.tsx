import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import ChatSessionLinkButton from '../src/components/ChatSessionLinkButton'
import { useGatewayConnectionStore } from '../src/stores/gatewayConnectionStore'

for (const [page, connected, expected] of [
  ['http://localhost:8765/chat?project=old&session=old', false, 'http://localhost:8765/chat?project=demo&session=current'],
  ['http://localhost:8765/chat', true, 'https://gateway.example/workspace/device-1/chat?project=demo&session=current'],
  ['https://gateway.example/workspace/device-1/chat', false, 'https://gateway.example/workspace/device-1/chat?project=demo&session=current'],
  ['https://d-device-1.gateway.example/chat', false, 'https://d-device-1.gateway.example/chat?project=demo&session=current'],
] as const) test(`copy conversation link from ${page}, connected=${connected}`, async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL(page)
  useLocaleStore.setState({ locale: 'zh-CN', language: null })
  const previous = useGatewayConnectionStore.getState()
  useGatewayConnectionStore.setState({ status: { url: 'https://gateway.example', enabled: connected,
    authenticated: connected, online: connected, pending_device: false, package_locked: false, device_id: 'device-1' } })
  let copied = ''
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { copied = value } } })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider><ChatSessionLinkButton projectName="demo" sessionId="current" mobile /></I18nProvider>))
    const button = document.querySelector('button')!
    assert.match(button.className, /mobile-session-link/)
    assert.equal(button.textContent, '')
    await act(async () => button.click())
    assert.equal(copied, expected)
    assert.match(button.getAttribute('aria-label') || '', /已复制/)
  } finally {
    await act(async () => root.unmount())
    useGatewayConnectionStore.setState(previous)
    await window.happyDOM.close()
  }
})

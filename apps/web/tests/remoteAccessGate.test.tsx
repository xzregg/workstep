import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import RemoteAccessGate from '../src/components/RemoteAccessGate'

function renderGate(document: Document) {
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  return root
}

test('remote access gate blocks non-local visitors until the password is accepted', async () => {
  const { document, window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const originalFetch = globalThis.fetch
  const submitted: unknown[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/remote-project/access/status')) {
      return Response.json({ required: true, local: false, authorized: false })
    }
    if (url.endsWith('/remote-project/access/unlock')) {
      submitted.push(JSON.parse(String(init?.body)))
      return Response.json({ authorized: true })
    }
    return Response.json({})
  }
  const root = renderGate(document)
  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <RemoteAccessGate>
            <div id="app-body">应用内容</div>
          </RemoteAccessGate>
        </I18nProvider>,
      )
    })

    assert.equal(document.querySelector('#app-body'), null)
    assert.equal(document.querySelector('[role="dialog"]') !== null, true)
    const input = document.querySelector<HTMLInputElement>('input[type="password"]')!
    assert.ok(input)

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set
      assert.ok(setter)
      setter.call(input, 'letmein')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      document.querySelector<HTMLButtonElement>('.modal-footer button')!.click()
    })

    assert.deepEqual(submitted, [{ password: 'letmein' }])
    assert.equal(document.querySelector('#app-body')?.textContent, '应用内容')
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
  }
})

test('remote access gate passes through local or password-free installs', async () => {
  const { document } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    Response.json({ required: false, local: false, authorized: true })
  const root = renderGate(document)
  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <RemoteAccessGate>
            <div id="app-body">应用内容</div>
          </RemoteAccessGate>
        </I18nProvider>,
      )
    })
    assert.equal(document.querySelector('#app-body')?.textContent, '应用内容')
    assert.equal(document.querySelector('[role="dialog"]'), null)
  } finally {
    globalThis.fetch = originalFetch
    await act(async () => root.unmount())
  }
})

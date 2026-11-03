import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ChatInput from '../src/components/ChatInput'
import { I18nProvider } from '../src/i18n'

test('shared composer places model selection immediately before permission selection', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <ChatInput
            value=""
            onChange={() => {}}
            onSend={() => {}}
            config={{
              engines: [], engine: '', defaultEngine: '', model: '', fastModel: '',
              onEngineChange: () => {}, onModelChange: () => {}, onFastModelChange: () => {},
            }}
            permission={{ value: '', onChange: () => {} }}
          />
        </I18nProvider>,
      )
    })
    const model = container.querySelector('.chat-input-config-anchor')
    const permission = container.querySelector('[data-kind="permission"]')
    assert.ok(model)
    assert.ok(permission)
    assert.equal(model.nextElementSibling, permission)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

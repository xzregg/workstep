import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MessageProcessor } from '@a2ui/web_core/v0_9'
import A2uiMessage from '../src/components/A2uiMessage'

for (const entry of ['event', 'fence'] as const) {
  test(`oversized ${entry} input never reaches A2UI schema validation`, async () => {
    const { window } = installDomEnvironment()
    const element = document.body.appendChild(document.createElement('div'))
    const root = createRoot(element)
    const original = MessageProcessor.prototype.processMessages
    let calls = 0
    MessageProcessor.prototype.processMessages = () => { calls++ }
    const messages = [{
      version: 'v0.9.1', updateComponents: {
        surfaceId: 'main', components: [
          { component: 'ChoicePicker', id: 'root', options: Array(513).fill(null) },
        ],
      },
    }]
    try {
      await act(async () => root.render(entry === 'event'
        ? <A2uiMessage content="" messages={messages} />
        : <A2uiMessage content={'```a2ui\n' + JSON.stringify(messages[0]) + '\n```'} />))
      assert.equal(calls, 0)
      assert.equal(element.textContent, '')
    } finally {
      MessageProcessor.prototype.processMessages = original
      await act(async () => root.unmount())
      element.remove()
      await window.happyDOM.close()
    }
  })
}

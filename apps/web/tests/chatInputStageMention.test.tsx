// Must stay first so react-dom detects a DOM environment.
import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { useState } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ChatInput from '../src/components/ChatInput'
import { I18nProvider } from '../src/i18n'

function Harness({ onSelect }: { onSelect: (id: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <I18nProvider>
      <ChatInput
        value={value}
        onChange={setValue}
        onSend={() => {}}
        mentions={{
          menuLabel: '选择消息接收阶段',
          options: [
            { id: 'coordinator', label: '协调' },
            { id: 'requirement', label: '需求' },
            { id: 'design', label: '设计' },
          ],
          onSelect,
        }}
      />
    </I18nProvider>
  )
}

test('selecting an @ stage switches the target and removes the routing query', async () => {
  const { window } = installDomEnvironment()
  const selected: string[] = []
  const container = window.document.body.appendChild(window.document.createElement('div'))
  const root = createRoot(container as never)
  try {
    await act(async () => root.render(<Harness onSelect={(id) => selected.push(id)} />))
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )?.set
    assert.ok(setter)

    await act(async () => {
      setter.call(textarea, '@设')
      textarea.setSelectionRange(2, 2)
      textarea.dispatchEvent(new window.Event('input', { bubbles: true }))
    })

    const options = [...container.querySelectorAll('[role="option"]')]
    assert.deepEqual(options.map((option) => option.textContent?.trim()), ['@设计'])
    await act(async () => (options[0] as HTMLButtonElement).click())

    assert.deepEqual(selected, ['design'])
    assert.equal(textarea.value, '')

    await act(async () => {
      setter.call(textarea, '@协')
      textarea.setSelectionRange(2, 2)
      textarea.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    const coordinator = container.querySelector('[role="option"]') as HTMLButtonElement
    assert.equal(coordinator.textContent?.trim(), '@协调')
    await act(async () => coordinator.click())
    assert.deepEqual(selected, ['design', 'coordinator'])
    assert.equal(textarea.value, '')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

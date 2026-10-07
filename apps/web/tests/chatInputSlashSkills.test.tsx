// Must stay first so react-dom detects a DOM environment.
import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import ChatInput from '../src/components/ChatInput'
import { I18nProvider } from '../src/i18n'

function Harness() {
  const [value, setValue] = useState('')
  return (
    <I18nProvider>
      <ChatInput value={value} onChange={setValue} onSend={() => {}}
        projectId="project" skillEngine="codex" />
    </I18nProvider>
  )
}

test('slash opens skills anywhere, closes on further typing, and preserves surrounding text on selection', async () => {
  const { window } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    skills: [{ name: 'review', description: 'Review changes' }],
  }), { headers: { 'Content-Type': 'application/json' } })
  const container = window.document.body.appendChild(window.document.createElement('div'))
  const root = createRoot(container as never)
  try {
    await act(async () => root.render(<Harness />))
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => textarea.focus())
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
    assert.ok(setter)
    const input = async (value: string, cursor = value.length) => {
      await act(async () => {
        setter.call(textarea, value)
        textarea.setSelectionRange(cursor, cursor)
        textarea.dispatchEvent(new window.Event('input', { bubbles: true }))
      })
    }

    for (const value of ['/', '正文/', '第一行\n正文/']) {
      await input(value)
      assert.ok(container.querySelector('[role="listbox"]'), `opens for ${value}`)
      for (const character of [' ', 'r', '中', '\n']) {
        await input(value + character)
        assert.equal(container.querySelector('[role="listbox"]'), null, `closes after ${JSON.stringify(character)}`)
        await input(value)
      }
    }

    await input('前文/后文', 3)
    const option = container.querySelector('[role="option"]') as HTMLButtonElement
    assert.ok(option, 'opens even when text follows the cursor')
    await act(async () => {
      option.click()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    assert.equal(textarea.value, '前文/review 后文')
    assert.equal(textarea.selectionStart, 10)
    assert.equal(container.querySelector('[role="listbox"]'), null)
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})

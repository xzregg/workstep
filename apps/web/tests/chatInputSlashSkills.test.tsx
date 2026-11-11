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

test('slash opens at the start or after whitespace and filters skills by name prefix without refetching', async () => {
  const { window } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.split('?')[0].endsWith('/speech')) {
      return new Response(JSON.stringify({ enabled: false }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }
    requests += 1
    return new Response(JSON.stringify({
      skills: [
        { name: 'review', description: 'Review changes' },
        { name: 'release', description: 'Publish release' },
        { name: 'preview', description: 'Contains review in name' },
        { name: 'deploy', description: 'review mentioned only in description' },
      ],
    }), { headers: { 'Content-Type': 'application/json' } })
  }
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

    for (const value of ['正文/', '第一行\n正文/', 'https://', './']) {
      await input(value)
      assert.equal(container.querySelector('[role="listbox"]'), null, `closed for ${value}`)
    }
    assert.equal(requests, 0, 'ordinary text does not request skills')

    for (const value of ['/', ' /', '\t/', '\n \t/', '正文 /', '正文\t/', '正文\n/']) {
      await input(value)
      assert.ok(container.querySelector('[role="listbox"]'), `opens for ${JSON.stringify(value)}`)
      assert.equal(container.querySelectorAll('[role="option"]').length, 4)
    }
    const requestsBeforeSearch = requests
    await input('正文 /re')
    assert.equal(container.querySelectorAll('[role="option"]').length, 2)
    await input('/REV')
    const options = container.querySelectorAll('[role="option"]')
    assert.equal(options.length, 1)
    assert.ok(options[0].textContent?.includes('review'))
    await input('/missing')
    assert.equal(container.querySelectorAll('[role="option"]').length, 0)
    assert.equal(requests, requestsBeforeSearch, 'search filters the loaded skills locally')

    for (const value of ['/review ', '/review\t', '/review\n']) {
      await input(value)
      assert.equal(container.querySelector('[role="listbox"]'), null)
    }

    await input('正文 /rev后文', 7)
    const option = container.querySelector('[role="option"]') as HTMLButtonElement
    assert.ok(option, 'opens even when text follows the cursor')
    await act(async () => {
      option.click()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    assert.equal(textarea.value, '正文 /review 后文')
    assert.equal(textarea.selectionStart, 11)
    assert.equal(container.querySelector('[role="listbox"]'), null)
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})

import './helpers/domEnv.ts'

import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import MarkdownEditor from '../src/components/MarkdownEditor.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'

test('quickly expands and restores the Markdown editor height', async () => {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <MarkdownEditor value="prompt" onChange={() => {}} minHeight={120} maxHeight="45vh" />
        </I18nProvider>,
      )
    })

    const textarea = container.querySelector<HTMLTextAreaElement>('.markdown-editor-input')
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="markdown-editor-size-toggle"]')
    assert.ok(textarea)
    assert.ok(toggle)
    assert.equal(toggle.getAttribute('aria-pressed'), 'false')
    const shell = container.querySelector('.markdown-editor-shell')!
    assert.equal(shell.getAttribute('data-expanded'), 'false')

    await act(async () => toggle.click())
    assert.equal(toggle.getAttribute('aria-pressed'), 'true')
    assert.equal(shell.getAttribute('data-expanded'), 'true')
    assert.equal(textarea.style.height, '45vh')

    await act(async () => toggle.click())
    assert.equal(toggle.getAttribute('aria-pressed'), 'false')
    assert.equal(shell.getAttribute('data-expanded'), 'false')
    assert.equal(textarea.style.height, '')
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})

import './helpers/domEnv.ts'

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import MarkdownEditor from '../src/components/MarkdownEditor.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'

const styles = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')

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

    await act(async () => toggle.click())
    assert.equal(toggle.getAttribute('aria-pressed'), 'true')
    assert.equal(textarea.style.height, '45vh')

    await act(async () => toggle.click())
    assert.equal(toggle.getAttribute('aria-pressed'), 'false')
    assert.equal(textarea.style.height, '')
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})

test('Markdown editor actions are arranged vertically', () => {
  const actionRule = styles.match(/\.markdown-editor-actions\s*\{([\s\S]*?)\}/)?.[1] ?? ''
  assert.match(actionRule, /flex-direction:\s*column/)
})

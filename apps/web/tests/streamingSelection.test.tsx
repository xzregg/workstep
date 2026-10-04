import './helpers/domEnv.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import MarkdownMessage from '../src/components/MarkdownMessage.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'
import { hasActiveSelectionWithin } from '../src/utils/conversationScroll.ts'

test('streaming markdown keeps the selected DOM text stable until selection ends', async () => {
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const render = async (content: string) => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <MarkdownMessage content={content} streaming />
        </I18nProvider>,
      )
    })
  }
  // reveal 层按 ≤11fps 的节奏揭示文字；等文本收敛（连续两次采样不变）再继续
  const waitForSettle = async () => {
    let prev = ''
    for (let i = 0; i < 40; i++) {
      const current = host.querySelector('.markdown-message')?.textContent ?? ''
      if (current && current === prev) return
      prev = current
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40))
      })
    }
  }

  try {
    await render('**hello')
    await waitForSettle()
    const text = host.querySelector('p')?.firstChild
    assert.ok(text)
    const range = document.createRange()
    range.setStart(text, 2)
    range.setEnd(text, 7)
    const selection = window.getSelection()
    await act(async () => {
      selection?.removeAllRanges()
      selection?.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
    assert.equal(selection?.isCollapsed, false)
    assert.equal(host.querySelector('.markdown-message')?.contains(selection?.anchorNode ?? null), true)

    await render('**hello** world')
    assert.equal(selection?.toString(), 'hello')
    assert.equal(selection?.anchorNode?.isConnected, true)
    assert.equal(host.querySelector('.markdown-message')?.textContent, '**hello')

    await act(async () => {
      selection?.removeAllRanges()
      document.dispatchEvent(new Event('selectionchange'))
    })
    assert.equal(host.querySelector('.markdown-message')?.textContent, 'hello world')
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

test('conversation detects an active text selection inside its scroll area', () => {
  const container = document.body.appendChild(document.createElement('div'))
  const text = container.appendChild(document.createTextNode('select me'))
  const range = document.createRange()
  range.setStart(text, 0)
  range.setEnd(text, 6)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)

  assert.equal(hasActiveSelectionWithin(container, selection), true)
  selection?.removeAllRanges()
  assert.equal(hasActiveSelectionWithin(container, selection), false)
  container.remove()
})

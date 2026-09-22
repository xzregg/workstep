import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import ChatMessageBubble from '../src/components/ChatMessageBubble'
import { I18nProvider } from '../src/i18n'
import { visibleAssistantContent } from '../src/utils/chatMessageDisplay'

test('hides a live body that duplicates the red error line', () => {
  assert.equal(visibleAssistantContent('Reconnecting... 1/5', 'Reconnecting... 1/5'), '')
  assert.equal(
    visibleAssistantContent('（生成失败：Reconnecting... 1/5）', 'Reconnecting... 1/5'),
    '',
  )
})

test('keeps real answer content before or after an error line', () => {
  assert.equal(
    visibleAssistantContent('先说明当前进度。\nReconnecting... 1/5', 'Reconnecting... 1/5'),
    '先说明当前进度。\nReconnecting... 1/5',
  )
  assert.equal(visibleAssistantContent('正常回答', 'Reconnecting... 1/5'), '正常回答')
})

test('renders only the danger-colored error line when content duplicates it', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(window.document.body.appendChild(window.document.createElement('div')))
  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <ChatMessageBubble
            role="assistant"
            sender="Agent"
            initials="AI"
            color="var(--ai-assistant)"
            content="Reconnecting... 1/5"
            error="Reconnecting... 1/5"
          />
        </I18nProvider>,
      )
    })

    assert.equal(
      window.document.body.textContent?.match(/Reconnecting\.\.\. 1\/5/g)?.length,
      1,
    )
    const errorLine = Array.from(window.document.querySelectorAll('div'))
      .find((node) => (
        node.textContent === 'Reconnecting... 1/5'
        && node.children.length === 0
      ))
    assert.match(errorLine?.getAttribute('style') ?? '', /color:\s*var\(--danger\)/)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

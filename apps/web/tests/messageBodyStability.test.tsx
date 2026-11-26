import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import MessageTimeline from '../src/components/MessageTimeline'
import ChatMessageBubble from '../src/components/ChatMessageBubble'
import MessageMetaBar from '../src/components/MessageMetaBar'
import { I18nProvider } from '../src/i18n'
import { appendMessageContent, type AGUIEvent } from '../src/utils/agui'

test('body nodes survive thinking, tools, multiple text runs and clipped history', async () => {
  const { window, document } = installDomEnvironment()
  const matchMedia = window.matchMedia.bind(window)
  window.matchMedia = (query) => {
    const media = matchMedia(query)
    if (query === '(prefers-reduced-motion: reduce)') Object.defineProperty(media, 'matches', { value: true })
    return media
  }
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const events: AGUIEvent[] = [{ type: 'TEXT_MESSAGE_CHUNK', delta: '**已完成检查**\n\n' }]
  let content = '**已完成检查**\n\n'
  const render = (frames = events, streaming = true) => act(async () => root.render(
    <I18nProvider><MessageTimeline content={content} events={frames} streaming={streaming} /></I18nProvider>,
  ))
  try {
    await render()
    const strong = host.querySelector('strong')
    for (const event of [
      { type: 'REASONING_MESSAGE_CHUNK', delta: 'private reasoning' },
      { type: 'TOOL_CALL_START', toolCallId: 'tool', toolCallName: 'Read' },
      { type: 'TOOL_CALL_RESULT', toolCallId: 'tool', output: 'ok' },
      { type: 'TEXT_MESSAGE_CHUNK', delta: 'The main repo has changes.\n\n' },
      ...Array.from({ length: 3 }, () => ({ type: 'REASONING_MESSAGE_CHUNK', delta: 'more reasoning' })),
    ]) {
      content = appendMessageContent(content, event)
      events.push(event)
      await render()
      assert.equal(host.querySelectorAll('.markdown-message').length, 1, 'one body renderer across process boundaries')
      assert.equal(host.textContent, content.replaceAll('**', '').replaceAll('\n', ''))
      assert.ok(host.querySelector('strong') === strong, 'settled nodes survive process updates')
    }
    await render(events.slice(2))
    assert.ok(host.querySelector('strong') === strong, 'rolling event clipping preserves nodes')
    await render([], false)
    assert.ok(host.querySelector('strong') === strong, 'history summary preserves nodes')
    assert.equal(host.textContent, '已完成检查The main repo has changes.')
    await act(async () => root.unmount())
    const restored = createRoot(host)
    await act(async () => restored.render(<I18nProvider><MessageTimeline content={content} events={[]} /></I18nProvider>))
    assert.equal(host.textContent, '已完成检查The main repo has changes.')
    await act(async () => restored.unmount())
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('event snapshots cannot append text beyond the canonical body', async () => {
  const { window, document } = installDomEnvironment()
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  try {
    await act(async () => root.render(<I18nProvider><MessageTimeline
      content="已保存正文" events={[
        { type: 'TEXT_MESSAGE_CHUNK', delta: '已保存正文' },
        { type: 'REASONING_MESSAGE_CHUNK', delta: 'private reasoning' },
        { type: 'TEXT_MESSAGE_CHUNK', delta: '未接受的旧快照片段' },
      ]}
    /></I18nProvider>))
    assert.equal(host.textContent, '已保存正文')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('live reasoning stays in the process viewer and never changes the body', async () => {
  const { window, document } = installDomEnvironment()
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  try {
    for (let i = 1; i <= 4; i++) {
      await act(async () => root.render(<I18nProvider><ChatMessageBubble role="assistant"
        sender="执行" initials="执" color="var(--fg)" content="稳定正文" streaming
        events={[{ type: 'REASONING_MESSAGE_CHUNK', delta: 'secret thinking '.repeat(i) }]}
        header={<MessageMetaBar running onViewPrompt={() => {}} events={[{ type: 'REASONING_MESSAGE_CHUNK', delta: 'secret thinking '.repeat(i) }]} />}
      /></I18nProvider>))
      assert.equal(host.querySelector('.llm-message-timeline')?.textContent, '稳定正文')
      assert.ok(host.textContent?.includes('secret'), 'thinking stays available in the process viewer')
    }
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

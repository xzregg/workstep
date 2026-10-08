import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useTaskConversationScroll } from '../src/hooks/useTaskConversationScroll'
import type { ActionRunLike } from '../src/utils/actionConversation'

test('task shortcut output triggers follow without treating unchanged polling as new content', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const historyMessages: unknown[] = []
  const liveMessages = {}
  const events: unknown[] = []
  const run = { user_message_id: 'u', reply_message_id: 'a', title: '构建', output: '', status: 'running', started_at: '' }
  function Transcript({ runs }: { runs: ActionRunLike[] }) {
    const scroll = useTaskConversationScroll({ historyMessages, liveMessages, events, content: '', actionRuns: runs })
    return <>
      <div ref={scroll.scrollRef} onWheelCapture={scroll.onWheelCapture} />
      <output>{scroll.unreadMessages ? 'unread' : 'read'}</output>
    </>
  }
  const render = (runs: ActionRunLike[]) => act(async () => root.render(<Transcript runs={runs} />))
  try {
    await render([])
    const viewport = container.querySelector('div')!
    let height = 500
    Object.defineProperties(viewport, { scrollHeight: { get: () => height }, clientHeight: { value: 100 } })
    await render([run])
    assert.equal(viewport.scrollTop, 400)
    height = 800
    await render([{ ...run, output: '输出' }])
    assert.equal(viewport.scrollTop, 700)
    await act(async () => viewport.dispatchEvent(new window.WheelEvent('wheel', { bubbles: true, deltaY: -10 })))
    viewport.scrollTop = 200
    await render([{ ...run, output: '输出' }])
    assert.equal(container.querySelector('output')?.textContent, 'read')
    await render([{ ...run, output: '输出\n完成', status: 'succeeded' }])
    assert.equal(viewport.scrollTop, 200)
    assert.equal(container.querySelector('output')?.textContent, 'unread')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('task transcript follows new messages until the user scrolls away', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  function Transcript({ messages }: { messages: Array<{ id: string }> }) {
    const scroll = useTaskConversationScroll({
      historyMessages: messages,
      liveMessages: {},
      events: [],
      content: '',
    })
    return <>
      <div data-testid="scroll" ref={scroll.scrollRef}
        onScroll={scroll.onScroll} onWheelCapture={scroll.onWheelCapture}>
        <div ref={scroll.contentRef} />
      </div>
      <output>{scroll.unreadMessages ? 'unread' : 'read'}</output>
      <button onClick={scroll.jumpToLatest}>latest</button>
    </>
  }
  try {
    await act(async () => root.render(<Transcript messages={[]} />))
    const viewport = container.querySelector<HTMLDivElement>('[data-testid="scroll"]')!
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 500 })
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 100 })
    viewport.scrollTo = ({ top }: ScrollToOptions) => { viewport.scrollTop = top ?? 0 }
    await act(async () => root.render(<Transcript messages={[{ id: 'one' }]} />))
    assert.equal(viewport.scrollTop, 400)
    assert.equal(container.querySelector('output')?.textContent, 'read')

    await act(async () => viewport.dispatchEvent(new window.WheelEvent('wheel', {
      bubbles: true, deltaY: -10,
    })))
    await act(async () => root.render(<Transcript messages={[{ id: 'one' }, { id: 'two' }]} />))
    assert.equal(viewport.scrollTop, 400)
    assert.equal(container.querySelector('output')?.textContent, 'unread')

    viewport.scrollTop = 200
    await act(async () => container.querySelector('button')!.click())
    assert.equal(viewport.scrollTop, 400)
    assert.equal(container.querySelector('output')?.textContent, 'read')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

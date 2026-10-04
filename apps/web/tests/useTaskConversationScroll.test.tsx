import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useTaskConversationScroll } from '../src/hooks/useTaskConversationScroll'

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

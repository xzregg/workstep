import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useTaskConversationScroll } from '../src/hooks/useTaskConversationScroll'
import type { ActionRunLike } from '../src/utils/actionConversation'

for (const unmountWhenHidden of [true, false]) {
  test(`returning to conversation follows latest (${unmountWhenHidden ? 'primary tabs' : 'mobile tabs'})`, async () => {
    const { window } = installDomEnvironment()
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    const historyMessages: unknown[] = []
    const liveMessages = {}
    const events: unknown[] = []
    let height = 1000
    function Transcript({ active }: { active: boolean }) {
      const scroll = useTaskConversationScroll({ historyMessages, liveMessages, events, content: '', active })
      return <>
        {(!unmountWhenHidden || active) && <div ref={(node) => {
          scroll.scrollRef.current = node
          if (node) Object.defineProperties(node, {
            scrollHeight: { configurable: true, get: () => height },
            clientHeight: { configurable: true, value: 100 },
          })
        }} hidden={!active} onWheelCapture={scroll.onWheelCapture} onScroll={scroll.onScroll} />}
        <output>{scroll.unreadMessages ? 'unread' : 'read'}</output>
      </>
    }
    const render = (active: boolean) => act(async () => root.render(<Transcript active={active} />))
    try {
      await render(true)
      const viewport = container.querySelector('div')!
      await act(async () => viewport.dispatchEvent(new window.WheelEvent('wheel', { bubbles: true, deltaY: -10 })))
      viewport.scrollTop = 200
      await render(false)
      await render(true)
      const restored = container.querySelector('div')!
      assert.equal(restored.scrollTop, 900)
      assert.equal(container.querySelector('output')?.textContent, 'read')
      height = 1200
      await act(async () => restored.dispatchEvent(new window.Event('load')))
      assert.equal(restored.scrollTop, 1100)
    } finally {
      await act(async () => root.unmount())
      container.remove()
      await window.happyDOM.close()
    }
  })
}

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

// Must stay the first import: react-dom snapshots canUseDOM when it is loaded,
// and without a DOM at that moment textarea onChange events never fire.
import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { useState } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ChatInput from '../src/components/ChatInput'
import ChatInputTextSegment from '../src/components/ChatInputTextSegment'
import { resizeComposerTextarea } from '../src/utils/composerResize'
import { I18nProvider } from '../src/i18n'

/* Regression guard for the composer + IME interaction.

   While the input method owns the textarea the committed value is stale, so any
   re-render that writes that stale value back to the DOM aborts the composition
   (the candidate window disappears and the half-typed text is lost) and
   collapses the content, which clamps the scrollable composer body to the top —
   the scrollbar jumping up when picking a candidate. */

/** Assign the value through the native setter so React sees a real change. */
function setNativeValue(window: ReturnType<typeof installDomEnvironment>['window'], element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
  assert.ok(setter, 'textarea value setter must exist')
  setter.call(element, value)
}

function dispatch(element: EventTarget, type: string) {
  element.dispatchEvent(new Event(type, { bubbles: true }))
}

function ComposerHarness({ onValueChange }: { onValueChange?: (value: string) => void }) {
  const [value, setValue] = useState('')
  const [, setTick] = useState(0)
  return (
    <I18nProvider>
      <ChatInput
        value={value}
        onChange={(next) => {
          setValue(next)
          onValueChange?.(next)
        }}
        onSend={() => {}}
        placeholder="输入消息"
      />
      <button type="button" data-testid="rerender" onClick={() => setTick((tick) => tick + 1)}>
        rerender
      </button>
    </I18nProvider>
  )
}

async function renderHarness(window: ReturnType<typeof installDomEnvironment>['window'], onValueChange?: (value: string) => void) {
  const container = window.document.body.appendChild(window.document.createElement('div'))
  let root!: Root
  await act(async () => {
    root = createRoot(container as never)
    root.render(<ComposerHarness onValueChange={onValueChange} />)
    await Promise.resolve()
  })
  return { root, container }
}

test('IME composition keeps the textarea DOM value through unrelated re-renders', async () => {
  const { window } = installDomEnvironment()
  const committed: string[] = []
  try {
    const { root } = await renderHarness(window, (value) => committed.push(value))
    const textarea = window.document.querySelector('textarea') as HTMLTextAreaElement
    assert.ok(textarea, 'composer renders a textarea')

    // Committed baseline text typed without an IME.
    await act(async () => {
      setNativeValue(window, textarea, '第一行内容\n')
      dispatch(textarea, 'input')
    })
    assert.equal(committed.at(-1), '第一行内容\n')

    // The IME takes over: pre-edit text lives only in the DOM.
    await act(async () => {
      dispatch(textarea, 'compositionstart')
      setNativeValue(window, textarea, '第一行内容\nnihao')
      dispatch(textarea, 'input')
    })
    assert.equal(textarea.value, '第一行内容\nnihao')
    assert.equal(committed.at(-1), '第一行内容\n', 'composition must not commit yet')

    // Any re-render (polling, caret bookkeeping, …) must not write the stale
    // committed value back — that is what closed the candidate window.
    const rerender = window.document.querySelector('[data-testid="rerender"]') as HTMLElement
    await act(async () => { rerender.click() })
    assert.equal(textarea.value, '第一行内容\nnihao', 'stale value must not reset the IME draft')

    // A caret move while composing (picking a candidate) must not disturb the
    // draft either — the composer is not told about it, so nothing re-renders.
    await act(async () => {
      textarea.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(textarea.value, '第一行内容\nnihao', 'caret moves during composition keep the draft')
    assert.equal(committed.at(-1), '第一行内容\n', 'caret moves during composition must not commit')

    // Committing the candidate keeps the text and resumes normal updates.
    await act(async () => {
      setNativeValue(window, textarea, '第一行内容\n你好')
      dispatch(textarea, 'input')
      dispatch(textarea, 'compositionend')
    })
    assert.equal(textarea.value, '第一行内容\n你好')
    assert.equal(committed.at(-1), '第一行内容\n你好')

    // After composition the textarea is driven by the parent value again.
    await act(async () => {
      setNativeValue(window, textarea, '第一行内容\n你好！')
      dispatch(textarea, 'input')
    })
    assert.equal(committed.at(-1), '第一行内容\n你好！')

    await act(async () => { root.unmount() })
  } finally {
    await window.happyDOM.close()
  }
})

test('composer scroll offset survives auto-resize while typing', async () => {
  const { window } = installDomEnvironment()
  try {
    const { root } = await renderHarness(window)
    const scroller = window.document.querySelector('.chat-input-editor') as HTMLElement
    const textarea = window.document.querySelector('textarea') as HTMLTextAreaElement
    assert.ok(scroller && textarea)

    // happy-dom has no layout engine: fake a tall document scrolled down.
    Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 400 })
    let scrollTop = 120
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value },
    })

    resizeComposerTextarea(textarea)
    assert.equal(scroller.scrollTop, 120, 'measuring must not scroll the composer to the top')
    assert.equal(textarea.style.height, '400px')

    await act(async () => {
      dispatch(textarea, 'compositionstart')
      setNativeValue(window, textarea, 'composing text')
      dispatch(textarea, 'input')
    })
    assert.equal(scroller.scrollTop, 120, 'IME updates must not move the scrollbar')

    await act(async () => {
      dispatch(textarea, 'compositionend')
    })
    assert.equal(scroller.scrollTop, 120, 'committing a candidate must not move the scrollbar')

    await act(async () => { root.unmount() })
  } finally {
    await window.happyDOM.close()
  }
})

/* Typing latency guards: the auto-resize forces a synchronous layout, so each
   content change must be measured exactly once, the ref must not be
   detached/reattached per keystroke, and composing must not re-render the
   composer around the textarea. */

function SegmentHarness({
  counters,
  onCommit,
}: {
  counters: { renders: number; attaches: number; cursorMoves: number }
  onCommit: (text: string, cursor: number) => void
}) {
  const [markdown, setMarkdown] = useState('')
  counters.renders += 1
  return (
    <div className="chat-input-editor">
      <ChatInputTextSegment
        markdown={markdown}
        onElement={() => { counters.attaches += 1 }}
        onCommitText={(text, cursor) => {
          setMarkdown(text)
          onCommit(text, cursor)
        }}
        onCursorMove={() => { counters.cursorMoves += 1 }}
        onFocusElement={() => {}}
        onBlurElement={() => {}}
      />
    </div>
  )
}

test('typing measures the height once per change and never re-attaches the ref', async () => {
  const { window } = installDomEnvironment()
  const counters = { renders: 0, attaches: 0, cursorMoves: 0 }
  const committed: string[] = []
  try {
    const container = window.document.body.appendChild(window.document.createElement('div'))
    let root!: Root
    await act(async () => {
      root = createRoot(container as never)
      root.render(<SegmentHarness counters={counters} onCommit={(text) => committed.push(text)} />)
      await Promise.resolve()
    })
    const textarea = window.document.querySelector('textarea') as HTMLTextAreaElement
    assert.ok(textarea)

    // Count measurements through the only layout read the resize performs.
    let measures = 0
    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true,
      get: () => { measures += 1; return 400 },
    })

    assert.equal(counters.attaches, 1, 'the ref is attached once on mount')

    // Plain (non-IME) typing: one measurement, no ref churn.
    const measuresBefore = measures
    const rendersBefore = counters.renders
    await act(async () => {
      setNativeValue(window, textarea, 'hello')
      dispatch(textarea, 'input')
    })
    assert.equal(committed.at(-1), 'hello')
    assert.equal(measures - measuresBefore, 1, 'committed typing measures the height once')
    assert.equal(counters.attaches, 1, 'committed typing must not re-attach the ref')
    assert.equal(counters.renders - rendersBefore, 1, 'committed typing re-renders the composer once')

    // IME composition: the composer around the textarea does not re-render, the
    // draft stays local, and nothing is committed until compositionend.
    const rendersAtComposition = counters.renders
    await act(async () => {
      dispatch(textarea, 'compositionstart')
      setNativeValue(window, textarea, 'hellonihao')
      dispatch(textarea, 'input')
      setNativeValue(window, textarea, 'hello ni hao')
      dispatch(textarea, 'input')
    })
    assert.equal(counters.renders, rendersAtComposition, 'composing must not re-render the composer')
    assert.equal(committed.at(-1), 'hello', 'composing must not commit')
    assert.equal(counters.attaches, 1, 'composing must not re-attach the ref')
    assert.equal(textarea.value, 'hello ni hao')
    assert.ok(measures - measuresBefore <= 3, 'each composed update measures at most once')

    // A caret move while composing (picking a candidate) must not reach the
    // composer — that re-render is what used to reset the draft.
    await act(async () => {
      textarea.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(counters.cursorMoves, 0, 'caret moves during composition stay local')
    assert.equal(textarea.value, 'hello ni hao')

    await act(async () => {
      setNativeValue(window, textarea, 'hello 你好')
      dispatch(textarea, 'input')
      dispatch(textarea, 'compositionend')
    })
    assert.equal(committed.at(-1), 'hello 你好')
    assert.equal(textarea.value, 'hello 你好')

    // After composition the caret is reported to the composer again.
    await act(async () => {
      textarea.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(counters.cursorMoves, 1, 'caret moves are reported once composition ends')

    await act(async () => { root.unmount() })
  } finally {
    await window.happyDOM.close()
  }
})

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type CompositionEvent,
  type FocusEvent,
  type KeyboardEvent,
  type MutableRefObject,
  type Ref,
} from 'react'
import { resizeComposerTextarea } from '../utils/composerResize'

/* ══════════════════════════════════════════
   ChatInputTextSegment — one auto-growing
   <textarea> inside the shared composer.

   The composer is split into text/image
   segments, so each text run owns its own
   textarea. Three things must hold here:

   1. IME composition survives. While the input
      method owns the textarea the committed value
      is stale, and React rewrites a controlled
      textarea after every event: if the rendered
      value differs from the DOM value the pre-edit
      text is discarded, the candidate window
      closes and the content collapses (which also
      drags the composer scrollbar to the top). So
      while composing we render a local draft that
      always equals the live DOM value, and commit
      once on compositionend.
   2. Typing stays cheap. The draft is local
      state, so composing never re-renders the
      composer; the ref callback is stable so React
      never detaches/reattaches (and re-registers)
      it per keystroke.
   3. Content is measured once per change — the
      auto-resize forces synchronous layout, so
      `sizedValueRef` dedupes handler and effect.
   ══════════════════════════════════════════ */

export interface ChatInputTextSegmentProps {
  /** Committed markdown of this text run — the source of truth while the IME is idle. */
  markdown: string
  placeholder?: string
  disabled?: boolean
  rows?: number
  /** Keep short text beside an adjacent image instead of forcing a full row. */
  inlineWithImage?: boolean
  /** Forwarded to the textarea (the last text run exposes it to focus flows). */
  externalRef?: Ref<HTMLTextAreaElement>
  /** Element registration so the parent keeps its focus/segment maps. */
  onElement: (element: HTMLTextAreaElement | null) => void
  /** Called with the committed text plus the caret inside this segment. */
  onCommitText: (text: string, localCursor: number) => void
  /** Caret moves from click/selection — suppressed while composing. */
  onCursorMove: (localCursor: number) => void
  onFocusElement: (element: HTMLTextAreaElement) => void
  onBlurElement: (element: HTMLTextAreaElement, relatedTarget: EventTarget | null) => void
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void
}

export default function ChatInputTextSegment({
  markdown,
  placeholder,
  disabled = false,
  rows = 1,
  inlineWithImage = false,
  externalRef,
  onElement,
  onCommitText,
  onCursorMove,
  onFocusElement,
  onBlurElement,
  onKeyDown,
  onPaste,
}: ChatInputTextSegmentProps) {
  const elementRef = useRef<HTMLTextAreaElement | null>(null)
  /** True while the IME owns the textarea (between compositionstart/end). */
  const composingRef = useRef(false)
  /** Last content the height was measured for, so we never measure twice. */
  const sizedValueRef = useRef<string | null>(null)
  // Mirrors the live DOM value while composing so React's controlled-input
  // restore finds props.value === node.value and leaves the pre-edit text alone.
  const [draft, setDraft] = useState<string | null>(null)
  // Latest callbacks without changing the ref callback's identity: a new
  // identity would make React detach/reattach (and re-register) every render.
  const handlersRef = useRef({ onElement, externalRef })

  useLayoutEffect(() => {
    handlersRef.current = { onElement, externalRef }
  })

  const syncHeight = useCallback((element: HTMLTextAreaElement | null) => {
    if (!element) return
    sizedValueRef.current = element.value
    resizeComposerTextarea(element)
  }, [])

  // One measurement per content change: mount, external value updates and
  // committed/composed typing. Handler-driven resizes mark `sizedValueRef`.
  useLayoutEffect(() => {
    const element = elementRef.current
    if (!element || sizedValueRef.current === element.value) return
    syncHeight(element)
  }, [markdown, draft, syncHeight])

  // Keep the external focus ref pointed at this textarea while it is the run the
  // parent asked to expose, without redoing it on every parent render.
  const attachedExternalRef = useRef<Ref<HTMLTextAreaElement> | undefined>(undefined)
  useLayoutEffect(() => {
    const previous = attachedExternalRef.current
    attachedExternalRef.current = externalRef
    if (previous === externalRef) return
    const element = elementRef.current
    if (previous) {
      if (typeof previous === 'function') previous(null)
      else if ((previous as MutableRefObject<HTMLTextAreaElement | null>).current === element) {
        ;(previous as MutableRefObject<HTMLTextAreaElement | null>).current = null
      }
    }
    if (!externalRef) return
    if (typeof externalRef === 'function') externalRef(element)
    else externalRef.current = element
  }, [externalRef])

  const attachRef = useCallback((element: HTMLTextAreaElement | null) => {
    elementRef.current = element
    handlersRef.current.onElement(element)
    if (element) syncHeight(element)
    else {
      composingRef.current = false
      sizedValueRef.current = null
    }
  }, [syncHeight])

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const element = event.currentTarget
    const next = element.value
    if (composingRef.current) {
      // Local-only update: the pre-edit text is not committed, the composer does
      // not re-render, and the rendered value keeps matching the DOM value.
      setDraft(next)
      syncHeight(element)
      return
    }
    if (draft !== null) setDraft(null)
    onCommitText(next, element.selectionStart)
    syncHeight(element)
  }

  const handleCompositionStart = (event: CompositionEvent<HTMLTextAreaElement>) => {
    composingRef.current = true
    setDraft(event.currentTarget.value)
  }

  const handleCompositionEnd = (event: CompositionEvent<HTMLTextAreaElement>) => {
    composingRef.current = false
    const element = event.currentTarget
    const next = element.value
    // Same batch: the draft is dropped and the parent echoes the final text back,
    // so the rendered value never falls back to a stale one in between.
    setDraft(null)
    onCommitText(next, element.selectionStart)
    syncHeight(element)
  }

  const reportCursor = (element: HTMLTextAreaElement) => {
    // A caret move while composing is the IME picking a candidate — reporting it
    // would re-render the composer and reset the draft.
    if (composingRef.current) return
    onCursorMove(element.selectionStart)
  }

  return (
    <textarea
      ref={attachRef}
      className={`chat-input-text-segment${inlineWithImage ? ' chat-input-text-segment--inline' : ''}`}
      value={draft ?? markdown}
      onChange={handleChange}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
      onPaste={onPaste}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      disabled={disabled}
      rows={rows}
      onFocus={(event: FocusEvent<HTMLTextAreaElement>) => onFocusElement(event.currentTarget)}
      onBlur={(event: FocusEvent<HTMLTextAreaElement>) =>
        onBlurElement(event.currentTarget, event.relatedTarget)
      }
      onClick={(event) => reportCursor(event.currentTarget)}
      onSelect={(event) => reportCursor(event.currentTarget)}
    />
  )
}

import { memo, useLayoutEffect, useRef, useState } from 'react'
import { MIN_REVEAL_FRAME_MS } from '../hooks/useStreamReveal'

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const MAX_PENDING_CHARS = 32
// Allow the last reveal frame and the height/follow animations to settle.
export const REVEAL_SETTLE_MS = MIN_REVEAL_FRAME_MS + 360

type Character = { start: number; end: number; at: number }

function appendCharacters(text: string, offset: number, now: number): Character[] {
  const boundary = segmenter.segment(text).containing(offset)
  if (boundary && boundary.index < offset) offset = boundary.index + boundary.segment.length
  const parts = Array.from(segmenter.segment(text.slice(offset))).slice(-MAX_PENDING_CHARS)
  const stagger = MIN_REVEAL_FRAME_MS / Math.max(1, parts.length)
  return parts.map((part, index) => ({
    start: offset + part.index,
    end: offset + part.index + part.segment.length,
    at: now + index * stagger,
  }))
}

/** Reveal only the suffix of one native text node; never replace settled glyphs
 * with animation spans. Frame updates stay in this leaf, outside Markdown parsing. */
function StreamRevealText({ text, enabled, animateInitial = true, animateFrom = 0 }: { text: string; enabled: boolean; animateInitial?: boolean; animateFrom?: number }) {
  const selected = useRef(false)
  const [state, setState] = useState(() => {
    const characters = enabled && animateInitial ? appendCharacters(text, animateFrom, performance.now()) : []
    return { text, enabled, characters, shown: characters.length ? characters[0].start : text.length }
  })
  let current = state
  if (state.text !== text || state.enabled !== enabled) {
    const boundary = segmenter.segment(text).containing(state.text.length)
    const appending = enabled && state.enabled && text.startsWith(state.text)
      && (!boundary || boundary.index === state.text.length)
    const from = Math.max(state.text.length, animateFrom)
    const added = appending ? appendCharacters(text, from, Math.max(performance.now(), state.characters.at(-1)?.at ?? 0)) : []
    const pending = appending ? [...state.characters, ...added] : []
    const characters = pending.slice(-MAX_PENDING_CHARS)
    // Only bulk catch-up or a source frontier beyond the previous target may
    // skip ahead. Ordinary appends must retain the previous pending characters.
    const skipped = pending.length > MAX_PENDING_CHARS ? characters[0].start : 0
    const start = added.length && added[0].start > from ? added[0].start : 0
    current = {
      text, enabled, characters,
      shown: appending && characters.length ? Math.max(state.shown, animateFrom > state.text.length ? animateFrom : 0, start, skipped) : text.length,
    }
    setState(current)
  }
  useLayoutEffect(() => {
    if (!enabled || !current.characters.length) { selected.current = false; return }
    const updateSelection = () => { selected.current = window.getSelection()?.isCollapsed === false }
    updateSelection()
    document.addEventListener('selectionchange', updateSelection)
    return () => document.removeEventListener('selectionchange', updateSelection)
  }, [enabled, current.characters.length > 0])
  useLayoutEffect(() => {
    const characters = state.characters
    if (!characters.length) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.hidden) {
      setState(current => ({ ...current, shown: current.text.length, characters: [] }))
      return
    }
    let frame = 0
    let selectionTimer: ReturnType<typeof setTimeout> | undefined
    const tick = () => {
      if (selected.current) {
        selectionTimer = setTimeout(tick, 250)
        return
      }
      const now = performance.now()
      const done = now >= characters[characters.length - 1].at
      let shown = 0
      for (const char of characters) {
        if (char.at > now) break
        shown = char.end
      }
      setState(current => current.characters === characters && (shown > current.shown || done)
        ? { ...current, shown: done ? current.text.length : Math.max(current.shown, shown), characters: done ? [] : characters }
        : current)
      if (!done) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(frame); clearTimeout(selectionTimer) }
  }, [state.characters])
  return <>{text.slice(0, current.shown)}</>
}

export default memo(StreamRevealText)

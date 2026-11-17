import { Fragment, memo, useEffect, useState } from 'react'
import { MIN_REVEAL_FRAME_MS } from '../hooks/useStreamReveal'

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const MAX_ANIMATED_CHARS = 32
export const REVEAL_FADE_MS = 320
// CSS starts on a painted frame, slightly after React commits the text.
const REVEAL_FRAME_MARGIN_MS = 40
export const REVEAL_SETTLE_MS = REVEAL_FADE_MS + MIN_REVEAL_FRAME_MS + REVEAL_FRAME_MARGIN_MS
const MAX_ACTIVE_CHARS = MAX_ANIMATED_CHARS * Math.ceil(REVEAL_SETTLE_MS / MIN_REVEAL_FRAME_MS)
type Character = { text: string; offset: number; delay: number; endsAt: number }

function appendCharacters(text: string, offset: number, now: number): Character[] {
  const boundary = segmenter.segment(text).containing(offset)
  if (boundary && boundary.index < offset) offset = boundary.index + boundary.segment.length
  const parts = Array.from(segmenter.segment(text.slice(offset))).slice(-MAX_ANIMATED_CHARS)
  // Fit every batch into one parse interval, even when catch-up accelerates.
  const stagger = MIN_REVEAL_FRAME_MS / Math.max(1, parts.length)
  return parts.map((part, index) => ({
      text: part.segment,
      offset: offset + part.index,
      delay: index * stagger,
      endsAt: now + index * stagger + REVEAL_FADE_MS + REVEAL_FRAME_MARGIN_MS,
    }))
}

/** CSS owns the animation: no per-character timers or Markdown reparses. */
function StreamRevealText({ text, enabled, animateInitial = true, animateFrom = 0 }: { text: string; enabled: boolean; animateInitial?: boolean; animateFrom?: number }) {
  const [state, setState] = useState(() => ({
    text, enabled,
    characters: enabled && animateInitial ? appendCharacters(text, animateFrom, performance.now()) : [],
  }))
  // One timer per active text batch, never per character. Expired spans must
  // return to plain text, otherwise long replies retain thousands of filled
  // finished animations and their rendering cost after they have settled.
  useEffect(() => {
    if (state.characters.length === 0) return
    let timer: ReturnType<typeof setTimeout>
    const settle = () => {
      if (window.getSelection()?.isCollapsed === false) {
        timer = setTimeout(settle, 250)
        return
      }
      setState(current => current.characters === state.characters ? { ...current, characters: [] } : current)
    }
    timer = setTimeout(settle, Math.max(0, Math.max(...state.characters.map(char => char.endsAt)) - performance.now()) + 20)
    return () => clearTimeout(timer)
  }, [state.characters])
  let current = state
  if (state.text !== text || state.enabled !== enabled) {
    const now = performance.now()
    const appending = enabled && state.enabled && text.startsWith(state.text)
    current = {
      text, enabled,
      characters: appending
        ? [...state.characters.filter((char) => char.endsAt > now), ...appendCharacters(text, Math.max(state.text.length, animateFrom), now)].slice(-MAX_ACTIVE_CHARS)
        : [],
    }
    setState(current)
  }
  if (!enabled || current.characters.length === 0) return <>{text}</>

  // Keep Latin words together while their tail fades in.
  return <>{Array.from(text.matchAll(/[A-Za-z0-9_]+|[^A-Za-z0-9_]+/g), (match) => {
    const start = match.index!
    const end = start + match[0].length
    const characters = current.characters.filter((char) => char.offset >= start && char.offset < end)
    const children = characters.length === 0 ? match[0] : <>
      {characters.map((char, index) => <Fragment key={char.offset}>
        {text.slice(index === 0 ? start : characters[index - 1].offset + characters[index - 1].text.length, char.offset)}
        <span
        key={char.offset}
        className="stream-reveal-char"
        style={{ animationDelay: `${char.delay}ms` }}
      >{char.text}</span></Fragment>)}
      {text.slice(characters[characters.length - 1].offset + characters[characters.length - 1].text.length, end)}
    </>
    return /^[A-Za-z0-9_]/.test(match[0])
      ? <span key={start} className="stream-reveal-word">{children}</span>
      : <Fragment key={start}>{children}</Fragment>
  })}</>
}

export default memo(StreamRevealText)

import { Fragment, memo, useState } from 'react'

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const MAX_ANIMATED_CHARS = 32
type Character = { text: string; offset: number; delay: number; endsAt: number }

function appendCharacters(text: string, offset: number, now: number): Character[] {
  return Array.from(segmenter.segment(text.slice(offset))).slice(-MAX_ANIMATED_CHARS)
    .map((part, index) => ({
      text: part.segment,
      offset: offset + part.index,
      delay: index * 30,
      endsAt: now + index * 30 + 90,
    }))
}

/** CSS owns the animation: no per-character timers or Markdown reparses. */
function StreamRevealText({ text, enabled }: { text: string; enabled: boolean }) {
  const [state, setState] = useState(() => ({
    text, enabled,
    characters: enabled ? appendCharacters(text, 0, performance.now()) : [],
  }))
  let current = state
  if (state.text !== text || state.enabled !== enabled) {
    const now = performance.now()
    const appending = enabled && state.enabled && text.startsWith(state.text)
    current = {
      text, enabled,
      characters: appending
        ? [...state.characters.filter((char) => char.endsAt > now), ...appendCharacters(text, state.text.length, now)].slice(-MAX_ANIMATED_CHARS)
        : [],
    }
    setState(current)
  }
  if (!enabled || current.characters.length === 0) return <>{text}</>

  // Keep Latin words together: inline-block characters must not add word breaks.
  return <>{Array.from(text.matchAll(/[A-Za-z0-9_]+|[^A-Za-z0-9_]+/g), (match) => {
    const start = match.index!
    const end = start + match[0].length
    const characters = current.characters.filter((char) => char.offset >= start && char.offset < end)
    const children = characters.length === 0 ? match[0] : <>
      {text.slice(start, characters[0].offset)}
      {characters.map((char) => <span
        key={char.offset}
        className="stream-reveal-char"
        style={{ animationDelay: `${char.delay}ms` }}
      >{char.text}</span>)}
    </>
    return /^[A-Za-z0-9_]/.test(match[0])
      ? <span key={start} className="stream-reveal-word">{children}</span>
      : <Fragment key={start}>{children}</Fragment>
  })}</>
}

export default memo(StreamRevealText)

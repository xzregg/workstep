import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'

type Layout = 'horizontal' | 'vertical'
const minimum = { horizontal: 360, vertical: 320 }

/** Keeps each orientation's pane proportions; transient pointer moves bypass React. */
export function useChatPaneResize(ids: string[], layout: Layout, compact: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  const cleanup = useRef<(() => void) | null>(null)
  const scope = ids.join('/')
  const [saved, setSaved] = useState<Partial<Record<Layout, { scope: string; values: number[] }>>>({})
  const values = saved[layout]?.scope === scope ? saved[layout]!.values : ids.map(() => 1)
  const dimension = layout === 'horizontal' ? 'width' : 'height'
  const property = layout === 'horizontal' ? 'gridTemplateColumns' : 'gridTemplateRows'
  const tracks = (sizes: number[]) => sizes.map(size => `minmax(${ids.length > 1 ? minimum[layout] : 0}px, ${size}fr)`).join(' var(--chat-pane-divider-size) ')
  const style: CSSProperties | undefined = compact ? undefined : {
    [property]: tracks(values),
    [layout === 'horizontal' ? 'minWidth' : 'minHeight']: ids.length > 1
      ? `calc(${ids.length * minimum[layout]}px + ${ids.length - 1} * var(--chat-pane-divider-size))` : 0,
  }
  useEffect(() => () => cleanup.current?.(), [scope, layout, compact])

  const measure = () => Array.from(ref.current?.children || [])
    .filter(element => element.classList.contains('chat-workspace-pane'))
    .map(element => element.getBoundingClientRect()[dimension])
  const adjusted = (sizes: number[], index: number, delta: number) => {
    const next = [...sizes]
    const pair = sizes[index] + sizes[index + 1]
    next[index] = Math.max(minimum[layout], Math.min(pair - minimum[layout], sizes[index] + delta))
    next[index + 1] = pair - next[index]
    return next
  }
  const save = (sizes: number[]) => setSaved(current => ({ ...current, [layout]: { scope, values: sizes } }))
  const startResize = (event: PointerEvent<HTMLDivElement>, index: number) => {
    if (compact || event.button !== 0) return
    cleanup.current?.()
    const sizes = measure()
    if (!sizes[index] || !sizes[index + 1]) return
    event.preventDefault()
    event.stopPropagation()
    const start = layout === 'horizontal' ? event.clientX : event.clientY
    const root = ref.current!
    let latest = sizes
    const move = (moveEvent: globalThis.PointerEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return
      const position = layout === 'horizontal' ? moveEvent.clientX : moveEvent.clientY
      latest = adjusted(sizes, index, position - start)
      root.style[property] = tracks(latest)
    }
    const clear = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finish)
      document.body.classList.remove(`chat-panes-resizing-${layout}`)
      cleanup.current = null
    }
    const finish = (finishEvent: Event) => {
      if ('pointerId' in finishEvent && finishEvent.pointerId !== event.pointerId) return
      clear()
      save(latest)
    }
    cleanup.current = clear
    document.body.classList.add(`chat-panes-resizing-${layout}`)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', finish)
  }
  const resizeWithKeys = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    if (compact) return
    const direction = layout === 'horizontal' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
    if (!direction.includes(event.key)) return
    const sizes = measure()
    if (!sizes[index] || !sizes[index + 1]) return
    event.preventDefault()
    event.stopPropagation()
    save(adjusted(sizes, index, event.key === direction[0] ? -24 : 24))
  }
  return { ref, style, startResize, resizeWithKeys }
}

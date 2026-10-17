import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react'
import { useActiveSkin } from '../skins/runtime'
import { resolvedSkinLayout } from '../skins/contract'
import { useCompactLayout } from './useCompactLayout'

const COMPOSER_HEIGHT_KEY = 'workstep-chat-composer-height'
const MIN_COMPOSER_HEIGHT = 220
const MAX_COMPOSER_FRACTION = 0.85

function loadHeight(key = COMPOSER_HEIGHT_KEY): number | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

/** Owns the shared chat composer divider, size bounds and persisted height. */
export function useChatComposerResize() {
  const skin = useActiveSkin(), compact = useCompactLayout()
  const position = compact ? 'bottom' : resolvedSkinLayout(skin).composerPosition
  const horizontal = position === 'left' || position === 'right'
  const dimension = horizontal ? 'width' : 'height'
  const direction = position === 'left' || position === 'top' ? 1 : -1
  const key = horizontal ? 'workstep-chat-composer-width' : COMPOSER_HEIGHT_KEY
  const rootRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  const composerInnerRef = useRef<HTMLDivElement>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  const [sizes, setSizes] = useState(() => ({ height: loadHeight(), width: loadHeight('workstep-chat-composer-width') }))
  const height = sizes[dimension]
  const setHeight = (value: number | null) => setSizes(current => ({ ...current, [dimension]: value }))
  const composerStyle: CSSProperties | undefined = compact ? undefined : horizontal ? { width: height ?? 320 } : height === null ? undefined : { height }

  useEffect(() => {
    try {
      if (height === null) window.localStorage.removeItem(key)
      else window.localStorage.setItem(key, String(Math.round(height)))
    } catch { /* localStorage unavailable */ }
  }, [height, key])

  useEffect(() => { dragCleanupRef.current?.() }, [position])

  useEffect(() => () => dragCleanupRef.current?.(), [])

  const clampHeight = (candidate: number) => {
    const containerHeight = rootRef.current?.getBoundingClientRect()[dimension]
    const max = containerHeight
      ? Math.max(0, Math.round(containerHeight * MAX_COMPOSER_FRACTION))
      : candidate
    return Math.min(Math.max(Math.min(MIN_COMPOSER_HEIGHT, max), candidate), max)
  }

  // Write the transient drag height to the DOM; commit one React update on release.
  const startResize = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragCleanupRef.current?.()
    const startY = horizontal ? event.clientX : event.clientY
    const startHeight = composerRef.current?.getBoundingClientRect()[dimension]
      ?? height ?? MIN_COMPOSER_HEIGHT
    let latest = startHeight
    const onMove = (moveEvent: globalThis.MouseEvent) => {
      latest = clampHeight(startHeight + direction * ((horizontal ? moveEvent.clientX : moveEvent.clientY) - startY))
      if (composerRef.current) composerRef.current.style[dimension] = `${latest}px`
      composerInnerRef.current?.classList.add('is-resizing')
    }
    const cleanup = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('chat-composer-resizing')
      document.body.classList.remove('chat-composer-resizing-horizontal')
      composerInnerRef.current?.classList.remove('is-resizing')
      dragCleanupRef.current = null
    }
    const onUp = () => {
      cleanup()
      setHeight(latest)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.classList.add('chat-composer-resizing')
    if (horizontal) document.body.classList.add('chat-composer-resizing-horizontal')
    dragCleanupRef.current = cleanup
  }

  const resetHeight = () => setHeight(null)

  const handleResizeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const base = composerRef.current?.getBoundingClientRect()[dimension]
      ?? height ?? MIN_COMPOSER_HEIGHT
    let next: number | null
    if (event.key === (horizontal ? 'ArrowLeft' : 'ArrowUp')) next = base - direction * 8
    else if (event.key === (horizontal ? 'ArrowRight' : 'ArrowDown')) next = base + direction * 8
    else if (event.key === 'Escape' || event.key === 'Home') next = null
    else return
    event.preventDefault()
    setHeight(next === null ? null : clampHeight(next))
  }

  return { rootRef, composerRef, composerInnerRef, height, position, horizontal, composerStyle, startResize, resetHeight, handleResizeKey }
}

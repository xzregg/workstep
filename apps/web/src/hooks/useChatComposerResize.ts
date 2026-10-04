import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'

const COMPOSER_HEIGHT_KEY = 'workstep-chat-composer-height'
const MIN_COMPOSER_HEIGHT = 220
const MAX_COMPOSER_FRACTION = 0.85

function loadHeight(): number | null {
  try {
    const raw = window.localStorage.getItem(COMPOSER_HEIGHT_KEY)
    if (!raw) return null
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

/** Owns the shared chat composer divider, size bounds and persisted height. */
export function useChatComposerResize() {
  const rootRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  const composerInnerRef = useRef<HTMLDivElement>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  const [height, setHeight] = useState<number | null>(loadHeight)

  useEffect(() => {
    try {
      if (height === null) window.localStorage.removeItem(COMPOSER_HEIGHT_KEY)
      else window.localStorage.setItem(COMPOSER_HEIGHT_KEY, String(Math.round(height)))
    } catch { /* localStorage unavailable */ }
  }, [height])

  useEffect(() => () => dragCleanupRef.current?.(), [])

  const clampHeight = (candidate: number) => {
    const containerHeight = rootRef.current?.getBoundingClientRect().height
    const max = containerHeight
      ? Math.max(MIN_COMPOSER_HEIGHT, Math.round(containerHeight * MAX_COMPOSER_FRACTION))
      : candidate
    return Math.min(Math.max(MIN_COMPOSER_HEIGHT, candidate), max)
  }

  // Write the transient drag height to the DOM; commit one React update on release.
  const startResize = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragCleanupRef.current?.()
    const startY = event.clientY
    const startHeight = composerRef.current?.getBoundingClientRect().height
      ?? height ?? MIN_COMPOSER_HEIGHT
    let latest = startHeight
    const onMove = (moveEvent: globalThis.MouseEvent) => {
      latest = clampHeight(startHeight + (startY - moveEvent.clientY))
      if (composerRef.current) composerRef.current.style.height = `${latest}px`
      composerInnerRef.current?.classList.add('is-resizing')
    }
    const cleanup = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('chat-composer-resizing')
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
    dragCleanupRef.current = cleanup
  }

  const resetHeight = () => setHeight(null)

  const handleResizeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const base = composerRef.current?.getBoundingClientRect().height
      ?? height ?? MIN_COMPOSER_HEIGHT
    let next: number | null
    if (event.key === 'ArrowUp') next = base + 8
    else if (event.key === 'ArrowDown') next = base - 8
    else if (event.key === 'Escape' || event.key === 'Home') next = null
    else return
    event.preventDefault()
    setHeight(next === null ? null : clampHeight(next))
  }

  return { rootRef, composerRef, composerInnerRef, height, startResize, resetHeight, handleResizeKey }
}

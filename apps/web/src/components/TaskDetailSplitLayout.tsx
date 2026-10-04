import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'

const STORAGE_KEY = 'workstep:task-detail-split-ratio'
const HANDLE_WIDTH = 8

interface Props {
  mobileTab: 'conversation' | 'steps' | 'artifacts'
  left: ReactNode
  right: ReactNode
  artifacts?: ReactNode
}

/** Owns the draggable task detail columns and their session-persisted ratio. */
export default function TaskDetailSplitLayout({ mobileTab, left, right, artifacts }: Props) {
  const contentRef = useRef<HTMLDivElement>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const [ratio, setRatio] = useState(() => {
    try {
      const stored = Number(sessionStorage.getItem(STORAGE_KEY))
      if (Number.isFinite(stored) && stored > 0 && stored < 1) return stored
    } catch {
      /* Session storage can be disabled. */
    }
    return 1 / 3
  })

  const beginResize = useCallback((event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const container = contentRef.current
    if (!container) return
    cleanupRef.current?.()
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = ''

    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      const rect = container.getBoundingClientRect()
      const usableWidth = Math.max(1, rect.width - HANDLE_WIDTH)
      const next = Math.min(0.85, Math.max(0.15, (moveEvent.clientX - rect.left) / usableWidth))
      setRatio(next)
      try {
        sessionStorage.setItem(STORAGE_KEY, String(next))
      } catch {
        /* Session storage can be disabled. */
      }
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      cleanupRef.current = null
    }
    cleanupRef.current = cleanup
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
  }, [])

  useEffect(() => () => cleanupRef.current?.(), [])

  return <div className="task-detail-content" data-mobile-tab={mobileTab} ref={contentRef}
    style={{ gridTemplateColumns: `${ratio}fr ${HANDLE_WIDTH}px ${1 - ratio}fr` }}>
    <div className="task-detail-steps">{left}</div>
    <div className="task-detail-split-handle" onPointerDown={beginResize}>
      <span className="task-detail-split-grip" aria-hidden="true">⋮</span>
    </div>
    <div className="task-detail-conversation">{right}</div>
    {artifacts}
  </div>
}

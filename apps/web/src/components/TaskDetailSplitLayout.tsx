import { useCompactLayout } from '../hooks/useCompactLayout'
import { resolvedSkinLayout } from '../skins/contract'
import { useActiveSkin, SKIN_EVENT } from '../skins/runtime'
import { useCallback, useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'

const STORAGE_KEY = 'workstep:task-detail-split-ratio'

interface Props {
  mobileTab: 'conversation' | 'steps' | 'artifacts'
  left: ReactNode
  right: ReactNode
  artifacts?: ReactNode
}

/** Owns the draggable task detail columns and their session-persisted ratio. */
export default function TaskDetailSplitLayout({ mobileTab, left, right, artifacts }: Props) {
  const skin = useActiveSkin()
  const compact = useCompactLayout()
  const layout = resolvedSkinLayout(skin, compact)
  const handleWidth = layout.splitHandleWidth
  const manual = useRef(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const [ratio, setRatio] = useState(() => {
    try {
      const stored = Number(sessionStorage.getItem(STORAGE_KEY))
      if (Number.isFinite(stored) && stored > 0 && stored < 1) { manual.current = true; return Math.min(.85, Math.max(.15, stored)) }
    } catch {
      /* Session storage can be disabled. */
    }
    return layout.stepsRatio
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
    document.body.style.userSelect = 'none'

    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      const rect = container.getBoundingClientRect()
      const usableWidth = Math.max(1, rect.width - handleWidth)
      const position = Math.min(0.85, Math.max(0.15, (moveEvent.clientX - rect.left) / usableWidth))
      const next = layout.stepsSide === 'right' ? 1 - position : position
      manual.current = true
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
  }, [handleWidth, layout.stepsSide])

  useEffect(() => { if (!manual.current) setRatio(layout.stepsRatio) }, [layout.stepsRatio])
  useEffect(() => {
    const stop = () => cleanupRef.current?.()
    window.addEventListener(SKIN_EVENT, stop)
    return () => { stop(); window.removeEventListener(SKIN_EVENT, stop) }
  }, [])

  useEffect(() => () => cleanupRef.current?.(), [])

  return <div className="task-detail-content" data-mobile-tab={mobileTab} ref={contentRef}
    style={{ gridTemplateColumns: `${layout.stepsSide === 'right' ? 1 - ratio : ratio}fr ${handleWidth}px ${layout.stepsSide === 'right' ? ratio : 1 - ratio}fr` }}>
    <div className="task-detail-steps">{left}</div>
    <div className="task-detail-split-handle" role="separator" aria-orientation="vertical" tabIndex={0}
      aria-valuemin={15} aria-valuemax={85} aria-valuenow={Math.round(ratio * 100)}
      onPointerDown={beginResize} onKeyDown={event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault(); cleanupRef.current?.(); manual.current = true
        const direction = (event.key === 'ArrowLeft' ? -1 : 1) * (layout.stepsSide === 'right' ? -1 : 1)
        const next = Math.min(.85, Math.max(.15, ratio + direction * .02))
        setRatio(next)
        try { sessionStorage.setItem(STORAGE_KEY, String(next)) } catch { /* Optional preference. */ }
      }}>
      <span className="task-detail-split-grip" aria-hidden="true">⋮</span>
    </div>
    <div className="task-detail-conversation">{right}</div>
    {artifacts}
  </div>
}

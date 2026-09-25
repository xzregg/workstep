import {
  useEffect, useRef, useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { useI18n, type TKey } from '../i18n'
import { useCompactLayout } from '../hooks/useCompactLayout'
import { useOverlay } from '../hooks/useOverlay'

interface PanelBounds {
  x: number
  y: number
  width: number
  height: number
}

type ResizeEdge = 'n' | 'e' | 's' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
type HeaderHandlers = {
  onHeaderPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void
  onHeaderKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void
  onHeaderDoubleClick?: () => void
}

interface Props {
  title: string
  onClose: () => void
  children: (handlers: HeaderHandlers) => ReactNode
}

const PANEL_BOUNDS_KEY = 'workstep:task-detail-bounds'
const RESIZE_EDGES: ResizeEdge[] = ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw']
const RESIZE_LABEL_KEYS: Record<ResizeEdge, TKey> = {
  n: 'taskDetail.resize.n',
  e: 'taskDetail.resize.e',
  s: 'taskDetail.resize.s',
  w: 'taskDetail.resize.w',
  ne: 'taskDetail.resize.ne',
  nw: 'taskDetail.resize.nw',
  se: 'taskDetail.resize.se',
  sw: 'taskDetail.resize.sw',
}

function panelMinimums() {
  return {
    width: Math.min(640, Math.max(320, window.innerWidth - 24)),
    height: Math.min(420, Math.max(280, window.innerHeight - 24)),
  }
}

function clampPanelBounds(bounds: PanelBounds): PanelBounds {
  const minimums = panelMinimums()
  const width = Math.min(window.innerWidth, Math.max(minimums.width, bounds.width))
  const height = Math.min(window.innerHeight, Math.max(minimums.height, bounds.height))
  return {
    width,
    height,
    x: Math.min(Math.max(0, bounds.x), Math.max(0, window.innerWidth - width)),
    y: Math.min(Math.max(0, bounds.y), Math.max(0, window.innerHeight - height)),
  }
}

function defaultPanelBounds(): PanelBounds {
  const width = Math.min(1200, window.innerWidth * 0.85)
  return clampPanelBounds({
    width,
    height: window.innerHeight,
    x: Math.max(0, window.innerWidth - width),
    y: 0,
  })
}

function initialPanelBounds(): PanelBounds {
  const fallback = defaultPanelBounds()
  try {
    const saved = sessionStorage.getItem(PANEL_BOUNDS_KEY)
    if (!saved) return fallback
    const parsed = JSON.parse(saved) as Partial<PanelBounds>
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)
      || !Number.isFinite(parsed.width) || !Number.isFinite(parsed.height)) return fallback
    return window.innerWidth < 1024 ? parsed as PanelBounds : clampPanelBounds(parsed as PanelBounds)
  } catch {
    return fallback
  }
}

function resizePanelBounds(start: PanelBounds, edge: ResizeEdge, deltaX: number, deltaY: number): PanelBounds {
  const minimums = panelMinimums()
  let { x, y, width, height } = start
  if (edge.includes('w')) {
    const right = start.x + start.width
    x = Math.min(Math.max(0, start.x + deltaX), right - minimums.width)
    width = right - x
  }
  if (edge.includes('e')) {
    width = Math.min(Math.max(minimums.width, start.width + deltaX), window.innerWidth - start.x)
  }
  if (edge.includes('n')) {
    const bottom = start.y + start.height
    y = Math.min(Math.max(0, start.y + deltaY), bottom - minimums.height)
    height = bottom - y
  }
  if (edge.includes('s')) {
    height = Math.min(Math.max(minimums.height, start.height + deltaY), window.innerHeight - start.y)
  }
  return clampPanelBounds({ x, y, width, height })
}

/** Owns task dialog bounds, pointer and keyboard movement, resize, and persistence. */
export default function TaskDetailWindow({ title, onClose, children }: Props) {
  const { t } = useI18n()
  const compact = useCompactLayout()
  const dialogRef = useRef<HTMLDivElement>(null)
  useOverlay(compact, onClose, dialogRef, false)
  const [panelBounds, setPanelBounds] = useState(initialPanelBounds)
  const interactionCleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!compact) sessionStorage.setItem(PANEL_BOUNDS_KEY, JSON.stringify(panelBounds))
  }, [panelBounds, compact])

  useEffect(() => {
    const handleViewportResize = () => {
      if (window.innerWidth >= 1024) setPanelBounds((current) => clampPanelBounds(current))
    }
    window.addEventListener('resize', handleViewportResize)
    return () => window.removeEventListener('resize', handleViewportResize)
  }, [])

  useEffect(() => () => interactionCleanupRef.current?.(), [])

  const beginPanelResize = (edge: ResizeEdge, event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const startPointer = { x: event.clientX, y: event.clientY }
    const startBounds = panelBounds
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = getComputedStyle(event.currentTarget).cursor
    document.body.style.userSelect = ''
    const handleMove = (moveEvent: PointerEvent) => {
      setPanelBounds(resizePanelBounds(
        startBounds, edge, moveEvent.clientX - startPointer.x, moveEvent.clientY - startPointer.y,
      ))
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      interactionCleanupRef.current = null
    }
    interactionCleanupRef.current?.()
    interactionCleanupRef.current = cleanup
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
  }

  const resizeWithKeyboard = (edge: ResizeEdge, event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 40 : 12
    const deltaX = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
    const deltaY = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
    if (deltaX === 0 && deltaY === 0) return
    event.preventDefault()
    setPanelBounds((current) => resizePanelBounds(current, edge, deltaX, deltaY))
  }

  const beginPanelMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button, input, textarea, select, a, .task-detail-title')) return
    event.preventDefault()
    const startPointer = { x: event.clientX, y: event.clientY }
    const startBounds = panelBounds
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'move'
    document.body.style.userSelect = ''
    const handleMove = (moveEvent: PointerEvent) => {
      setPanelBounds(clampPanelBounds({
        ...startBounds,
        x: startBounds.x + moveEvent.clientX - startPointer.x,
        y: startBounds.y + moveEvent.clientY - startPointer.y,
      }))
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      interactionCleanupRef.current = null
    }
    interactionCleanupRef.current?.()
    interactionCleanupRef.current = cleanup
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
  }

  const moveWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 40 : 12
    const deltaX = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
    const deltaY = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
    if (deltaX === 0 && deltaY === 0) return
    event.preventDefault()
    setPanelBounds((current) => clampPanelBounds({ ...current, x: current.x + deltaX, y: current.y + deltaY }))
  }

  const handlers: HeaderHandlers = compact ? {} : {
    onHeaderPointerDown: beginPanelMove,
    onHeaderKeyDown: moveWithKeyboard,
    onHeaderDoubleClick: () => setPanelBounds(defaultPanelBounds()),
  }

  return <div ref={dialogRef} className="task-detail-window" role="dialog" aria-modal="true"
    aria-label={t('taskDetail.dialogAria', { title })}
    style={{ left: panelBounds.x, top: panelBounds.y,
      width: panelBounds.width, height: panelBounds.height } as CSSProperties}>
    {!compact && RESIZE_EDGES.map((edge) => <div key={edge} role="separator" tabIndex={0}
      aria-label={t(RESIZE_LABEL_KEYS[edge])}
      className={`task-detail-resize-handle task-detail-resize-${edge}`}
      onPointerDown={(event) => beginPanelResize(edge, event)}
      onKeyDown={(event) => resizeWithKeyboard(edge, event)} />)}
    {children(handlers)}
  </div>
}

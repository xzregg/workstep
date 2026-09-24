import { forwardRef, useEffect, useRef, useState, type ComponentPropsWithRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useCompactLayout } from '../hooks/useCompactLayout'
import { useI18n } from '../i18n'

type Edge = 'n' | 'e' | 's' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
type Bounds = { x: number; y: number; width: number; height: number }
const EDGES: Edge[] = ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw']
const LABELS = {
  n: 'taskDetail.resize.n', e: 'taskDetail.resize.e',
  s: 'taskDetail.resize.s', w: 'taskDetail.resize.w',
  ne: 'taskDetail.resize.ne', nw: 'taskDetail.resize.nw',
  se: 'taskDetail.resize.se', sw: 'taskDetail.resize.sw',
} as const
const DRAG_TARGET = '[data-dialog-drag-handle], .modal-header, .dialog-header, .file-preview-dialog-header, .schedule-header, header'
const INTERACTIVE_TARGET = 'button, input, textarea, select, a, [role="button"], [contenteditable="true"], [data-dialog-selectable-text]'

function clamp(bounds: Bounds): Bounds {
  const width = Math.min(bounds.width, window.innerWidth)
  const height = Math.min(bounds.height, window.innerHeight)
  return {
    x: Math.min(Math.max(0, bounds.x), window.innerWidth - width),
    y: Math.min(Math.max(0, bounds.y), window.innerHeight - height),
    width, height,
  }
}

function resized(start: Bounds, edge: Edge, dx: number, dy: number, minWidth: number, minHeight: number): Bounds {
  const minimumWidth = Math.min(minWidth, window.innerWidth - 16)
  const minimumHeight = Math.min(minHeight, window.innerHeight - 16)
  let { x, y, width, height } = start
  if (edge.includes('w')) {
    const right = start.x + start.width
    x = Math.min(Math.max(0, start.x + dx), right - minimumWidth)
    width = right - x
  }
  if (edge.includes('e')) width = Math.min(Math.max(minimumWidth, start.width + dx), window.innerWidth - start.x)
  if (edge.includes('n')) {
    const bottom = start.y + start.height
    y = Math.min(Math.max(0, start.y + dy), bottom - minimumHeight)
    height = bottom - y
  }
  if (edge.includes('s')) height = Math.min(Math.max(minimumHeight, start.height + dy), window.innerHeight - start.y)
  return { x, y, width, height }
}

interface Props extends Omit<ComponentPropsWithRef<'div'>, 'ref'> {
  minWidth?: number
  minHeight?: number
}

/** Eight desktop resize handles for window-style dialogs. The original layout is restored on compact screens. */
const ResizablePanel = forwardRef<HTMLDivElement, Props>(function ResizablePanel(
  { children, className, style, minWidth = 280, minHeight = 160, onPointerDown, onKeyDown, ...rest }, forwardedRef,
) {
  const { t } = useI18n()
  const compact = useCompactLayout()
  const panelRef = useRef<HTMLDivElement>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const [bounds, setBounds] = useState<Bounds | null>(null)
  const [hasResized, setHasResized] = useState(false)

  useEffect(() => {
    const onResize = () => setBounds((current) => current ? clamp(current) : null)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      cleanupRef.current?.()
    }
  }, [])

  const currentBounds = (): Bounds => {
    if (bounds) return bounds
    const rect = panelRef.current?.getBoundingClientRect()
    if (rect?.width && rect?.height) return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
    const width = Math.min(parseFloat(String(style?.width)) || 440, window.innerWidth - 32)
    const height = Math.min(parseFloat(String(style?.height)) || 320, window.innerHeight - 32)
    return { x: (window.innerWidth - width) / 2, y: (window.innerHeight - height) / 2, width, height }
  }

  const startResize = (edge: Edge, event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const start = currentBounds()
    const pointer = { x: event.clientX, y: event.clientY }
    const cursor = document.body.style.cursor
    const userSelect = document.body.style.userSelect
    document.body.style.cursor = getComputedStyle(event.currentTarget).cursor
    document.body.style.userSelect = 'none'
    const move = (next: PointerEvent) => {
      setHasResized(true)
      setBounds(resized(start, edge, next.clientX - pointer.x, next.clientY - pointer.y, minWidth, minHeight))
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      document.body.style.cursor = cursor
      document.body.style.userSelect = userSelect
      cleanupRef.current = null
    }
    cleanupRef.current?.()
    cleanupRef.current = cleanup
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
  }

  const resizeWithKeyboard = (edge: Edge, event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 40 : 12
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
    if (!dx && !dy) return
    event.preventDefault()
    setHasResized(true)
    setBounds(resized(currentBounds(), edge, dx, dy, minWidth, minHeight))
  }

  const startMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (compact || event.button !== 0) return
    const target = event.target as HTMLElement
    const handle = target.closest<HTMLElement>(DRAG_TARGET)
    const directHeader = handle?.parentElement === panelRef.current
    const scheduleHeader = handle?.classList.contains('schedule-header') && handle.parentElement?.parentElement === panelRef.current
    if (!directHeader && !scheduleHeader) return
    if (target !== handle && target.closest(INTERACTIVE_TARGET)) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const start = currentBounds()
    const pointer = { x: event.clientX, y: event.clientY }
    const cursor = document.body.style.cursor
    const userSelect = document.body.style.userSelect
    document.body.style.cursor = 'move'
    document.body.style.userSelect = 'none'
    const move = (next: PointerEvent) => setBounds(clamp({
      ...start,
      x: start.x + next.clientX - pointer.x,
      y: start.y + next.clientY - pointer.y,
    }))
    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      document.body.style.cursor = cursor
      document.body.style.userSelect = userSelect
      cleanupRef.current = null
    }
    cleanupRef.current?.()
    cleanupRef.current = cleanup
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
  }

  const moveWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (compact || !(event.target as HTMLElement).matches('[data-dialog-drag-handle]')) return
    const step = event.shiftKey ? 40 : 12
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
    if (!dx && !dy) return
    event.preventDefault()
    const start = currentBounds()
    setBounds(clamp({ ...start, x: start.x + dx, y: start.y + dy }))
  }

  return <div
    {...rest}
    ref={(node) => {
      panelRef.current = node
      if (typeof forwardedRef === 'function') forwardedRef(node)
      else if (forwardedRef) forwardedRef.current = node
    }}
    className={`${className || ''} resizable-panel`}
    data-resized={!compact && hasResized ? true : undefined}
    onPointerDown={(event) => { onPointerDown?.(event); if (!event.defaultPrevented) startMove(event) }}
    onKeyDown={(event) => { onKeyDown?.(event); if (!event.defaultPrevented) moveWithKeyboard(event) }}
    style={{ ...style, ...(!compact && bounds ? { position: 'fixed' as const, left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height, maxWidth: 'none', maxHeight: 'none' } : {}) }}
  >
    {!compact && EDGES.map((edge) => <div
      key={edge}
      className={`resizable-panel-handle resizable-panel-${edge}`}
      role="separator"
      tabIndex={0}
      aria-label={t(LABELS[edge])}
      onPointerDown={(event) => startResize(edge, event)}
      onKeyDown={(event) => resizeWithKeyboard(edge, event)}
    />)}
    {children}
  </div>
})

export default ResizablePanel

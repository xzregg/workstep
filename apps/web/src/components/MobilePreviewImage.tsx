import { useEffect, useRef, useState, type PointerEvent } from 'react'

type Point = { x: number; y: number }
type View = Point & { scale: number }
const INITIAL: View = { x: 0, y: 0, scale: 1 }

/** Touch gestures stay inside the image; the close button and toolbar never scale. */
export default function MobilePreviewImage({ src, alt }: { src: string; alt: string }) {
  const viewport = useRef<HTMLDivElement>(null)
  const pointers = useRef(new Map<number, Point>())
  const current = useRef(INITIAL)
  const [view, setView] = useState(INITIAL)
  const tap = useRef<{ point: Point; time: number } | null>(null)
  const lastTouch = useRef(0)
  const start = useRef<{ point: Point; time: number; moved: boolean } | null>(null)

  const apply = (next: View) => {
    const rect = viewport.current!.getBoundingClientRect()
    const scale = Math.min(5, Math.max(1, next.scale))
    const limitX = rect.width * (scale - 1) / 2
    const limitY = rect.height * (scale - 1) / 2
    current.current = { scale, x: Math.max(-limitX, Math.min(limitX, next.x)), y: Math.max(-limitY, Math.min(limitY, next.y)) }
    setView(current.current)
  }

  useEffect(() => {
    const reset = () => {
      pointers.current.clear()
      tap.current = null
      start.current = null
      current.current = INITIAL
      setView(INITIAL)
    }
    reset()
    window.addEventListener('resize', reset)
    return () => window.removeEventListener('resize', reset)
  }, [src])

  const toggleZoom = (point: Point) => {
    if (current.current.scale > 1) { apply(INITIAL); return }
    const rect = viewport.current!.getBoundingClientRect()
    apply({ scale: 2, x: rect.left + rect.width / 2 - point.x, y: rect.top + rect.height / 2 - point.y })
  }

  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    if (event.pointerType !== 'mouse') lastTouch.current = Date.now()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const point = { x: event.clientX, y: event.clientY }
    pointers.current.set(event.pointerId, point)
    start.current = { point, time: Date.now(), moved: pointers.current.size > 1 }
    if (pointers.current.size > 1) tap.current = null
  }

  const move = (event: PointerEvent<HTMLDivElement>) => {
    const previous = pointers.current.get(event.pointerId)
    if (!previous) return
    const next = { x: event.clientX, y: event.clientY }
    if (start.current && Math.hypot(next.x - start.current.point.x, next.y - start.current.point.y) > 8) start.current.moved = true
    const other = [...pointers.current.entries()].find(([id]) => id !== event.pointerId)?.[1]
    const old = current.current
    if (other) {
      const distance = Math.hypot(previous.x - other.x, previous.y - other.y)
      if (distance > 0) {
        const scale = Math.min(5, Math.max(1, old.scale * Math.hypot(next.x - other.x, next.y - other.y) / distance))
        const ratio = scale / old.scale
        const rect = viewport.current!.getBoundingClientRect()
        const anchorX = (previous.x + other.x) / 2 - rect.left - rect.width / 2
        const anchorY = (previous.y + other.y) / 2 - rect.top - rect.height / 2
        apply({ scale, x: anchorX + (old.x - anchorX) * ratio + (next.x - previous.x) / 2,
          y: anchorY + (old.y - anchorY) * ratio + (next.y - previous.y) / 2 })
      }
    } else if (old.scale > 1) {
      apply({ ...old, x: old.x + next.x - previous.x, y: old.y + next.y - previous.y })
    }
    pointers.current.set(event.pointerId, next)
  }

  const end = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return
    const gesture = start.current
    if (event.type === 'pointerup' && event.pointerType !== 'mouse' && gesture && !gesture.moved && Date.now() - gesture.time < 300) {
      const point = { x: event.clientX, y: event.clientY }
      const last = tap.current
      if (last && Date.now() - last.time < 300 && Math.hypot(point.x - last.point.x, point.y - last.point.y) < 24) {
        toggleZoom(point)
        tap.current = null
      } else tap.current = { point, time: Date.now() }
    } else tap.current = null
    // A finger lifted after pinching must not become a tap.
    if (gesture) gesture.moved = true
  }

  return <div ref={viewport} className="image-preview-viewport"
    onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
    onLostPointerCapture={end}
    onDoubleClick={event => { if (Date.now() - lastTouch.current > 500) toggleZoom({ x: event.clientX, y: event.clientY }) }}>
    <img src={src} alt={alt} draggable={false} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }} />
  </div>
}

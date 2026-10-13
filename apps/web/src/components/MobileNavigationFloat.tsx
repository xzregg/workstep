import { useEffect, useRef, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../i18n'
import Icon from './Icon'
import './MobileNavigationFloat.css'

type Position = { left: number; top: number }

export default function MobileNavigationFloat({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = useI18n()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const position = useRef<Position | null>(null)
  const frame = useRef<number | null>(null)
  const size = useRef({ width: 44, height: 44 })
  const gesture = useRef<{ id: number; x: number; y: number; start: Position; moved: boolean; active: boolean } | null>(null)

  const clamp = (next: Position) => {
    const width = window.visualViewport?.width ?? window.innerWidth
    const height = window.visualViewport?.height ?? window.innerHeight
    return {
      left: Math.max(8, Math.min(next.left, width - size.current.width - 8)),
      top: Math.max(8, Math.min(next.top, height - size.current.height - 8)),
    }
  }

  const paint = () => {
    frame.current = null
    const button = buttonRef.current
    if (!button || !position.current) return
    button.style.setProperty('--float-x', `${position.current.left}px`)
    button.style.setProperty('--float-y', `${position.current.top}px`)
    button.dataset.positioned = 'true'
  }

  const flush = () => {
    if (frame.current !== null) window.cancelAnimationFrame(frame.current)
    paint()
  }

  useEffect(() => {
    const resize = () => {
      if (!position.current) return
      position.current = clamp(position.current)
      flush()
    }
    window.addEventListener('resize', resize)
    window.visualViewport?.addEventListener('resize', resize)
    return () => {
      if (frame.current !== null) window.cancelAnimationFrame(frame.current)
      window.removeEventListener('resize', resize)
      window.visualViewport?.removeEventListener('resize', resize)
    }
  }, [])

  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const current = gesture.current
    if (!current?.active || current.id !== event.pointerId) return
    const dx = event.clientX - current.x
    const dy = event.clientY - current.y
    if (!current.moved && Math.hypot(dx, dy) < 6) return
    current.moved = true
    position.current = clamp({ left: current.start.left + dx, top: current.start.top + dy })
    if (frame.current === null) frame.current = window.requestAnimationFrame(paint)
  }

  return createPortal(<button ref={buttonRef} type="button" className="mobile-navigation-float"
    aria-label={t(open ? 'common.close' : 'mobile.openNavigation')} aria-expanded={open} aria-controls="workstep-navigation"
    onClick={event => { if (event.detail === 0 || !gesture.current?.moved) onToggle() }}
    onPointerDown={event => {
      if (!event.isPrimary || event.button !== 0) return
      const rect = event.currentTarget.getBoundingClientRect()
      size.current = { width: rect.width || 44, height: rect.height || 44 }
      gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, start: { left: rect.left, top: rect.top }, moved: false, active: true }
      event.currentTarget.setPointerCapture?.(event.pointerId)
    }}
    onPointerMove={move}
    onPointerUp={event => {
      if (gesture.current?.id !== event.pointerId) return
      gesture.current.active = false
      flush()
      event.currentTarget.releasePointerCapture?.(event.pointerId)
    }}
    onPointerCancel={() => {
      if (gesture.current) { gesture.current.active = false; gesture.current.moved = true }
      flush()
    }}>
    <Icon name="ellipsis" size={20} className="mobile-navigation-float-icon"/>
  </button>, document.body)
}

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

/** Keep Git forms outside the workspace's scrolling/clipping containers. */
export default function GitActionPanel({ anchor, label, onClose, children }: {
  anchor: RefObject<HTMLSpanElement | null>
  label: string
  onClose: () => void
  children: ReactNode
}) {
  const panel = useRef<HTMLSpanElement>(null)
  const [position, setPosition] = useState({ left: 16, top: 16 })

  useEffect(() => {
    const measure = () => {
      const trigger = anchor.current?.getBoundingClientRect()
      const bounds = panel.current?.getBoundingClientRect()
      if (!trigger || !bounds) return
      const below = trigger.bottom + 8
      const top = below + bounds.height <= window.innerHeight - 16 ? below : trigger.top - bounds.height - 8
      setPosition({
        left: Math.max(16, Math.min(trigger.right - bounds.width, window.innerWidth - bounds.width - 16)),
        top: Math.max(16, Math.min(top, window.innerHeight - bounds.height - 16)),
      })
    }
    const close = (event: MouseEvent) => {
      const target = event.target as Node
      if (anchor.current?.contains(target) || panel.current?.contains(target)) return
      // Skinned selects render their options in a separate portal.
      if (target instanceof Element && target.closest('.skin-select-panel, .skin-select-backdrop, .mobile-sheet-backdrop')) return
      onClose()
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    measure()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    if (panel.current) observer?.observe(panel.current)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [anchor, children, onClose])

  return createPortal(<span ref={panel} className="git-remote-panel" role="dialog" aria-label={label} style={position}>{children}</span>, document.body)
}

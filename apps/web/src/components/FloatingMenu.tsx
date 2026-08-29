import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import Icon from './Icon'

/* ══════════════════════════════════════════
   FloatingMenu — Codex-style option menu.

   Anchored to the trigger button's bounding rect and opens to the right of
   it (flipping when it would overflow the viewport). Positioned with
   `position: fixed` and rendered through a portal into <body> so it never
   gets clipped by overflowing containers (e.g. the ChatInput config
   popover). Used by the engine/model picker and the permission selector.
   ══════════════════════════════════════════ */

export interface FloatingMenuOption {
  value: string
  label: string
  description?: string
  disabled?: boolean
}

export interface AnchorRect {
  left: number
  top: number
  width: number
  height: number
}

export interface FloatingMenuProps {
  anchor: AnchorRect
  options: FloatingMenuOption[]
  value: string
  onSelect: (value: string) => void
  onClose: () => void
  /** Trigger button: clicks on it do not close the menu (toggle handled by the caller). */
  triggerRef?: RefObject<HTMLElement | null>
  /** Which way the menu opens from the trigger: right (default) or above. */
  side?: 'right' | 'top'
  /** Called with true/false while the pointer enters/leaves the menu (hover flyouts). */
  onHoverChange?: (hovering: boolean) => void
  icon?: 'terminal' | 'sparkles' | 'sliders-horizontal' | 'image' | 'shield'
  width?: number
  title?: string
}

export function useFloatingMenu() {
  const [anchor, setAnchor] = useState<AnchorRect | null>(null)
  const openFrom = (element: HTMLElement | null) => {
    if (!element) return
    const rect = element.getBoundingClientRect()
    setAnchor({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
  }
  const close = () => setAnchor(null)
  return { anchor, openFrom, close }
}

export default function FloatingMenu({
  anchor,
  options,
  value,
  onSelect,
  onClose,
  triggerRef,
  side = 'right',
  onHoverChange,
  icon,
  width = 240,
  title,
}: FloatingMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const menuWidth = menu.offsetWidth || width
    const menuHeight = menu.offsetHeight || options.length * 32 + 12
    const gutter = 8
    let left: number
    let top: number
    if (side === 'top') {
      // Open above the trigger, right-aligned with its right edge.
      left = anchor.left + anchor.width - menuWidth
      if (left < gutter) left = Math.max(gutter, anchor.left)
      if (left + menuWidth > window.innerWidth - gutter) {
        left = Math.max(gutter, window.innerWidth - menuWidth - gutter)
      }
      top = anchor.top - menuHeight - 6
      if (top < gutter) top = anchor.top + anchor.height + 6
    } else {
      // Open to the right of the trigger; when that would overflow the
      // viewport, open to its left instead (kept adjacent, never covering
      // the trigger/panel).
      left = anchor.left + anchor.width + 6
      if (left + menuWidth > window.innerWidth - gutter) {
        left = anchor.left - menuWidth - 6
        if (left < gutter) left = Math.max(gutter, window.innerWidth - menuWidth - gutter)
      }
      top = anchor.top
      if (top + menuHeight > window.innerHeight - gutter) {
        top = Math.max(gutter, window.innerHeight - menuHeight - gutter)
      }
    }
    setPosition({ left, top })
  }, [anchor, options.length, width, side])

  useLayoutEffect(() => {
    const closeOnOutside = (event: globalThis.MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      if (triggerRef?.current?.contains(event.target as Node)) return
      onClose()
    }
    window.addEventListener('mousedown', closeOnOutside)
    window.addEventListener('resize', onClose)
    window.addEventListener('scroll', onClose, true)
    return () => {
      window.removeEventListener('mousedown', closeOnOutside)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [onClose, triggerRef])

  return createPortal(
    <div
      ref={menuRef}
      className="chat-input-menu"
      role="dialog"
      style={{
        position: 'fixed', left: position.left, top: position.top, zIndex: 1450, width,
        transformOrigin: side === 'top' ? 'bottom right' : 'top left',
      }}
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
    >
      {title && <div className="chat-input-menu-label">{title}</div>}
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            className="chat-input-menu-item"
            data-selected={selected}
            disabled={option.disabled}
            onClick={() => {
              onSelect(option.value)
              onClose()
            }}
            style={{
              height: 'auto', minHeight: 30, paddingTop: 5, paddingBottom: 5,
              opacity: option.disabled ? 0.5 : 1,
              cursor: option.disabled ? 'not-allowed' : 'pointer',
            }}
          >
            {icon && (
              <span className="chat-input-menu-icon">
                <Icon name={icon} size={13} strokeWidth={1.8} />
              </span>
            )}
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {option.label}
              </span>
              {option.description && (
                <span style={{ display: 'block', fontSize: 'calc(10px * var(--font-scale))', color: 'var(--meta)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {option.description}
                </span>
              )}
            </span>
            {selected && (
              <span className="chat-input-menu-check">
                <Icon name="check" size={13} strokeWidth={2.2} />
              </span>
            )}
          </button>
        )
      })}
    </div>,
    document.body,
  )
}

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

/** Native popover keeps row actions above the horizontal table scroll container. */
export function AdminRowMenu({ label = '更多操作', triggerLabel = '更多操作', children }: { label?: string; triggerLabel?: string; children: ReactNode }) {
  const id = useId()
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({left:0,top:0})
  function close() { menu.current?.hidePopover?.(); setOpen(false) }
  function toggle() {
    if (open) { close(); return }
    const rect = anchor.current!.getBoundingClientRect()
    setPosition({ left:Math.max(8,Math.min(rect.right-220,window.innerWidth-228)),
      top:Math.max(8,Math.min(rect.bottom+4,window.innerHeight-320)) })
    setOpen(true)
  }
  useEffect(() => {
    if (!open) return
    menu.current?.showPopover?.()
    function dismiss(event: Event) {
      if (!menu.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) close()
    }
    document.addEventListener('pointerdown',dismiss)
    return () => document.removeEventListener('pointerdown',dismiss)
  },[open])
  return <><button ref={anchor} type="button" aria-label={label} aria-expanded={open} aria-controls={id} onClick={toggle}>{triggerLabel}</button>
    <div ref={menu} id={id} popover="auto" hidden={!open} className="gateway-admin-row-menu" role="group" aria-label={label} style={position}
      onToggle={event => { if ((event.nativeEvent as ToggleEvent).newState === 'closed') setOpen(false) }}
      onKeyDown={event => { if (event.key === 'Escape') { close(); anchor.current?.focus() } }}
      onClickCapture={event => { if ((event.target as HTMLElement).closest('button')) close() }}>{children}</div>
  </>
}

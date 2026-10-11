import { useCompactLayout } from './useCompactLayout'
import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { resolvedSkinLayout } from '../skins/contract'
import { SKIN_EVENT, useActiveSkin } from '../skins/runtime'

const clamp = (width: number) => Math.min(480, Math.max(180, width))
const KEY = 'workstep.sidebar-width'
export function useSkinSidebar() {
  const compact = useCompactLayout()
  const skin = useActiveSkin(), layout = resolvedSkinLayout(skin, compact)
  const manual = useRef(false), cleanup = useRef<(() => void) | null>(null)
  const [width, setWidth] = useState(() => {
    try { const stored = Number(sessionStorage.getItem(KEY)); if (stored >= 180 && stored <= 480) { manual.current = true; return stored } } catch { /* Optional preference. */ }
    return layout.sidebarWidth
  })
  useEffect(() => { if (!manual.current) setWidth(layout.sidebarWidth) }, [layout.sidebarWidth])
  useEffect(() => {
    const stop = () => cleanup.current?.()
    window.addEventListener(SKIN_EVENT, stop)
    return () => { stop(); window.removeEventListener(SKIN_EVENT, stop) }
  }, [])
  const update = (next: number) => {
    manual.current = true; const value = clamp(next); setWidth(value)
    try { sessionStorage.setItem(KEY, String(value)) } catch { /* Optional preference. */ }
  }
  const begin = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault(); cleanup.current?.()
    const startX = event.clientX, startWidth = width
    const previousCursor = document.body.style.cursor, previousSelect = document.body.style.userSelect
    const move = (event: globalThis.PointerEvent) => update(startWidth + (event.clientX - startX) * (layout.sidebarSide === 'right' ? -1 : 1))
    const stop = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop)
      document.body.style.cursor = previousCursor; document.body.style.userSelect = previousSelect; cleanup.current = null
    }
    cleanup.current = stop
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop); window.addEventListener('pointercancel', stop)
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'
  }
  return { width, begin, nudge: (delta: number) => update(width + delta * (layout.sidebarSide === 'right' ? -1 : 1)) }
}

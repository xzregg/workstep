import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

export function clampGitTreeWidth(width: number, viewportWidth = window.innerWidth) {
  return Math.round(Math.min(Math.max(width, 230), Math.max(230, viewportWidth * .42)))
}

export function useGitTreeResize() {
  const [treeWidth, setTreeWidth] = useState(280)
  const resizeStart = useRef<{ x: number; width: number } | null>(null)

  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => {
      if (resizeStart.current) setTreeWidth(clampGitTreeWidth(resizeStart.current.width + event.clientX - resizeStart.current.x))
    }
    const stop = () => { resizeStart.current = null }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop) }
  }, [])

  function startResize(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault()
    resizeStart.current = { x: event.clientX, width: treeWidth }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      setTreeWidth(width => clampGitTreeWidth(width + (event.key === 'ArrowLeft' ? -16 : 16)))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setTreeWidth(230)
    }
  }

  return { treeWidth, startResize, resizeWithKeyboard, resetResize: () => setTreeWidth(280) }
}

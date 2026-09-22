import { useEffect } from 'react'

/** Browser chrome and the on-screen keyboard may shrink the visual viewport. */
export function useVisualViewport() {
  useEffect(() => {
    const viewport = window.visualViewport
    const update = () => {
      // Pinch zoom should not resize the application beneath the user's fingers.
      if (viewport && viewport.scale !== 1) return
      document.documentElement.style.setProperty('--app-viewport-height', `${viewport?.height ?? window.innerHeight}px`)
    }
    update()
    viewport?.addEventListener('resize', update)
    window.addEventListener('resize', update)
    return () => {
      viewport?.removeEventListener('resize', update)
      window.removeEventListener('resize', update)
      document.documentElement.style.removeProperty('--app-viewport-height')
    }
  }, [])
}

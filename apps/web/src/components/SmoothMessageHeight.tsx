import { useLayoutEffect, useRef, type ReactNode } from 'react'

/** Smooth only live height changes; preloaded history always retains native height. */
export default function SmoothMessageHeight({ active, children }: { active: boolean; children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const shell = outer.current, content = inner.current
    if (!shell || !content || !active || typeof ResizeObserver === 'undefined') return
    let height = content.getBoundingClientRect().height
    let target = height, frame = 0, last = 0
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    shell.style.height = `${height}px`
    const tick = (time: number) => {
      frame = 0
      const dt = last ? Math.min(40, time - last) : 16
      last = time
      height += (target - height) * (1 - Math.exp(-dt / 45))
      if (Math.abs(target - height) < 0.25) height = target
      shell.style.height = `${height}px`
      if (height !== target) frame = requestAnimationFrame(tick)
    }
    const observer = new ResizeObserver(() => {
      target = content.getBoundingClientRect().height
      if (target < height || reduced.matches || document.hidden) {
        if (frame) cancelAnimationFrame(frame)
        frame = 0; height = target; shell.style.height = `${height}px`
      } else if (!frame && Math.abs(target - height) >= 0.25) {
        last = 0; frame = requestAnimationFrame(tick)
      }
    })
    observer.observe(content)
    return () => { observer.disconnect(); if (frame) cancelAnimationFrame(frame); shell.style.height = '' }
  }, [active])
  return <div ref={outer} className={`smooth-message-height${active ? ' is-live' : ''}`}><div ref={inner} className="smooth-message-height-content">{children}</div></div>
}

import { useEffect, useRef, useState } from 'react'

export function FlowBackdrop() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(media.matches)
    update(); media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    const element = canvas.current!
    const context = element.getContext('2d')
    if (!context) return
    let width = 0, height = 0, time = 0, last = 0, frame = 0
    let visible = true
    const point = (progress: number, strand: number) => ({
      x: width * (-.1 + progress * 1.2),
      y: height * (.55 + Math.cos((progress - .5) * Math.PI * 2 + time * .12) * .18) + strand * Math.min(5.6, height * .012) + Math.sin(progress * 7 + time * .2) * 5,
    })
    const draw = () => {
      const dark = document.documentElement.dataset.theme === 'dark'
      context.clearRect(0, 0, width, height)
      for (let strand = -18; strand <= 18; strand++) {
        context.beginPath()
        for (let step = 0; step <= 75; step++) {
          const p = point(step / 75, strand)
          if (!step) context.moveTo(p.x, p.y); else context.lineTo(p.x, p.y)
        }
        context.strokeStyle = strand % 7 === 0 ? (dark ? 'rgba(10,132,255,.38)' : 'rgba(0,113,227,.32)') : (dark ? 'rgba(152,152,157,.18)' : 'rgba(110,110,115,.16)')
        context.lineWidth = strand % 7 === 0 ? 1.2 : .75
        context.stroke()
        if (strand % 7 === 0) {
          const p = point(((time * .035 + strand * .032) % 1 + 1) % 1, strand)
          context.beginPath(); context.arc(p.x, p.y, 7, 0, Math.PI * 2)
          context.fillStyle = dark ? 'rgba(10,132,255,.16)' : 'rgba(0,113,227,.10)'; context.fill()
          context.beginPath(); context.arc(p.x, p.y, 2.8, 0, Math.PI * 2)
          context.fillStyle = dark ? 'rgba(10,132,255,.8)' : 'rgba(0,113,227,.85)'; context.fill()
        }
      }
    }
    const animate = (stamp: number) => {
      if (stamp - last > 32) { time += Math.min((stamp - last) / 1000, .05); last = stamp; draw() }
      frame = requestAnimationFrame(animate)
    }
    const sync = () => {
      cancelAnimationFrame(frame); draw()
      if (!reduced && visible && !document.hidden) { last = performance.now(); frame = requestAnimationFrame(animate) }
    }
    const resize = new ResizeObserver(() => {
      const bounds = element.getBoundingClientRect()
      width = bounds.width; height = bounds.height
      const ratio = Math.min(devicePixelRatio || 1, 2)
      element.width = Math.round(width * ratio); element.height = Math.round(height * ratio)
      context.setTransform(ratio, 0, 0, ratio, 0, 0); draw()
    })
    resize.observe(element)
    const intersection = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync() })
    intersection.observe(element)
    const theme = new MutationObserver(draw)
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    document.addEventListener('visibilitychange', sync); sync()
    return () => { cancelAnimationFrame(frame); resize.disconnect(); intersection.disconnect(); theme.disconnect(); document.removeEventListener('visibilitychange', sync) }
  }, [reduced])
  return <canvas className="page-flow" ref={canvas} aria-hidden="true" />
}

import { useEffect, useRef, useState } from 'react'
import { Pause, Play } from 'lucide-react'
import { useI18n } from '../i18n'

export function FlowBackdrop() {
  const { t } = useI18n()
  const canvas = useRef<HTMLCanvasElement>(null)
  const [paused, setPaused] = useState(false)
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
      x: width * (.38 + progress * .8),
      y: height * (.73 - .44 * progress) + Math.sin(progress * Math.PI * 1.18 + strand * .026 + time * .12) * height * .22 + strand * 5.6 + Math.sin(progress * 7 + time * .2) * 5,
    })
    const draw = () => {
      const dark = document.documentElement.dataset.theme === 'dark'
      context.clearRect(0, 0, width, height)
      for (let strand = -15; strand < 22; strand++) {
        context.beginPath()
        for (let step = 0; step <= 75; step++) {
          const p = point(step / 75, strand)
          if (!step) context.moveTo(p.x, p.y); else context.lineTo(p.x, p.y)
        }
        context.strokeStyle = strand % 7 === 0 ? (dark ? 'rgba(10,132,255,.25)' : 'rgba(0,113,227,.19)') : (dark ? 'rgba(152,152,157,.10)' : 'rgba(110,110,115,.15)')
        context.lineWidth = strand % 7 === 0 ? 1 : .6
        context.stroke()
        if (strand % 7 === 0) {
          const p = point(((time * .035 + strand * .032) % 1 + 1) % 1, strand)
          context.beginPath(); context.arc(p.x, p.y, 2, 0, Math.PI * 2)
          context.fillStyle = dark ? 'rgba(10,132,255,.8)' : 'rgba(0,113,227,.65)'; context.fill()
        }
      }
    }
    const animate = (stamp: number) => {
      if (stamp - last > 32) { time += Math.min((stamp - last) / 1000, .05); last = stamp; draw() }
      frame = requestAnimationFrame(animate)
    }
    const sync = () => {
      cancelAnimationFrame(frame); draw()
      if (!paused && !reduced && visible && !document.hidden) { last = performance.now(); frame = requestAnimationFrame(animate) }
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
  }, [paused, reduced])
  return <><canvas className="intro-flow" ref={canvas} aria-hidden="true" /><button type="button" className="intro-motion" aria-pressed={paused || reduced} disabled={reduced} onClick={() => setPaused(value => !value)}>{t(paused || reduced ? 'common.play' : 'common.pause')}{paused || reduced ? <Play size={13} /> : <Pause size={13} />}</button></>
}

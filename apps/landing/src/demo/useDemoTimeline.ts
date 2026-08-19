import { useCallback, useEffect, useRef, useState } from 'react'
import { clamp, stepTime } from './timeline'

export interface DemoTimelineOptions {
  durationMs: number
  autoplay?: boolean
  loop?: boolean
}

export interface DemoTimeline {
  time: number
  durationMs: number
  playing: boolean
  play: () => void
  pause: () => void
  toggle: () => void
  restart: () => void
  seek: (timeMs: number) => void
  progress: number
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function useDemoTimeline({
  durationMs,
  autoplay = true,
  loop = true,
}: DemoTimelineOptions): DemoTimeline {
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(() => autoplay && !prefersReducedMotion())
  const timeRef = useRef(0)
  const anchorRef = useRef(0)
  const startAtRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const loopRef = useRef(loop)
  loopRef.current = loop

  const stopRaf = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  const setTimeBoth = useCallback((next: number) => {
    timeRef.current = next
    setTime(next)
  }, [])

  const tick = useCallback(() => {
    const next = stepTime(
      anchorRef.current,
      performance.now() - startAtRef.current,
      durationMs,
      loopRef.current,
    )
    setTimeBoth(next)
    if (!loopRef.current && next >= durationMs) {
      setPlaying(false)
      return
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [durationMs, setTimeBoth])

  const play = useCallback(() => {
    startAtRef.current = performance.now()
    anchorRef.current = timeRef.current
    setPlaying(true)
    rafRef.current = requestAnimationFrame(tick)
  }, [tick])

  const pause = useCallback(() => {
    const next = stepTime(
      anchorRef.current,
      performance.now() - startAtRef.current,
      durationMs,
      loopRef.current,
    )
    setTimeBoth(next)
    stopRaf()
    setPlaying(false)
  }, [durationMs, setTimeBoth, stopRaf])

  const toggle = useCallback(() => {
    if (playing) {
      pause()
    } else {
      play()
    }
  }, [pause, play, playing])

  const restart = useCallback(() => {
    setTimeBoth(0)
    anchorRef.current = 0
    startAtRef.current = performance.now()
    if (!playing) {
      setPlaying(true)
      rafRef.current = requestAnimationFrame(tick)
    }
  }, [playing, setTimeBoth, tick])

  const seek = useCallback(
    (timeMs: number) => {
      const next = clamp(timeMs, 0, durationMs)
      setTimeBoth(next)
      anchorRef.current = next
      startAtRef.current = performance.now()
    },
    [durationMs, setTimeBoth],
  )

  useEffect(() => {
    if (!playing) return
    startAtRef.current = performance.now()
    anchorRef.current = timeRef.current
    rafRef.current = requestAnimationFrame(tick)
    return stopRaf
  }, [playing, stopRaf, tick])

  useEffect(() => stopRaf, [stopRaf])

  return {
    time,
    durationMs,
    playing,
    play,
    pause,
    toggle,
    restart,
    seek,
    progress: durationMs <= 0 ? 0 : clamp(time / durationMs, 0, 1),
  }
}

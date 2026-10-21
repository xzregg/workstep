import { useCallback, useEffect, useRef, useState } from 'react'
import { getWalkthroughCamera, WALKTHROUGH_DURATION } from './walkthrough'

export function useRecordedWalkthrough() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const cameraRef = useRef<HTMLDivElement>(null)
  const autoAllowed = useRef(true)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(WALKTHROUGH_DURATION)
  const [playing, setPlaying] = useState(false)
  const [failed, setFailed] = useState(false)

  const play = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    autoAllowed.current = true
    if (video.ended) video.currentTime = 0
    void video.play().catch(() => setPlaying(false))
  }, [])
  const toggle = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) play()
    else { autoAllowed.current = false; video.pause() }
  }, [play])
  const seek = useCallback((next: number) => {
    const video = videoRef.current
    if (video && video.readyState >= 1) {
      video.currentTime = Math.min(Number.isFinite(video.duration) ? video.duration : WALKTHROUGH_DURATION, Math.max(0, next))
      setTime(video.currentTime)
    }
  }, [])
  const restart = useCallback(() => { seek(0); play() }, [play, seek])
  const retry = useCallback(() => { setFailed(false); videoRef.current?.load() }, [])

  useEffect(() => {
    const video = videoRef.current, stage = stageRef.current, camera = cameraRef.current
    if (!video || !stage || !camera) return
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const mobile = window.matchMedia('(max-width: 760px)')
    let inView = false, raf = 0, width = 1, height = 1, disposed = false
    const paintCamera = () => {
      const { zoom, x, y } = getWalkthroughCamera(video.currentTime, width, height, mobile.matches, motion.matches)
      camera.style.transform = `matrix(${zoom},0,0,${zoom},${x},${y})`
    }
    const measure = () => { width = stage.clientWidth || 1; height = stage.clientHeight || 1; paintCamera() }
    const sync = () => {
      setTime(video.currentTime)
      setPlaying(!video.paused && !video.ended)
      if (Number.isFinite(video.duration) && video.duration > 0) setDuration(video.duration)
      paintCamera()
    }
    const maybePlay = () => {
      if (inView && !document.hidden && !motion.matches && autoAllowed.current && !video.ended && video.readyState >= 1) {
        void video.play().catch(() => { if (!disposed) setPlaying(false) })
      }
    }
    const tick = () => { paintCamera(); if (!video.paused && !video.ended) raf = requestAnimationFrame(tick) }
    const onPlay = () => { sync(); cancelAnimationFrame(raf); tick() }
    const onPause = () => { cancelAnimationFrame(raf); sync() }
    const onReady = () => { setFailed(false); sync(); maybePlay() }
    const onError = () => { setFailed(true); video.pause() }
    const onVisibility = () => { if (document.hidden) video.pause(); else maybePlay() }
    const onMotion = () => { if (motion.matches) video.pause(); paintCamera() }
    const observer = new IntersectionObserver(entries => {
      inView = entries[0]?.isIntersecting ?? false
      if (inView) maybePlay(); else video.pause()
    }, { threshold: .15 })
    observer.observe(stage)
    const resizeObserver = new ResizeObserver(measure)
    resizeObserver.observe(stage)
    const source = video.querySelector('source')
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('ended', onPause)
    video.addEventListener('timeupdate', sync)
    video.addEventListener('seeked', sync)
    video.addEventListener('loadedmetadata', onReady)
    video.addEventListener('loadeddata', onReady)
    video.addEventListener('error', onError)
    source?.addEventListener('error', onError)
    document.addEventListener('visibilitychange', onVisibility)
    motion.addEventListener('change', onMotion)
    measure(); sync()
    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      observer.disconnect(); resizeObserver.disconnect()
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('ended', onPause)
      video.removeEventListener('timeupdate', sync)
      video.removeEventListener('seeked', sync)
      video.removeEventListener('loadedmetadata', onReady)
      video.removeEventListener('loadeddata', onReady)
      video.removeEventListener('error', onError)
      source?.removeEventListener('error', onError)
      document.removeEventListener('visibilitychange', onVisibility)
      motion.removeEventListener('change', onMotion)
      video.pause()
    }
  }, [])

  return { videoRef, stageRef, cameraRef, time, duration, playing, failed, toggle, restart, seek, retry }
}

import { memo, useLayoutEffect, useRef } from 'react'
import { createRobotAvatarAnimator, robotCurve, robotFaces } from '../utils/robotAvatarMotion'
import type { RobotAvatarState } from '../utils/robotAvatarState'
import './RobotAvatar.css'

/** Decorative identity; the message's existing metadata announces its status. */
const RobotAvatar = memo(function RobotAvatar({ state }: { state: RobotAvatarState }) {
  const svgRef = useRef<SVGSVGElement>(null)
  const initialState = useRef(state)
  const animator = useRef<ReturnType<typeof createRobotAvatarAnimator> | null>(null)
  useLayoutEffect(() => {
    const svg = svgRef.current!
    const motion = createRobotAvatarAnimator(svg, initialState.current)
    animator.current = motion
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    let inView = !('IntersectionObserver' in window)
    const sync = () => motion.setPlayback(inView && !document.hidden, preference.matches)
    const observer = 'IntersectionObserver' in window ? new window.IntersectionObserver(entries => {
      inView = entries.some(entry => entry.isIntersecting)
      sync()
    }) : null
    observer?.observe(svg)
    preference.addEventListener('change', sync)
    document.addEventListener('visibilitychange', sync)
    sync()
    return () => {
      observer?.disconnect()
      preference.removeEventListener('change', sync)
      document.removeEventListener('visibilitychange', sync)
      motion.destroy()
      animator.current = null
    }
  }, [])
  useLayoutEffect(() => { animator.current?.setState(state) }, [state])
  // React owns only stable initial geometry; the animator owns subsequent frames.
  const shape = robotFaces[initialState.current]
  return (
    <svg ref={svgRef} className="robot-avatar" data-state={state} viewBox="0 0 32 32" aria-hidden="true" focusable="false" fill="none">
      <g data-pose="" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 10V7" />
        <circle data-antenna="" cx="16" cy="6" r="1.4" fill="currentColor" stroke="none" />
        <rect x="7.5" y="10.5" width="17" height="14" rx="3.3" />
        <path d="M5.5 15v4 M26.5 15v4" />
        <g data-gaze="">
          <path data-feature="leftEye" d={robotCurve(shape.leftEye)} />
          <path data-feature="rightEye" d={robotCurve(shape.rightEye)} />
        </g>
      </g>
    </svg>
  )
})

export default RobotAvatar

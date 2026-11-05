import { isRobotActive, type RobotAvatarState } from './robotAvatarState'

type Face = { leftEye: number[]; rightEye: number[]; mouth: number[]; leftBrow: number[]; rightBrow: number[]; pose: number[] }
const features = ['leftEye', 'rightEye', 'mouth', 'leftBrow', 'rightBrow'] as const

// Identical curve topology allows every expression to morph without replacing SVG nodes.
const neutralBrowL = [10.5,13,12,13,13.5,13]
const neutralBrowR = [18.5,13,20,13,21.5,13]
function face(leftEye: number[], rightEye: number[], mouth: number[], angle = 0, y = 0, brows: number[][] | null = null, antenna = 1): Face {
  return { leftEye, rightEye, mouth,
    leftBrow: brows ? brows[0] : neutralBrowL,
    rightBrow: brows ? brows[1] : neutralBrowR,
    pose: [angle,y,0,0,antenna,brows ? 1 : 0] }
}
export const robotFaces: Record<RobotAvatarState, Face> = {
  connecting: face([11,15,12.5,15,14,15], [18,15,19.5,15,21,15], [14,21,16,21,18,21]),
  thinking: face([12,14,12,15.5,12,17], [20,14,20,15.5,20,17], [15,21,16.5,21,18,21], -5),
  searching: face([12,14,12,15.5,12,17], [20,14,20,15.5,20,17], [15,21,16,21,17,21]),
  working: face([12,16,12,16.5,12,17], [20,16,20,16.5,20,17], [13.5,21,16,21,18.5,21], 0,.3,
    [[10.5,13.5,12,14,13.5,14.5],[18.5,14.5,20,14,21.5,13.5]]),
  writing: face([11,16,12,14,13,16], [19,16,20,14,21,16], [14,20,16,23,18,20]),
  waiting: face([12,13,12,15,12,17], [19,16,20,16,21,16], [15,21,16,20,17,21], -8),
  done: face([10.5,16,12,13,13.5,16], [18.5,16,20,13,21.5,16], [13.5,20,16,24,18.5,20]),
  failed: face([12,16,12,16.5,12,17], [20,16,20,16.5,20,17], [14,22,16,19,18,22], 5,.5,
    [[10.5,14,12,13.5,13.5,13],[18.5,13,20,13.5,21.5,14]]),
  stopped: face([10.5,16,12,16,13.5,16], [18.5,16,20,16,21.5,16], [14.5,21,16,21,17.5,21], 0,1,null,.35),
}
export function robotCurve(points: number[]) {
  const n = points.map(value => Number(value.toFixed(3)))
  return `M${n[0]} ${n[1]}Q${n[2]} ${n[3]} ${n[4]} ${n[5]}`
}
function sampleFace(state: RobotAvatarState, elapsed: number): Face {
  const shape = Object.fromEntries(Object.entries(robotFaces[state]).map(([key, values]) => [key, [...values]])) as Face
  if (!isRobotActive(state)) return shape
  const t = elapsed / 1000
  const wave = Math.sin(t * Math.PI * 2 / 4)
  shape.pose[4] = .72 + .28 * Math.cos(t * Math.PI * 2 / 2.4)
  if (state === 'thinking') {
    shape.pose[0] += wave * 4
    shape.pose[3] = -(.5 + .5 * wave)
  }
  if (state === 'searching') {
    shape.pose[2] = wave * 1.6
    shape.pose[0] = wave * 4
  }
  if (state === 'connecting') shape.pose[1] = -.6 * wave
  if (state === 'working') shape.pose[1] += .25 * wave
  if (state === 'writing') {
    shape.pose[0] = wave * 2
    shape.mouth[3] = 21.4 + 1.6 * Math.cos(t * Math.PI * 2 / .85)
  }
  // One brief blink every 4.6s; transitions also blend its current phase.
  const blinkTime = elapsed % 4600
  const openness = blinkTime > 3000 && blinkTime < 3240
    ? 1 - .9 * Math.sin((blinkTime - 3000) / 240 * Math.PI) : 1
  for (const eye of [shape.leftEye, shape.rightEye]) {
    const center = (eye[1] + eye[5]) / 2
    for (const i of [1, 3, 5]) eye[i] = center + (eye[i] - center) * openness
  }
  return shape
}

/** A single frame loop for one visible avatar; never re-renders the React message. */
export function createRobotAvatarAnimator(svg: SVGSVGElement, initialState: RobotAvatarState) {
  const paths = features.map(key => [key, svg.querySelector<SVGPathElement>(`[data-feature="${key}"]`)!] as const)
  const pose = svg.querySelector<SVGGElement>('[data-pose]')!
  const gaze = svg.querySelector<SVGGElement>('[data-gaze]')!
  const antenna = svg.querySelector<SVGCircleElement>('[data-antenna]')!
  const brows = svg.querySelector<SVGGElement>('[data-brows]')!
  let state = initialState
  let displayed = robotFaces[state]
  let from = displayed
  let elapsed = 280
  let motion = 0
  let frame: number | null = null
  let lastTime = 0
  let enabled = false
  let reduced = false
  function draw(shape: Face) {
    displayed = shape
    for (const [key, path] of paths) path.setAttribute('d', robotCurve(shape[key]))
    const [angle, y, xg, yg, light, browOpacity] = shape.pose
    pose.setAttribute('transform', `translate(0 ${y}) rotate(${angle} 16 19)`)
    gaze.setAttribute('transform', `translate(${xg} ${yg})`)
    antenna.setAttribute('opacity', String(light))
    brows.setAttribute('opacity', String(browOpacity))
  }
  function cancel() {
    if (frame !== null) window.cancelAnimationFrame(frame)
    frame = null
  }
  function schedule() {
    if (!enabled || reduced || frame !== null || (elapsed >= 280 && !isRobotActive(state))) return
    lastTime = window.performance.now()
    frame = window.requestAnimationFrame(tick)
  }
  function tick(now: number) {
    frame = null
    const delta = Math.max(0, now - lastTime)
    lastTime = now
    motion += delta
    elapsed = Math.min(280, elapsed + delta)
    const target = sampleFace(state, motion)
    const progress = elapsed / 280
    const eased = progress * progress * (3 - 2 * progress)
    draw(Object.fromEntries(Object.entries(target).map(([key, values]) => [key,
      values.map((value: number, i: number) => from[key as keyof Face][i] + (value - from[key as keyof Face][i]) * eased),
    ])) as Face)
    if (elapsed < 280 || isRobotActive(state)) frame = window.requestAnimationFrame(tick)
  }
  draw(displayed)
  return {
    setState(next: RobotAvatarState) {
      if (next === state) return
      cancel()
      from = displayed
      state = next
      motion = 0
      elapsed = 0
      if (reduced || !enabled) { elapsed = 280; draw(robotFaces[state]) }
      else schedule()
    },
    setPlayback(visible: boolean, reduceMotion: boolean) {
      cancel()
      enabled = visible
      reduced = reduceMotion
      if (reduced) { elapsed = 280; draw(robotFaces[state]) }
      else schedule()
    },
    destroy: cancel,
  }
}

import { isRobotActive, type RobotAvatarState } from './robotAvatarState'

type Face = { leftEye: number[]; rightEye: number[]; pose: number[] }
const features = ['leftEye', 'rightEye'] as const

// Identical curve topology allows every expression to morph without replacing SVG nodes.
function face(leftEye: number[], rightEye: number[], angle = 0, y = 0, antenna = 1): Face {
  return { leftEye, rightEye,
    pose: [angle,y,0,0,antenna] };
}
export const robotFaces: Record<RobotAvatarState, Face> = {
  connecting: face([11.5,17,12,17.4,12.5,17], [19.5,17,20,17.4,20.5,17]),
  thinking: face([12,15,12,16.2,12,17.4], [20,15.8,20,17,20,18.2], -5),
  searching: face([11.8,15.3,11.5,17.1,11.8,18.9], [20.2,15.3,20.5,17.1,20.2,18.9]),
  working: face([10.5,16.85,12,17,13.5,17.15], [18.5,17.15,20,17,21.5,16.85], 0,.3),
  writing: face([12,15.5,11.5,17,12,18.5], [20,15.5,20.5,17,20,18.5]),
  waiting: face([12,15.2,11.8,17,12,18.8], [19,17.2,20,16.8,21,17.2], -7),
  done: face([10.8,17.5,12,16.5,13.2,17.5], [18.8,17.5,20,16.5,21.2,17.5]),
  failed: face([12,17.1,12,18,12,18.9], [20,17.1,20,18,20,18.9], 3,.5),
  stopped: face([10.8,18,12,18.4,13.2,18], [18.8,18,20,18.4,21.2,18], 0,1,.35),
};
export function robotCurve(points: number[]) {
  const n = points.map(value => Number(value.toFixed(3)))
  return `M${n[0]} ${n[1]}Q${n[2]} ${n[3]} ${n[4]} ${n[5]}`
}
// Brief turns followed by a hold feel attentive instead of constantly swaying.
function turnAt(phase: number, stops: number[][]) {
  const p = ((phase % 1) + 1) % 1;
  const index = stops.findIndex(stop => stop[0] > p);
  const [start, from] = stops[index - 1];
  const [end, to] = stops[index];
  const u = (p - start) / (end - start);
  return from + (to - from) * u * u * (3 - 2 * u);
}
const focusTurns = [[0,0],[.16,-1],[.38,-1],[.58,1],[.8,1],[1,0]];
const replyTurns = [[0,0],[.18,1],[.34,1],[.6,-.8],[.76,-.8],[1,0]];
function sampleFace(state: RobotAvatarState, elapsed: number): Face {
  const shape = Object.fromEntries(Object.entries(robotFaces[state]).map(([key,values]) => [key,[...values]])) as Face;
  if (!isRobotActive(state)) return shape;
  const t = elapsed / 1000;
  const wave = Math.sin(t * Math.PI * 2 / 4);
  // Ease into each turn and linger briefly before looking back.
  const sway = Math.sin(Math.PI / 2 * Math.sin(t * Math.PI * 2 / 5.2));
  const gaze = Math.sin(Math.PI / 2 * Math.sin((t + .18) * Math.PI * 2 / 5.2));
  shape.pose[4] = .72 + .28 * Math.cos(t * Math.PI * 2 / 2.4);
  if (state === 'thinking') { shape.pose[0] = -2 + sway * 8; shape.pose[2] = gaze * .5; shape.pose[3] = -(.5 + .5 * wave); }
  if (state === 'searching') { shape.pose[2] = gaze * 1.6; shape.pose[0] = sway * 7; }
  if (state === 'connecting') {
    shape.pose[0] = sway * 3; shape.pose[1] = -.6 * wave;
    const opening = .4 + .6 * (1 - Math.cos(t * Math.PI * 2 / 3.6)) / 2;
    shape.leftEye = [12,17 - opening,12,17,12,17 + opening];
    shape.rightEye = [20,17 - opening,20,17,20,17 + opening];
  }
  if (state === 'working') {
    const look = turnAt(t / 3.2 + .05, focusTurns);
    shape.pose[0] = turnAt(t / 3.2, focusTurns) * 9;
    shape.pose[2] = look * 1.3; shape.pose[3] = -look * .3;
    shape.pose[1] += .2 * wave;
  }
  if (state === 'writing') {
    shape.pose[0] = turnAt(t / 3.6, replyTurns) * 10;
    shape.pose[2] = turnAt(t / 3.6 + .05, replyTurns) * 1.4;
    shape.pose[1] = .3 * (1 - Math.cos(t * Math.PI * 2 / 1.8));
  }
  // One brief blink every 4.6s; the transition also blends its current phase.
  const blinkTime = elapsed % 4600;
  const openness = blinkTime > 3000 && blinkTime < 3240 ? 1 - .9 * Math.sin((blinkTime - 3000) / 240 * Math.PI) : 1;
  for (const eye of [shape.leftEye,shape.rightEye]) {
    const center = (eye[1] + eye[5]) / 2;
    for (const i of [1,3,5]) eye[i] = center + (eye[i] - center) * openness;
  }
  return shape;
}

/** A single frame loop for one visible avatar; never re-renders the React message. */
export function createRobotAvatarAnimator(svg: SVGSVGElement, initialState: RobotAvatarState) {
  const paths = features.map(key => [key, svg.querySelector<SVGPathElement>(`[data-feature="${key}"]`)!] as const)
  const pose = svg.querySelector<SVGGElement>('[data-pose]')!
  const gaze = svg.querySelector<SVGGElement>('[data-gaze]')!
  const antenna = svg.querySelector<SVGCircleElement>('[data-antenna]')!
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
    const [angle, y, xg, yg, light] = shape.pose
    pose.setAttribute('transform', `translate(${angle * .055} ${y}) rotate(${angle} 16 19)`)
    gaze.setAttribute('transform', `translate(${xg} ${yg})`)
    antenna.setAttribute('opacity', String(light))
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

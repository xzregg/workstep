export const WALKTHROUGH_DURATION = 31.55

export const WALKTHROUGH_CHAPTERS = [
  { id: 'flow', at: 0, revealAt: [.6, 2.7, 4.5, 6.8] },
  { id: 'create', at: 9.244, revealAt: [.4, 1.7, 3.1, 4.7] },
  { id: 'describe', at: 15, revealAt: [.5, 2.2, 4.2, 6.8] },
  { id: 'save', at: 24.346, revealAt: [.4, 2, 4, 5.8] },
] as const

const CAMERA_KEYS = [
  [0, 1, .5, .5], [1.4, 1.25, .34, .52], [3.2, 1.6, .81, .35], [6.5, 1.6, .81, .35],
  [8.1, 1.05, .6, .4], [9.3, 1.1, .48, .22], [11.3, 1.5, .47, .22], [14.3, 1.65, .46, .19],
  [15.8, 1.7, .46, .3], [21, 1.7, .46, .33], [23.1, 1.55, .45, .44], [24.35, 1.42, .46, .88],
  [26.6, 1.6, .36, .26], [28.4, 1.6, .36, .38], [31.6, 1.45, .4, .38],
] as const

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function getWalkthroughFrame(time: number) {
  const chapter = Math.max(0, WALKTHROUGH_CHAPTERS.findLastIndex(item => time >= item.at))
  const definition = WALKTHROUGH_CHAPTERS[chapter]
  return { chapter, definition, revealed: definition.revealAt.filter(at => time - definition.at >= at).length }
}

export function getWalkthroughCamera(time: number, width: number, height: number, mobile: boolean, reduced: boolean) {
  if (reduced) return { zoom: 1, x: 0, y: 0 }
  const index = Math.max(0, CAMERA_KEYS.findLastIndex(key => time >= key[0]))
  const from = CAMERA_KEYS[index], to = CAMERA_KEYS[Math.min(index + 1, CAMERA_KEYS.length - 1)]
  const progress = to[0] === from[0] ? 0 : clamp((time - from[0]) / (to[0] - from[0]), 0, 1)
  const eased = progress * progress * (3 - 2 * progress)
  const values = from.map((value, i) => value + (to[i] - value) * eased)
  const zoom = mobile ? 1 + (values[1] - 1) * .65 : values[1]
  // The source recording is 1440 × 900. Account for object-fit: cover before panning.
  const fit = Math.max(width / 1440, height / 900)
  const focusX = (values[2] * 1440 * fit - (1440 * fit - width) / 2) / width
  const focusY = (values[3] * 900 * fit - (900 * fit - height) / 2) / height
  const targetX = mobile ? .5 : .5 + .22 * clamp((zoom - 1) / .25, 0, 1)
  return {
    zoom,
    x: clamp(targetX - zoom * focusX, 1 - zoom, mobile ? 0 : .3) * width,
    y: clamp(.5 - zoom * focusY, 1 - zoom, 0) * height,
  }
}

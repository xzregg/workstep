import { clamp } from '../demo/timeline'

export function arrive(time: number, at: number, duration = 420): number {
  return clamp((time - at) / duration, 0, 1)
}

export function typewriter(time: number, start: number, end: number, text: string): string {
  const progress = clamp((time - start) / (end - start), 0, 1)
  return text.slice(0, Math.floor(progress * text.length))
}

export function visible(time: number, at: number, duration = 420): boolean {
  return time >= at && time < at + duration + 60
}

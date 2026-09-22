export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function stepTime(time: number, delta: number, duration: number, loop: boolean): number {
  if (duration <= 0) return 0
  if (loop) {
    const next = (time + delta) % duration
    return next < 0 ? next + duration : next
  }
  return clamp(time + delta, 0, duration)
}

export function formatTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function progressFor(time: number, duration: number): number {
  return duration <= 0 ? 0 : clamp(time / duration, 0, 1)
}

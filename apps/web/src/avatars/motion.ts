/** Numeric pose mixing, independent of any character artwork or skeleton. */
export const smoothstep = (value: number) => {
  const t = Math.max(0, Math.min(1, value))
  return t * t * (3 - 2 * t)
}

export const damp = (current: number, target: number, deltaMs: number, halfLifeMs = 60) => (
  target + (current - target) * Math.pow(.5, Math.max(0, deltaMs) / Math.max(1, halfLifeMs))
)

/** Changing the clip key captures the displayed pose, including interrupted blends. */
export function createMotionMixer(initial: readonly number[]) {
  let current = Float32Array.from(initial), from = current.slice(), key: string | null = null, startedAt = 0
  return {
    sample(target: ArrayLike<number>, clip: string, now: number, durationMs = 600) {
      if (target.length !== current.length) throw new Error('Action vector length mismatch')
      if (clip !== key) { from = current.slice(); key = clip; startedAt = now }
      const weight = durationMs <= 0 ? 1 : smoothstep((now - startedAt) / durationMs)
      current = Float32Array.from(target, (value, index) => from[index] + (value - from[index]) * weight)
      return current
    },
  }
}

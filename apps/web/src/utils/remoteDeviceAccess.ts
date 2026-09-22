export type AccessDurationPreset = 'permanent' | 'day' | 'week' | 'month' | 'custom'

const PRESET_SECONDS: Record<Exclude<AccessDurationPreset, 'permanent' | 'custom'>, number> = {
  day: 24 * 60 * 60,
  week: 7 * 24 * 60 * 60,
  month: 30 * 24 * 60 * 60,
}

export function resolveAccessExpiresAt(
  preset: AccessDurationPreset,
  customDateTime: string,
  nowMs = Date.now(),
): number | null {
  if (preset === 'permanent') return null
  if (preset !== 'custom') {
    return Math.floor(nowMs / 1000) + PRESET_SECONDS[preset]
  }
  const parsed = new Date(customDateTime).getTime()
  if (!customDateTime || !Number.isFinite(parsed) || parsed <= nowMs) {
    throw new Error('Device access expiry must be in the future')
  }
  return Math.floor(parsed / 1000)
}

export type DateTimeValue = string | number | Date | null | undefined

export function toMilliseconds(value: DateTimeValue): number | null {
  if (value instanceof Date) {
    const timestamp = value.getTime()
    return Number.isFinite(timestamp) ? timestamp : null
  }
  if (typeof value === 'string') {
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) ? timestamp : null
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null
  }
  return value < 1_000_000_000_000 ? value * 1000 : value
}

export function durationMilliseconds(
  startedAt: DateTimeValue,
  endedAt: DateTimeValue,
): number | null {
  const startedAtMs = toMilliseconds(startedAt)
  const endedAtMs = toMilliseconds(endedAt)
  if (startedAtMs === null || endedAtMs === null || endedAtMs < startedAtMs) {
    return null
  }
  return endedAtMs - startedAtMs
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return ''
  if (durationMs > 0 && durationMs < 1000) return '<1秒'

  const totalSeconds = Math.floor(durationMs / 1000)
  const units = [
    { label: '天', seconds: 86_400 },
    { label: '小时', seconds: 3_600 },
    { label: '分', seconds: 60 },
    { label: '秒', seconds: 1 },
  ]
  let remainder = totalSeconds
  const parts: string[] = []
  for (const unit of units) {
    const value = Math.floor(remainder / unit.seconds)
    remainder %= unit.seconds
    if (value > 0 || (unit.seconds === 1 && parts.length === 0)) {
      parts.push(`${value}${unit.label}`)
    }
    if (parts.length === 2) break
  }
  return parts.join('')
}

export function formatDurationBetween(
  startedAt: DateTimeValue,
  endedAt: DateTimeValue,
): string | null {
  const durationMs = durationMilliseconds(startedAt, endedAt)
  return durationMs === null ? null : formatDuration(durationMs)
}

export function formatConversationDateTime(
  value: DateTimeValue,
  now: DateTimeValue = Date.now(),
): string {
  const milliseconds = toMilliseconds(value)
  const nowMilliseconds = toMilliseconds(now)
  if (milliseconds === null) return ''

  const date = new Date(milliseconds)
  const pad = (part: number) => String(part).padStart(2, '0')
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  const age = nowMilliseconds === null ? null : nowMilliseconds - milliseconds
  if (age !== null && age >= 0 && age < 7 * 24 * 60 * 60 * 1000) {
    return `周${'日一二三四五六'[date.getDay()]} ${time}`
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`
}

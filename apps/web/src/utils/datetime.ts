import { zhCNT, type TFunction } from '../i18n'

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

export function formatDuration(durationMs: number, t: TFunction = zhCNT): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return ''
  if (durationMs > 0 && durationMs < 1000) return t('datetime.lessThanSecond')

  const totalSeconds = Math.floor(durationMs / 1000)
  const units = [
    { label: 'datetime.day', seconds: 86_400 },
    { label: 'datetime.hour', seconds: 3_600 },
    { label: 'datetime.minute', seconds: 60 },
    { label: 'datetime.second', seconds: 1 },
  ] as const
  let remainder = totalSeconds
  const parts: string[] = []
  for (const unit of units) {
    const value = Math.floor(remainder / unit.seconds)
    remainder %= unit.seconds
    if (value > 0 || (unit.seconds === 1 && parts.length === 0)) {
      parts.push(`${value}${t(unit.label)}`)
    }
    if (parts.length === 2) break
  }
  return parts.join('')
}

export function formatDurationBetween(
  startedAt: DateTimeValue,
  endedAt: DateTimeValue,
  t: TFunction = zhCNT,
): string | null {
  const durationMs = durationMilliseconds(startedAt, endedAt)
  return durationMs === null ? null : formatDuration(durationMs, t)
}

export function formatExecutionClock(value: DateTimeValue): string {
  const milliseconds = toMilliseconds(value)
  if (milliseconds === null) return ''
  const date = new Date(milliseconds)
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function formatExecutionOffset(
  value: DateTimeValue,
  origin: DateTimeValue,
): string {
  const valueMs = toMilliseconds(value)
  const originMs = toMilliseconds(origin)
  if (valueMs === null || originMs === null || valueMs < originMs) return ''
  const totalSeconds = Math.max(0, Math.floor((valueMs - originMs) / 1000))
  const pad = (part: number) => String(part).padStart(2, '0')
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

export function formatConversationDateTime(
  value: DateTimeValue,
  now: DateTimeValue = Date.now(),
  locale: string = 'zh-CN',
): string {
  const milliseconds = toMilliseconds(value)
  const nowMilliseconds = toMilliseconds(now)
  if (milliseconds === null) return ''

  const date = new Date(milliseconds)
  const pad = (part: number) => String(part).padStart(2, '0')
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  const sameWeek = nowMilliseconds !== null
    && startOfWeek(date) === startOfWeek(new Date(nowMilliseconds))
  if (sameWeek) {
    const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(date)
    return `${weekday} ${time}`
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`
}

function startOfWeek(value: Date): number {
  const daysSinceMonday = (value.getDay() === 0 ? 7 : value.getDay()) - 1
  const start = new Date(value)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - daysSinceMonday)
  return start.getTime()
}

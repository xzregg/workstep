export type ScheduledStartMode = 'manual' | 'immediate' | 'scheduled'

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

export function localDateTimeToIso(value: string): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function formatScheduledStart(value?: string | null): string {
  if (!value) return ''
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'short', timeStyle: 'short', timeZone: systemTimeZone(),
  })
}

export function utcToLocalDateTime(value?: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const offset = date.getTimezoneOffset() * 60000
  return new Date(date.getTime() - offset).toISOString().slice(0, 19)
}

export function localDateTimeAfter(minutes: number): string {
  const date = new Date(Date.now() + minutes * 60_000)
  const pad = (item: number) => String(item).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

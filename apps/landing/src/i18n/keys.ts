import { zhCN } from './zh-CN'

export type I18nDict = typeof zhCN

export function flattenKeys(dict: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(dict).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object') {
      return flattenKeys(value as Record<string, unknown>, path)
    }
    return [path]
  })
}

export function resolvePath(dict: Record<string, unknown>, path: string): string {
  const value = path.split('.').reduce<unknown>(
    (acc, part) => (acc as Record<string, unknown> | undefined)?.[part],
    dict,
  )
  if (typeof value !== 'string') {
    throw new Error(`Missing i18n key: ${path}`)
  }
  return value
}

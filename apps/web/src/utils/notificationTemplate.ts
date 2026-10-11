export const maxNotificationTemplateLength = 8000

export function notificationTemplateIssue(value: string | null | undefined, variables: readonly string[]) {
  if (value == null) return null
  if (!value.trim()) return { kind: 'empty' as const, variables: '' }
  if (value.length > maxNotificationTemplateLength) return { kind: 'length' as const, variables: '' }
  const unknown = [...new Set([...value.matchAll(/(?<!\\)\{([^{}\n]*)\}/g)].map(match=>match[1]).filter(key=>!variables.includes(key)))].sort()
  return unknown.length ? { kind: 'unknown' as const, variables: unknown.join('、') } : null
}

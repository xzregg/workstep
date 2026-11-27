import type { ScheduleRule } from '../api/schedule'

type ReviewCounts = Record<string, { mode: string; maxRetries: number }>

const reviewCountValid = (value: number) => Number.isInteger(value) && value >= 1 && value <= 5

export function reviewOverridesValid(value: ReviewCounts, lanes: Array<{ key: string }>, startStepKey?: string | null): boolean {
  const startIndex = Math.max(0, lanes.findIndex(lane => lane.key === startStepKey))
  return Object.entries(value).every(([key, cfg]) => {
    const index = lanes.findIndex(lane => lane.key === key)
    return (index >= 0 && index < startIndex) || cfg.mode !== 'auto' || reviewCountValid(cfg.maxRetries)
  })
}

// Call after validation: inactive invalid drafts must not serialize as null.
export function reviewOverridesForSubmit<T extends ReviewCounts>(value: T, baseline?: ReviewCounts): T {
  return Object.fromEntries(Object.entries(value).map(([key, cfg]) => {
    const original = baseline?.[key]?.maxRetries
    return [key, { ...cfg, maxRetries: reviewCountValid(cfg.maxRetries) ? cfg.maxRetries
      : original !== undefined && reviewCountValid(original) ? original : 1 }]
  })) as T
}

export function scheduleRuleNumbersValid(rule: ScheduleRule): boolean {
  if (rule.kind === 'minutes' || rule.kind === 'interval') return Number.isInteger(rule.every) && rule.every >= 1 && rule.every <= (rule.kind === 'minutes' ? 10080 : 24)
  if (rule.kind === 'monthly') return rule.monthdays.length > 0 && rule.monthdays.every(day => Number.isInteger(day) && day >= 1 && day <= 31)
  return true
}

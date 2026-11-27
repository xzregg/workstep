import type { ScheduleRule } from '../api/schedule'

export function reviewOverridesValid(value: Record<string, { mode: string; maxRetries: number }>, lanes: Array<{ key: string }>, startStepKey?: string | null): boolean {
  const startIndex = Math.max(0, lanes.findIndex(lane => lane.key === startStepKey))
  return Object.entries(value).every(([key, cfg]) => {
    const index = lanes.findIndex(lane => lane.key === key)
    return Number.isFinite(cfg.maxRetries) && ((index >= 0 && index < startIndex) || cfg.mode !== 'auto'
      || (Number.isInteger(cfg.maxRetries) && cfg.maxRetries >= 1 && cfg.maxRetries <= 5))
  })
}

export function scheduleRuleNumbersValid(rule: ScheduleRule): boolean {
  if (rule.kind === 'minutes' || rule.kind === 'interval') return Number.isInteger(rule.every) && rule.every >= 1 && rule.every <= (rule.kind === 'minutes' ? 10080 : 24)
  if (rule.kind === 'monthly') return rule.monthdays.length > 0 && rule.monthdays.every(day => Number.isInteger(day) && day >= 1 && day <= 31)
  return true
}

import type { EngineConfigField, EngineConfigOption } from '../api/engine'
import type { TFunction, TKey } from '../i18n'

export const THINKING_EFFORT_LEVELS = ['auto', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const

const labelKeys: Record<string, TKey> = {
  auto: 'coord.thinkingLevels.auto', none: 'coord.thinkingLevels.none',
  minimal: 'coord.thinkingLevels.minimal', low: 'coord.thinkingLevels.low',
  medium: 'coord.thinkingLevels.medium', high: 'coord.thinkingLevels.high',
  xhigh: 'coord.thinkingLevels.xhigh', max: 'coord.thinkingLevels.max',
  ultra: 'coord.thinkingLevels.ultra',
}

export function thinkingEffortLabel(value: string, t: TFunction, options: EngineConfigOption[] = []) {
  return labelKeys[value] ? t(labelKeys[value]) : options.find(option => option.value === value)?.label || value
}

function isThinkingEffortField(field: EngineConfigField) {
  return field.model_capability === 'supported_reasoning_efforts'
    || ['thinking_effort', 'model_reasoning_effort', 'reasoning_effort'].includes(field.key)
}

export function engineConfigOptionLabel(field: EngineConfigField, option: EngineConfigOption, t: TFunction) {
  // Legacy schemas have no model_capability. Translate their raw effort
  // values while retaining explicit labels supplied by custom engines.
  return isThinkingEffortField(field)
    && (field.model_capability === 'supported_reasoning_efforts' || option.label === option.value)
    ? thinkingEffortLabel(option.value, t, field.options || []) : option.label
}

export function engineEffortOptions(
  engine: { config?: { fields: EngineConfigField[]; step_fields?: EngineConfigField[] } | null } | undefined,
): EngineConfigOption[] {
  const schema = engine?.config
  const fields = schema?.fields.length ? schema.fields : schema?.step_fields || []
  const field = fields.find(isThinkingEffortField)
  return field ? field.options || []
    : THINKING_EFFORT_LEVELS.map(value => ({ value, label: value }))
}

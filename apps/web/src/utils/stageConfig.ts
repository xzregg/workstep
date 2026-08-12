import type { EngineConfigField, EngineConfigPayload } from '../api/client'

/**
 * Build the initial stage-level config for an engine, prefilled from that
 * engine's global config values. Sensitive fields never appear at stage level.
 */
export function initialStageConfig(
  engineConfig: EngineConfigPayload | null | undefined,
): Record<string, string> {
  if (!engineConfig) return {}
  const out: Record<string, string> = {}
  for (const field of engineConfig.stage_fields || []) {
    const value = engineConfig.values?.[field.key]
    if (typeof value === 'string' && value !== '') {
      out[field.key] = value
    }
  }
  return out
}

/**
 * Normalize a stage config value into a string, or '' when undefined.
 */
export function stageFieldValue(
  config: Record<string, string>,
  field: EngineConfigField,
): string {
  return config[field.key] ?? ''
}

/**
 * Update one stage config key, dropping the key when the value is empty.
 * Empty values are dropped at the stage level so the runtime falls back to
 * the engine's global config.
 */
export function setStageFieldValue(
  config: Record<string, string>,
  field: EngineConfigField,
  value: string,
): Record<string, string> {
  const next = { ...config }
  if (value === '') {
    delete next[field.key]
  } else {
    next[field.key] = value
  }
  return next
}

/**
 * Normalize a step's serialized config (any source shape) into a plain
 * string-keyed record, preserving already-normalized values.
 */
export function normalizeStepConfig(
  raw: unknown,
): Record<string, string> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string' && value !== '') out[key] = value
      else if (typeof value === 'number' || typeof value === 'boolean') {
        out[key] = String(value)
      }
    }
    return out
  }
  return {}
}

import type { TFunction, TKey } from '../i18n'
import type { PermissionConfigOption } from './enginePermissions'

const localizedEngines = new Set(['codex', 'codex_sdk', 'claude', 'claude_agent_sdk', 'qoder_sdk', 'pydantic_ai', 'opencode'])

// Presentation only. Native values and execution policy remain engine-owned.
function choiceKey(engine: string, field: string, value: string): string | undefined {
  if (!localizedEngines.has(engine)) return undefined
  if (!value) return 'engineDefault'
  if (engine === 'codex' || engine === 'codex_sdk') {
    if (field === 'sandbox' || field === 'sandbox_mode') return ({ 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'fullAccess' } as Record<string, string>)[value]
    return ({ 'on-request': 'standard', never: 'noAsk', 'on-failure': 'onFailure', 'full-auto': 'autoReview', untrusted: 'untrusted', auto_review: 'autoReview', deny_all: 'noEscalation' } as Record<string, string>)[value]
  }
  if (field !== 'permission_mode') return undefined
  if (engine === 'pydantic_ai') return ({ full: 'direct', auto: 'riskAsk', 'read-only': 'writeAsk' } as Record<string, string>)[value]
  if (engine === 'claude' || engine === 'claude_agent_sdk' || engine === 'qoder_sdk') return ({ manual: 'standard', default: 'standard', acceptEdits: 'autoEdit', plan: 'plan', auto: 'autoReview', dontAsk: 'noAsk', bypassPermissions: 'bypass' } as Record<string, string>)[value]
  if (engine === 'opencode') return ({ allow: 'allow', ask: 'ask', deny: 'deny' } as Record<string, string>)[value]
  return undefined
}

export function permissionFieldName(engine: string, field: Pick<PermissionConfigOption, 'id' | 'name'>, t?: TFunction): string {
  if (!t || !localizedEngines.has(engine)) return field.name
  if ((engine === 'codex' || engine === 'codex_sdk') && (field.id === 'sandbox' || field.id === 'sandbox_mode')) return t('enginePermission.sandbox')
  if (['permission_mode', 'approval_mode', 'approval_policy'].includes(field.id)) return t('enginePermission.approval')
  return field.name
}

export function permissionChoice(engine: string, field: Pick<PermissionConfigOption, 'id'>, choice: { value: string | boolean; name: string; description?: string }, t?: TFunction) {
  const key = typeof choice.value === 'string' ? choiceKey(engine, field.id, choice.value) : undefined
  const description = t && key && key !== 'engineDefault' ? t(('enginePermission.' + key + 'Hint') as TKey) : choice.description
  const nativeMode = ['claude', 'claude_agent_sdk'].includes(engine) && field.id === 'permission_mode'
    && typeof choice.value === 'string' && choice.value
      ? choice.value === 'manual' ? 'manual / default' : choice.value : ''
  return {
    name: t && key ? t(('enginePermission.' + key) as TKey) : choice.name,
    description: nativeMode ? [nativeMode, description].filter(Boolean).join(' · ') : description,
  }
}


export function visiblePermissionFields<T extends { key: string; options?: { value: string }[] | null }>(engine: string, fields: T[]): T[] {
  if (['claude', 'claude_agent_sdk'].includes(engine)) return fields.map(field => field.key === 'permission_mode'
    ? { ...field, options: field.options?.filter(option => option.value !== 'plan') } : field)
  if (engine !== 'pydantic_ai') return fields
  return fields.filter(field => field.key !== 'sandbox').map(field => field.key === 'permission_mode'
    ? { ...field, options: field.options?.filter(option => ['full', 'auto', 'read-only'].includes(option.value)) } : field)
}

export function permissionFormValues(engine: string, values: Record<string, string>): Record<string, string> {
  if (engine !== 'pydantic_ai' || values.permission_mode !== 'legacy') return values
  return { ...values, permission_mode: ({ 'read-only': 'read-only', 'workspace-write': 'auto', 'danger-full-access': 'full' } as Record<string, string>)[values.sandbox] || 'auto' }
}

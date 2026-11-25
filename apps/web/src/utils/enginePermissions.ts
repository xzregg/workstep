import type { FloatingMenuOption } from '../components/FloatingMenu'
import type { TFunction } from '../i18n'
import { permissionChoice, permissionFieldName } from './permissionLabels'

export const PERMISSION_FIELD = '@permission-field:'
export const PERMISSION_BACK = '@permission-back'

export interface PermissionConfigOption {
  id: string
  name: string
  description?: string
  type: 'select' | 'boolean'
  currentValue: string | boolean
  options?: { value: string; name: string; description?: string }[]
}

const prefix = 'native-permissions:v1:'

export function permissionSelection(engine: string, value: string): Record<string, string | boolean> | null {
  if (!value.startsWith(prefix)) return null
  try {
    const selection = JSON.parse(value.slice(prefix.length))
    return selection.engine === engine && selection.values && typeof selection.values === 'object'
      ? selection.values : null
  } catch { return null }
}

export function encodePermissionSelection(engine: string, values: Record<string, string | boolean>): string {
  return prefix + JSON.stringify({ engine, values: Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))) })
}

export function nativePermissionMenu(
  engine: string, fields: PermissionConfigOption[], value: string, inheritLabel: string,
  fieldId?: string | null, t?: TFunction,
): { options: FloatingMenuOption[]; label: string; title?: string } {
  // Older running services may still advertise the retired compatibility choice.
  if (engine === 'pydantic_ai') fields = fields.map(field => field.id === 'permission_mode'
    ? { ...field, options: field.options?.filter(option => ['full', 'auto', 'read-only'].includes(option.value)) } : field)
  if (['claude', 'claude_agent_sdk', 'qoder_sdk', 'antigravity'].includes(engine)) fields = fields.map(field => field.id === 'permission_mode'
    ? { ...field, options: field.options?.filter(option => option.value !== 'plan') } : field)
  const codex = engine === 'codex' || engine === 'codex_sdk'
  if (codex) fields = fields.filter(field => field.id === (engine === 'codex' ? 'sandbox_mode' : 'sandbox'))
    .map(field => ({ ...field, options: field.options?.filter(option => option.value !== '') }))
  const saved = permissionSelection(engine, value)
  if (value.startsWith(prefix) && !saved) value = ''
  const selected = saved ? Object.fromEntries(Object.entries(saved).filter(([key]) => fields.some(field => field.id === key))) : null
  const options: FloatingMenuOption[] = [{ value: '', label: inheritLabel, selected: !value || Boolean(codex && saved && Object.keys(selected ?? {}).length === 0) }]
  const labels = fields.flatMap(field => {
    const option = field.options?.find(option => option.value === selected?.[field.id])
    return option ? [permissionChoice(engine, field, option, t).name] : []
  })
  const label = !value ? inheritLabel : labels.join(' / ') || inheritLabel
  if (fields.length > 1 && !fields.some(field => field.id === fieldId)) {
    for (const field of fields) {
      const current = selected?.[field.id] ?? field.currentValue
      const choice = field.options?.find(option => option.value === current)
      options.push({ value: PERMISSION_FIELD + field.id, label: permissionFieldName(engine, field, t),
        description: choice ? permissionChoice(engine, field, choice, t).name : String(current), keepOpen: true, hasChildren: true, selected: false })
    }
    return { options, label }
  }
  if (fields.length > 1) options.splice(0, 1, { value: PERMISSION_BACK, label: t?.('enginePermission.back') ?? 'Back', keepOpen: true, selected: false })
  const visibleFields = fields.length > 1 ? fields.filter(field => field.id === fieldId) : fields
  for (const field of visibleFields) {
    const choices = field.type === 'boolean'
      ? [{ value: true, name: t?.('enginePermission.on') ?? 'On' }, { value: false, name: t?.('enginePermission.off') ?? 'Off' }]
      : field.options ?? []
    for (const choice of choices) {
      const presentation = permissionChoice(engine, field, choice, t)
      options.push({ value: encodePermissionSelection(engine, { ...selected, [field.id]: choice.value }),
        label: presentation.name, description: presentation.description,
        selected: (selected?.[field.id] ?? (fields.length > 1 ? field.currentValue : undefined)) === choice.value })
    }
  }
  return { options, label, title: visibleFields[0] ? permissionFieldName(engine, visibleFields[0], t) : undefined }
}

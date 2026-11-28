import type { ReactNode } from 'react'
import type { EngineConfigField } from '../api/client'
import type { FloatingMenuOption } from './FloatingMenu'
import Input from './Input'
import Select from './Select'
import Textarea from './Textarea'
import { useI18n } from '../i18n'
import { visiblePermissionFields } from '../utils/permissionLabels'
import { engineConfigOptionLabel, engineConfigOptionDescription } from '../utils/thinkingEffort'
import './StepConfigFields.css'

export interface StepConfigFieldsProps {
  engineId: string
  fields: EngineConfigField[]
  values: Record<string, string>
  onChange: (key: string, value: string) => void
  disabled?: boolean
  renderSelect?: (field: EngineConfigField, value: string, options: FloatingMenuOption[]) => ReactNode
}

/**
 * Render the engine's step-level config fields (no sensitive / password
 * fields — those are stripped by the backend's ``step_config_schema``).
 * Reuses the same control styling as the settings-page config form.
 */
const StepConfigFields = ({
  engineId,
  fields,
  values,
  onChange,
  disabled,
  renderSelect,
}: StepConfigFieldsProps) => {
  const { t } = useI18n()
  if (!fields.length) return null
  const inheritLabel = renderSelect ? t('enginePermission.inherit') : ''

  return (
    <div className={renderSelect ? 'step-config-fields--menu' : 'step-config-fields'}>
      {visiblePermissionFields(engineId, fields).map((field) => {
        const value = values[field.key] ?? ''
        const isSelect = field.type === 'select'
        const isCheckbox = field.type === 'checkbox'
        const isTextarea = field.type === 'textarea'
        const options: FloatingMenuOption[] = isSelect ? [
          {
            value: '',
            label: field.category === 'mode'
              ? t('chatSession.permissionDefault')
              : field.placeholder || (field.required ? t('engineForm.selectPlaceholder') : inheritLabel),
          },
          ...(field.options ?? []).map((option) => ({
            value: option.value,
            label: engineConfigOptionLabel(field, option, t, engineId),
            description: engineConfigOptionDescription(field, option, t, engineId),
          })),
        ] : []
        if (isSelect && renderSelect) {
          return <div key={field.key}>{renderSelect(field, value, options)}</div>
        }
        return (
          <div
            key={field.key}
            className={field.category === 'mode' ? 'step-permission-field' : undefined}
            style={{ minWidth: 0, gridColumn: isTextarea ? '1 / -1' : undefined }}
          >
            <label
              htmlFor={`step-config-${engineId}-${field.key}`}
              style={{ display: 'block', marginBottom: 4, fontSize: 'calc(11px * var(--font-scale))', fontWeight: 600 }}
            >
              {field.label}
              {field.required && field.category !== 'mode' && <span style={{ color: 'var(--danger)', marginLeft: 2 }}>*</span>}
            </label>
            {isSelect ? (
              <Select
                id={`step-config-${engineId}-${field.key}`}
                value={value}
                disabled={disabled}
                onChange={(event) => onChange(field.key, event.target.value)}
              >
                {options.map((option) => (
                  <option key={option.value} value={option.value}
                    data-description={option.description}>
                    {option.label}
                  </option>
                ))}
              </Select>
            ) : isCheckbox ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 28 }}>
                <input
                  id={`step-config-${engineId}-${field.key}`}
                  type="checkbox"
                  checked={value === 'true'}
                  disabled={disabled}
                  onChange={(event) => onChange(
                    field.key,
                    event.target.checked ? 'true' : 'false',
                  )}
                  style={{
                    width: 16, height: 16, padding: 0, margin: 0,
                    accentColor: 'var(--accent)',
                  }}
                />
                <span style={{ fontSize: 'calc(11px * var(--font-scale))', color: 'var(--muted)' }}>
                  {field.placeholder || field.label}
                </span>
              </div>
            ) : isTextarea ? (
              <Textarea
                id={`step-config-${engineId}-${field.key}`}
                value={value}
                readOnly={disabled}
                onChange={(event) => onChange(field.key, event.target.value)}
                placeholder={field.placeholder}
                rows={2}
                style={{ resize: 'vertical' }}
              />
            ) : (
              <Input
                id={`step-config-${engineId}-${field.key}`}
                type={field.type === 'number' ? 'number' : 'text'}
                value={value}
                readOnly={disabled}
                onChange={(event) => onChange(field.key, event.target.value)}
                placeholder={field.placeholder}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

export default StepConfigFields

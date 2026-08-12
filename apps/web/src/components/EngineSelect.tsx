import type { CSSProperties } from 'react'
import { engineLabel } from '../engineMeta'
import { useI18n, type TFunction } from '../i18n'
import Select from './Select'

export interface EngineSelectOption {
  id: string
  installed: boolean
  configured: boolean
  verified: boolean
  built_in: boolean
  mode: 'cli' | 'acp' | 'agent' | 'sdk' | null
  supports_coordinator?: boolean
}

interface EngineSelectProps {
  engines: EngineSelectOption[]
  value: string
  onChange: (engineId: string) => void
  disabled?: boolean
  requireCoordinator?: boolean
  defaultOption?: { value: string; label: string }
  title?: string
  ariaLabel?: string
  style?: CSSProperties
}

export function isEngineSelectable(
  engine: EngineSelectOption,
  requireCoordinator = false,
) {
  return engine.installed
    && engine.configured
    && engine.verified
    && (!requireCoordinator || engine.supports_coordinator === true)
}

function availabilityLabel(
  engine: EngineSelectOption,
  requireCoordinator: boolean,
  t: TFunction,
) {
  if (!engine.installed) return t('engine.notInstalled')
  if (!engine.configured) return t('engine.needsConfig')
  if (!engine.verified) return t('engine.needsTest')
  if (requireCoordinator && !engine.supports_coordinator) return t('engine.noCoordinator')
  return ''
}

function optionLabel(
  engine: EngineSelectOption,
  requireCoordinator: boolean,
  t: TFunction,
) {
  const availability = availabilityLabel(engine, requireCoordinator, t)
  const mode = engine.mode ? ` · ${engine.mode.toUpperCase()}` : ''
  const builtin = engine.built_in ? t('engine.builtinPrefix') : ''
  const availabilitySuffix = availability ? t('engine.availabilitySuffix', { availability }) : ''
  return `${builtin}${engineLabel(engine.id, t)}${mode}${availabilitySuffix}`
}

export default function EngineSelect({
  engines,
  value,
  onChange,
  disabled = false,
  requireCoordinator = false,
  defaultOption,
  title,
  ariaLabel,
  style,
}: EngineSelectProps) {
  const { t } = useI18n()
  const visibleEngines = engines.filter((engine) => (
    engine.installed || engine.built_in
  ))
  const managedEngines = visibleEngines.filter((engine) => (
    engine.built_in
  ))
  const localEngines = visibleEngines.filter((engine) => (
    !engine.built_in
  ))
  const currentIsListed = visibleEngines.some((engine) => engine.id === value)

  const renderOption = (engine: EngineSelectOption) => (
    <option
      key={engine.id}
      value={engine.id}
      disabled={!isEngineSelectable(engine, requireCoordinator)}
    >
      {optionLabel(engine, requireCoordinator, t)}
    </option>
  )

  return (
    <Select
      value={value}
      disabled={disabled || visibleEngines.length === 0}
      onChange={(event) => onChange(event.target.value)}
      title={title}
      aria-label={ariaLabel}
      style={style}
    >
      {defaultOption && (
        <option value={defaultOption.value}>{defaultOption.label}</option>
      )}
      {value && !currentIsListed && (
        <option value={value} disabled>
          {engineLabel(value, t)}{t('engine.unavailableSuffix')}
        </option>
      )}
      {managedEngines.length > 0 && (
        <optgroup label={t('engine.builtinAndApi')}>
          {managedEngines.map(renderOption)}
        </optgroup>
      )}
      {localEngines.length > 0 && (
        <optgroup label={t('engine.local')}>
          {localEngines.map(renderOption)}
        </optgroup>
      )}
      {visibleEngines.length === 0 && !defaultOption && (
        <option value="" disabled>{t('engine.noEngines')}</option>
      )}
    </Select>
  )
}

import type { CSSProperties } from 'react'
import { engineLabel } from '../engineMeta'
import Select from './Select'

export interface EngineSelectOption {
  id: string
  installed: boolean
  configured: boolean
  verified: boolean
  built_in: boolean
  mode: 'cli' | 'acp' | 'api' | 'agent' | 'sdk' | null
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

function isEngineSelectable(
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
) {
  if (!engine.installed) return '未安装'
  if (!engine.configured) return '待配置'
  if (!engine.verified) return '待测试'
  if (requireCoordinator && !engine.supports_coordinator) return '不支持协调模式'
  return ''
}

function optionLabel(
  engine: EngineSelectOption,
  requireCoordinator: boolean,
) {
  const availability = availabilityLabel(engine, requireCoordinator)
  const mode = engine.mode ? ` · ${engine.mode.toUpperCase()}` : ''
  return `${engine.built_in ? '内置 · ' : ''}${engineLabel(engine.id)}${mode}${availability ? `（${availability}）` : ''}`
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
  const visibleEngines = engines.filter((engine) => (
    engine.installed || engine.built_in || engine.mode === 'api'
  ))
  const managedEngines = visibleEngines.filter((engine) => (
    engine.built_in || engine.mode === 'api'
  ))
  const localEngines = visibleEngines.filter((engine) => (
    !engine.built_in && engine.mode !== 'api'
  ))
  const currentIsListed = visibleEngines.some((engine) => engine.id === value)

  const renderOption = (engine: EngineSelectOption) => (
    <option
      key={engine.id}
      value={engine.id}
      disabled={!isEngineSelectable(engine, requireCoordinator)}
    >
      {optionLabel(engine, requireCoordinator)}
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
          {engineLabel(value)}（当前配置不可用）
        </option>
      )}
      {managedEngines.length > 0 && (
        <optgroup label="内置与 API">
          {managedEngines.map(renderOption)}
        </optgroup>
      )}
      {localEngines.length > 0 && (
        <optgroup label="本地引擎">
          {localEngines.map(renderOption)}
        </optgroup>
      )}
      {visibleEngines.length === 0 && !defaultOption && (
        <option value="" disabled>暂无引擎</option>
      )}
    </Select>
  )
}

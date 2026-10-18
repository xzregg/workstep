import './CoordinatorConfigBar.css'
import { useEffect, useRef, useState } from 'react'
import EngineSelect, { isEngineSelectable } from './EngineSelect'
import Select from './Select'
import Icon from './Icon'
import FloatingMenu, { useFloatingMenu } from './FloatingMenu'
import {
  fetchEngineModels,
  getCachedEngineModels,
  type CoordinatorEngineSummary,
  type EngineConfigField,
  type EngineModel,
  type ProviderInfo,
} from '../api/client'
import { engineLabel } from '../engineMeta'
import { useI18n } from '../i18n'
import StepConfigFields from './StepConfigFields'
import { engineEffortOptions, thinkingEffortLabel } from '../utils/thinkingEffort'

/* ══════════════════════════════════════════
   CoordinatorConfigBar — shared coordinator
   engine/model config row. Rendered inside
   ChatInput's engine/model popover (menu
   variant) for the task conversation and the
   AI flow-design chat so the engine and model
   configuration stays in sync.
   ══════════════════════════════════════════ */

export interface CoordinatorConfigBarProps {
  /** Project scope used to route model reads to a remote WorkStep host. */
  projectId?: string
  /** Available coordinator engines (from coordinator defaults / task config). */
  engines: CoordinatorEngineSummary[]
  /** Currently selected engine id ('' = follow the default). */
  engine: string
  /** Effective/resolved default engine id for the「默认（…）」option label. */
  defaultEngine: string
  model: string
  fastModel: string
  visionModel?: string
  /** '' = follow the engine default. */
  thinkingEffort?: string
  /** Effective default shown when thinkingEffort is empty. */
  defaultThinkingEffort?: string
  /** Enabled providers compatible with the selected engine. */
  providers?: ProviderInfo[]
  /** '' = follow the default provider. */
  providerId?: string
  onEngineChange: (engineId: string) => void
  onProviderChange?: (providerId: string) => void
  onModelChange: (model: string) => void
  onFastModelChange: (model: string) => void
  onVisionModelChange?: (model: string) => void
  /** Show the thinking-effort row only when provided. */
  onThinkingEffortChange?: (value: string) => void
  /** Disable every control (config not loaded / a turn is running). */
  disabled?: boolean
  error?: string
  /** Success notice (e.g. 已保存，将从下一条消息生效). */
  notice?: string
  /** Static right-side hint (e.g. 仅本次生成会话生效). */
  hint?: string
  /** Show the vision-model select (task chat only). */
  showVision?: boolean
  /** Title tooltip on the engine select. */
  engineTitle?: string
  /** bar = right-aligned horizontal row; menu = vertical stack inside a popover. */
  variant?: 'bar' | 'menu'
  /** Open one nested selector when invoked from a slash command. */
  autoOpenField?: 'model' | 'reasoning' | null
  stepFields?: EngineConfigField[]
  stepValues?: Record<string, string>
  onStepFieldChange?: (key: string, value: string) => void
  requireCoordinator?: boolean
  allowDefault?: boolean
}

interface MenuOption {
  value: string
  label: string
  description?: string
  disabled?: boolean
}

interface MenuFieldProps {
  label: string
  title?: string
  value: string
  placeholder: string
  disabled?: boolean
  options: MenuOption[]
  onChange: (value: string) => void
  icon: 'terminal' | 'sparkles' | 'sliders-horizontal' | 'image'
  autoOpen?: boolean
}

/** Codex-style field: a compact row that opens an option menu to the right on click. */
function MenuField({
  label,
  title,
  value,
  placeholder,
  disabled = false,
  options,
  onChange,
  icon,
  autoOpen = false,
}: MenuFieldProps) {
  const rowRef = useRef<HTMLDivElement>(null)
  const autoOpenedRef = useRef(false)
  const { anchor, openFrom, close } = useFloatingMenu()
  const current = options.find((option) => option.value === value)

  useEffect(() => {
    if (!autoOpen) {
      autoOpenedRef.current = false
      return
    }
    if (!disabled && !autoOpenedRef.current) {
      autoOpenedRef.current = true
      openFrom(rowRef.current)
    }
  }, [autoOpen, disabled])

  const handleRowToggle = () => {
    if (disabled) return
    if (anchor) close()
    else openFrom(rowRef.current)
  }

  return (
    <div>
      <div
        ref={rowRef}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-expanded={anchor != null}
        data-open={anchor != null}
        title={title}
        className="chat-input-config-row"
        aria-disabled={disabled || undefined}
        onClick={handleRowToggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            handleRowToggle()
          }
        }}
      >
        <span className="coordinator-config-label">{label}</span>
        <span className="coordinator-config-value">
          {current?.label ?? placeholder}
        </span>
        <Icon name="chevron-right" size={11} strokeWidth={2.5} className="coordinator-config-chevron" />
      </div>
      {anchor && (
        <FloatingMenu
          anchor={anchor}
          triggerRef={rowRef}
          options={options}
          value={value}
          icon={icon}
          width={260}
          onSelect={onChange}
          onClose={close}
        />
      )}
    </div>
  )
}

export default function CoordinatorConfigBar({
  projectId = '',
  engines,
  engine,
  defaultEngine,
  model,
  fastModel,
  visionModel,
  thinkingEffort = '',
  defaultThinkingEffort = '',
  providers = [],
  providerId = '',
  onEngineChange,
  onProviderChange,
  onModelChange,
  onFastModelChange,
  onVisionModelChange,
  onThinkingEffortChange,
  disabled = false,
  error = '',
  notice = '',
  hint = '',
  showVision = false,
  engineTitle,
  variant = 'bar',
  autoOpenField = null,
  stepFields,
  stepValues = {},
  onStepFieldChange,
  requireCoordinator = true,
  allowDefault = true,
}: CoordinatorConfigBarProps) {
  const { t } = useI18n()
  const [catalog, setCatalog] = useState<{ scope: string; models: EngineModel[] }>({ scope: '', models: [] })

  const engineId = engine || defaultEngine
  const selectedEngine = engines.find((item) => item.id === engineId)
  const supportsProvider = Boolean(selectedEngine?.supports_provider)
  const compatibleProviders = providers.filter((item) => (
    item.enabled && (selectedEngine?.provider_protocols || []).some((protocol) =>
      (item.protocols?.length ? item.protocols : [item.protocol]).includes(protocol),
    )
  ))
  const catalogScope = `${engineId}::${supportsProvider ? providerId : ''}::${projectId || ''}`
  const models = catalog.scope === catalogScope ? catalog.models : []
  const thinkingOptions = engineEffortOptions(selectedEngine)
  useEffect(() => {
    if (!engineId) {
      setCatalog({ scope: catalogScope, models: [] })
      return
    }
    const effectiveProvider = supportsProvider ? providerId : ''
    const cached = getCachedEngineModels(engineId, effectiveProvider, projectId)
    if (cached) {
      setCatalog({ scope: catalogScope, models: cached.models || [] })
      return
    }
    let active = true
    fetchEngineModels(engineId, false, effectiveProvider, projectId)
      .then((result) => {
        if (active) setCatalog({ scope: catalogScope, models: result.models || [] })
      })
      .catch(() => {
        if (active) setCatalog({ scope: catalogScope, models: [] })
      })
    return () => { active = false }
  }, [engineId, providerId, supportsProvider, projectId, catalogScope])

  const modelDisabled = disabled || models.length === 0
  const isMenu = variant === 'menu'
  const effectiveThinkingEffort = defaultThinkingEffort
  const thinkingEffortDefaultLabel = effectiveThinkingEffort
    ? `${t('coord.thinkingEffortDefault')}（${
      thinkingEffortLabel(effectiveThinkingEffort, t, thinkingOptions)
    }）`
    : t('coord.thinkingEffortDefault')
  return (
    <div className={`coordinator-config coordinator-config--${isMenu ? 'menu' : 'bar'}`}>
      {!isMenu && (
        <span className="coordinator-config-label">{t('coord.engineModel')}</span>
      )}
      {isMenu ? (
        <>
          <MenuField
            label={t('coord.engine')}
            title={engineTitle ?? t('coord.engineTitle')}
            value={engine}
            placeholder={t('coord.defaultOption', { engine: engineLabel(defaultEngine || 'claude', t) })}
            disabled={disabled}
            icon="terminal"
            onChange={onEngineChange}
            options={[
              ...(allowDefault ? [{
                value: '',
                label: t('coord.defaultOption', { engine: engineLabel(defaultEngine || 'claude', t) }),
              }] : []),
              ...engines
                .filter((item) => item.enabled !== false && (item.installed || item.built_in))
                .map((item) => ({
                  value: item.id,
                  label: engineLabel(item.id, t),
                  disabled: !isEngineSelectable(item, requireCoordinator),
                })),
            ]}
          />
          {!stepFields && supportsProvider && onProviderChange && (
            <MenuField
              label={t('coord.provider')}
              title={t('coord.providerTitle')}
              value={providerId}
              placeholder={t('coord.providerFollow')}
              disabled={disabled}
              icon="terminal"
              onChange={onProviderChange}
              options={[
                { value: '', label: t('coord.providerFollow') },
                ...compatibleProviders
                  .map((item) => ({ value: item.id, label: item.name || item.id })),
              ]}
            />
          )}
          <MenuField
            autoOpen={autoOpenField === 'model'}
            label={t('coord.reasoning')}
            title={t('coord.reasoningTitle')}
            value={model}
            placeholder={t('coord.reasoningDefault')}
            disabled={modelDisabled}
            icon="sparkles"
            onChange={onModelChange}
            options={[
              { value: '', label: t('coord.reasoningDefault') },
              ...models.map((m) => ({ value: m.id, label: m.label || m.id, description: m.description || undefined })),
            ]}
          />
          {!stepFields && <MenuField
            label={t('coord.fast')}
            title={t('coord.fastTitle')}
            value={fastModel}
            placeholder={t('coord.fastFollow')}
            disabled={modelDisabled}
            icon="sparkles"
            onChange={onFastModelChange}
            options={[
              { value: '', label: t('coord.fastFollow') },
              ...models.map((m) => ({ value: m.id, label: m.label || m.id, description: m.description || undefined })),
            ]}
          />}
          {!stepFields && showVision && onVisionModelChange && (
            <MenuField
              label={t('coord.vision')}
              title={t('coord.visionTitle')}
              value={visionModel || ''}
              placeholder={t('coord.visionFollow')}
              disabled={modelDisabled}
              icon="image"
              onChange={onVisionModelChange}
              options={[
                { value: '', label: t('coord.visionFollow') },
                ...models.map((m) => ({ value: m.id, label: m.label || m.id, description: m.description || undefined })),
              ]}
            />
          )}
          {!stepFields && onThinkingEffortChange && (
            <MenuField
              autoOpen={autoOpenField === 'reasoning'}
              label={t('coord.thinkingEffort')}
              title={t('coord.thinkingEffortTitle')}
              value={thinkingEffort}
              placeholder={thinkingEffortDefaultLabel}
              disabled={disabled}
              icon="sliders-horizontal"
              onChange={onThinkingEffortChange}
              options={[
                { value: '', label: thinkingEffortDefaultLabel },
                ...thinkingOptions.map((option) => ({
                  value: option.value,
                  label: thinkingEffortLabel(option.value, t, thinkingOptions),
                })),
              ]}
            />
          )}
          {stepFields && onStepFieldChange && (
            <StepConfigFields
              engineId={engineId}
              fields={stepFields}
              values={stepValues}
              onChange={onStepFieldChange}
            />
          )}
        </>
      ) : (
        <>
          <EngineSelect
            engines={engines}
            value={engine}
            disabled={disabled}
            onChange={onEngineChange}
            requireCoordinator={requireCoordinator}
            defaultOption={allowDefault ? {
              value: '',
              label: t('coord.defaultOption', { engine: engineLabel(defaultEngine || 'claude', t) }),
            } : undefined}
            ariaLabel={t('coord.engineAria')}
            title={engineTitle ?? t('coord.engineTitle')}
            className="coordinator-config-engine"
          />
          {supportsProvider && onProviderChange && (
            <Select
              value={providerId}
              disabled={disabled}
              onChange={(event) => onProviderChange(event.target.value)}
              title={t('coord.providerTitle')}
              className="coordinator-config-select"
            >
              <option value="">{t('coord.providerFollow')}</option>
              {compatibleProviders.map((item) => (
                <option key={item.id} value={item.id}>{item.name || item.id}</option>
              ))}
            </Select>
          )}
          <Select
            value={model}
            disabled={modelDisabled}
            onChange={(event) => onModelChange(event.target.value)}
            title={t('coord.reasoningTitle')}
            className="coordinator-config-select"
          >
            <option value="">{t('coord.reasoningDefault')}</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.label || m.id}</option>
            ))}
          </Select>
          <Select
            value={fastModel}
            disabled={modelDisabled}
            onChange={(event) => onFastModelChange(event.target.value)}
            title={t('coord.fastTitle')}
            className="coordinator-config-select"
          >
            <option value="">{t('coord.fastFollow')}</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.label || m.id}</option>
            ))}
          </Select>
          {showVision && onVisionModelChange && (
            <Select
              value={visionModel || ''}
              disabled={modelDisabled}
              onChange={(event) => onVisionModelChange(event.target.value)}
              title={t('coord.visionTitle')}
              className="coordinator-config-select"
            >
              <option value="">{t('coord.visionFollow')}</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.label || m.id}</option>
              ))}
            </Select>
          )}
          {onThinkingEffortChange && (
            <Select
              value={thinkingEffort}
              disabled={disabled}
              onChange={(event) => onThinkingEffortChange(event.target.value)}
              title={t('coord.thinkingEffortTitle')}
              className="coordinator-config-select"
            >
              <option value="">{thinkingEffortDefaultLabel}</option>
              {thinkingOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {thinkingEffortLabel(option.value, t, thinkingOptions)}
                </option>
              ))}
            </Select>
          )}
        </>
      )}
      {error ? (
        <span className="coordinator-config-status coordinator-config-status--error" data-state="error">{error}</span>
      ) : notice ? (
        <span className="coordinator-config-status coordinator-config-status--success" data-state="success">{notice}</span>
      ) : hint ? (
        <span className="coordinator-config-status">{hint}</span>
      ) : null}
    </div>
  )
}

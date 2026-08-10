import { useEffect, useState, type CSSProperties } from 'react'
import EngineSelect from './EngineSelect'
import Select from './Select'
import {
  fetchEngineModels,
  getCachedEngineModels,
  type CoordinatorEngineSummary,
  type EngineModel,
} from '../api/client'
import { engineLabel } from '../engineMeta'
import { useI18n } from '../i18n'

/* ══════════════════════════════════════════
   CoordinatorConfigBar — shared coordinator
   engine/model config row. Rendered inside
   ChatInput's engine/model popover (menu
   variant) for the task conversation and the
   AI flow-design chat so the engine and model
   configuration stays in sync.
   ══════════════════════════════════════════ */

export interface CoordinatorConfigBarProps {
  /** Available coordinator engines (from coordinator defaults / task config). */
  engines: CoordinatorEngineSummary[]
  /** Currently selected engine id ('' = follow the default). */
  engine: string
  /** Effective/resolved default engine id for the「默认（…）」option label. */
  defaultEngine: string
  model: string
  fastModel: string
  visionModel?: string
  onEngineChange: (engineId: string) => void
  onModelChange: (model: string) => void
  onFastModelChange: (model: string) => void
  onVisionModelChange?: (model: string) => void
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
}

const selectStyle: CSSProperties = {
  fontSize: 11, border: '1px solid var(--border)',
  borderRadius: 6, background: 'var(--bg)', color: 'var(--fg)', padding: '2px 5px',
}

export default function CoordinatorConfigBar({
  engines,
  engine,
  defaultEngine,
  model,
  fastModel,
  visionModel,
  onEngineChange,
  onModelChange,
  onFastModelChange,
  onVisionModelChange,
  disabled = false,
  error = '',
  notice = '',
  hint = '',
  showVision = false,
  engineTitle,
  variant = 'bar',
}: CoordinatorConfigBarProps) {
  const { t } = useI18n()
  const [models, setModels] = useState<EngineModel[]>([])

  const engineId = engine || defaultEngine
  useEffect(() => {
    if (!engineId) {
      setModels([])
      return
    }
    const cached = getCachedEngineModels(engineId)
    if (cached) {
      setModels(cached.models || [])
      return
    }
    let active = true
    fetchEngineModels(engineId)
      .then((result) => {
        if (active) setModels(result.models || [])
      })
      .catch(() => {
        if (active) setModels([])
      })
    return () => { active = false }
  }, [engineId])

  const modelDisabled = disabled || models.length === 0
  const isMenu = variant === 'menu'
  const fieldStyle: CSSProperties = isMenu
    ? { ...selectStyle, flex: 1, minWidth: 0, maxWidth: 'none' }
    : { ...selectStyle, maxWidth: 140 }
  const engineStyle: CSSProperties = isMenu
    ? { ...selectStyle, width: '100%', maxWidth: 'none' }
    : { ...selectStyle, maxWidth: 170 }
  const statusStyle: CSSProperties = {
    fontSize: 11,
    ...(isMenu ? { marginTop: 2 } : {}),
  }
  const menuLabel: CSSProperties = {
    width: 64, flexShrink: 0, fontSize: 11, color: 'var(--meta)', lineHeight: 1,
  }
  const menuRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 }

  return (
    <div style={isMenu
      ? { display: 'flex', flexDirection: 'column', gap: 6 }
      : {
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6,
        flexWrap: 'wrap', rowGap: 6, marginBottom: 8,
      }}
    >
      {!isMenu && (
        <span style={{ fontSize: 11, color: 'var(--meta)' }}>{t('coord.engineModel')}</span>
      )}
      {isMenu ? (
        <>
          <div style={menuRow}>
            <span style={menuLabel}>{t('coord.engine')}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <EngineSelect
                engines={engines}
                value={engine}
                disabled={disabled}
                onChange={onEngineChange}
                requireCoordinator
                defaultOption={{
                  value: '',
                  label: t('coord.defaultOption', { engine: engineLabel(defaultEngine || 'claude', t) }),
                }}
                ariaLabel={t('coord.engineAria')}
                title={engineTitle ?? t('coord.engineTitle')}
                style={engineStyle}
              />
            </div>
          </div>
          <div style={menuRow}>
            <span style={menuLabel}>{t('coord.reasoning')}</span>
            <Select
              value={model}
              disabled={modelDisabled}
              onChange={(event) => onModelChange(event.target.value)}
              title={t('coord.reasoningTitle')}
              style={fieldStyle}
            >
              <option value="">{t('coord.reasoningDefault')}</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.label || m.id}</option>
              ))}
            </Select>
          </div>
          <div style={menuRow}>
            <span style={menuLabel}>{t('coord.fast')}</span>
            <Select
              value={fastModel}
              disabled={modelDisabled}
              onChange={(event) => onFastModelChange(event.target.value)}
              title={t('coord.fastTitle')}
              style={fieldStyle}
            >
              <option value="">{t('coord.fastFollow')}</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.label || m.id}</option>
              ))}
            </Select>
          </div>
          {showVision && onVisionModelChange && (
            <div style={menuRow}>
              <span style={menuLabel}>{t('coord.vision')}</span>
              <Select
                value={visionModel || ''}
                disabled={modelDisabled}
                onChange={(event) => onVisionModelChange(event.target.value)}
                title={t('coord.visionTitle')}
                style={fieldStyle}
              >
                <option value="">{t('coord.visionFollow')}</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{m.label || m.id}</option>
                ))}
              </Select>
            </div>
          )}
        </>
      ) : (
        <>
          <EngineSelect
            engines={engines}
            value={engine}
            disabled={disabled}
            onChange={onEngineChange}
            requireCoordinator
            defaultOption={{
              value: '',
              label: t('coord.defaultOption', { engine: engineLabel(defaultEngine || 'claude', t) }),
            }}
            ariaLabel={t('coord.engineAria')}
            title={engineTitle ?? t('coord.engineTitle')}
            style={engineStyle}
          />
          <Select
            value={model}
            disabled={modelDisabled}
            onChange={(event) => onModelChange(event.target.value)}
            title={t('coord.reasoningTitle')}
            style={fieldStyle}
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
            style={fieldStyle}
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
              style={fieldStyle}
            >
              <option value="">{t('coord.visionFollow')}</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.label || m.id}</option>
              ))}
            </Select>
          )}
        </>
      )}
      {error ? (
        <span style={{ ...statusStyle, color: 'var(--danger)' }}>{error}</span>
      ) : notice ? (
        <span style={{ ...statusStyle, color: 'var(--success)' }}>{notice}</span>
      ) : hint ? (
        <span style={{ ...statusStyle, color: 'var(--meta)' }}>{hint}</span>
      ) : null}
    </div>
  )
}

import { useEffect, useState, type CSSProperties } from 'react'
import EngineSelect from './EngineSelect'
import {
  fetchEngineModels,
  getCachedEngineModels,
  type CoordinatorEngineSummary,
  type EngineModel,
} from '../api/client'
import { engineLabel } from '../engineMeta'

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
  engineTitle = '协调引擎',
  variant = 'bar',
}: CoordinatorConfigBarProps) {
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
        <span style={{ fontSize: 11, color: 'var(--meta)' }}>引擎/模型</span>
      )}
      {isMenu ? (
        <>
          <div style={menuRow}>
            <span style={menuLabel}>引擎</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <EngineSelect
                engines={engines}
                value={engine}
                disabled={disabled}
                onChange={onEngineChange}
                requireCoordinator
                defaultOption={{
                  value: '',
                  label: `默认（${engineLabel(defaultEngine || 'claude')}）`,
                }}
                ariaLabel="协调引擎"
                title={engineTitle}
                style={engineStyle}
              />
            </div>
          </div>
          <div style={menuRow}>
            <span style={menuLabel}>推理</span>
            <select
              value={model}
              disabled={modelDisabled}
              onChange={(event) => onModelChange(event.target.value)}
              title="推理模型：负责理解、决策与回复；从下一条消息生效"
              style={fieldStyle}
            >
              <option value="">推理模型（默认）</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.label || m.id}</option>
              ))}
            </select>
          </div>
          <div style={menuRow}>
            <span style={menuLabel}>快速</span>
            <select
              value={fastModel}
              disabled={modelDisabled}
              onChange={(event) => onFastModelChange(event.target.value)}
              title="快速模型：负责读取产物和修复结构化输出；从下一条消息生效"
              style={fieldStyle}
            >
              <option value="">快速模型（跟随推理）</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.label || m.id}</option>
              ))}
            </select>
          </div>
          {showVision && onVisionModelChange && (
            <div style={menuRow}>
              <span style={menuLabel}>图片理解</span>
              <select
                value={visionModel || ''}
                disabled={modelDisabled}
                onChange={(event) => onVisionModelChange(event.target.value)}
                title="图片理解模型：主模型不支持图片输入时，用于分析图片和截图内容；从下一条消息生效"
                style={fieldStyle}
              >
                <option value="">图片理解（跟随推理）</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{m.label || m.id}</option>
                ))}
              </select>
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
              label: `默认（${engineLabel(defaultEngine || 'claude')}）`,
            }}
            ariaLabel="协调引擎"
            title={engineTitle}
            style={engineStyle}
          />
          <select
            value={model}
            disabled={modelDisabled}
            onChange={(event) => onModelChange(event.target.value)}
            title="推理模型：负责理解、决策与回复；从下一条消息生效"
            style={fieldStyle}
          >
            <option value="">推理模型（默认）</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.label || m.id}</option>
            ))}
          </select>
          <select
            value={fastModel}
            disabled={modelDisabled}
            onChange={(event) => onFastModelChange(event.target.value)}
            title="快速模型：负责读取产物和修复结构化输出；从下一条消息生效"
            style={fieldStyle}
          >
            <option value="">快速模型（跟随推理）</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.label || m.id}</option>
            ))}
          </select>
          {showVision && onVisionModelChange && (
            <select
              value={visionModel || ''}
              disabled={modelDisabled}
              onChange={(event) => onVisionModelChange(event.target.value)}
              title="图片理解模型：主模型不支持图片输入时，用于分析图片和截图内容；从下一条消息生效"
              style={fieldStyle}
            >
              <option value="">图片理解（跟随推理）</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.label || m.id}</option>
              ))}
            </select>
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

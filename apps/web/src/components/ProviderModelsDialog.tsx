import { useMemo, useState } from 'react'
import ResizablePanel from './ResizablePanel'
import Button from './Button'
import type { EngineModel } from '../api/client'
import { useI18n } from '../i18n'
import './ProviderModelsDialog.css'

interface Props {
  providerName: string
  protocolLabel: string
  models: EngineModel[]
  initialSelected: string[]
  saving: boolean
  saveError: string
  onToggle: (id: string) => void
  onSelectAll: (ids: string[]) => void
  onClear: (ids: string[]) => void
  onConfirm: () => void
  onClose: () => void
}

export default function ProviderModelsDialog({
  providerName,
  protocolLabel,
  models,
  initialSelected,
  saving,
  saveError,
  onToggle,
  onSelectAll,
  onClear,
  onConfirm,
  onClose,
}: Props) {
  const { t } = useI18n()
  const [keyword, setKeyword] = useState('')
  const filtered = useMemo(() => {
    const text = keyword.trim().toLowerCase()
    if (!text) return models
    return models.filter((model) =>
      `${model.id} ${model.label || ''}`.toLowerCase().includes(text),
    )
  }, [keyword, models])
  const selected = useMemo(() => new Set(initialSelected), [initialSelected])
  const allFilteredSelected = filtered.length > 0 && filtered.every((model) => selected.has(model.id))
  const hasKeyword = keyword.trim().length > 0
  const selectAllLabel = allFilteredSelected
    ? (hasKeyword ? t('providerSettings.modelsClearFiltered') : t('providerSettings.modelsClearAll'))
    : (hasKeyword ? t('providerSettings.modelsSelectFiltered') : t('providerSettings.modelsSelectAll'))

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`${providerName} · ${protocolLabel}`}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <ResizablePanel
        className="modal"
        style={{ width: 'min(640px, 92vw)', height: 'min(560px, 84vh)' }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <span className="modal-title">{providerName} · {protocolLabel}</span>
          <Button variant="icon" aria-label={t('settings.closeSettings')} onClick={onClose}>✕</Button>
        </div>
        <div className="provider-models-dialog">
          <div className="provider-models-dialog-toolbar">
            <input
              className="provider-models-dialog-search"
              value={keyword}
              placeholder={t('providerSettings.modelsSearchPlaceholder')}
              onChange={(event) => setKeyword(event.target.value)}
            />
            <Button
              variant="ghost"
              disabled={filtered.length === 0}
              onClick={() => {
                const ids = filtered.map((model) => model.id)
                if (allFilteredSelected) onClear(ids)
                else onSelectAll(ids)
              }}
            >
              {selectAllLabel}
            </Button>
            <span className="provider-models-dialog-count">
              {t('providerSettings.modelsSelected', { count: initialSelected.length })}
            </span>
          </div>
          <div role="list" className="provider-models-dialog-list">
            {filtered.length === 0 ? (
              <div className="provider-models-dialog-empty">{t('providerSettings.modelsSearchEmpty')}</div>
            ) : (
              filtered.map((model) => {
                const checked = selected.has(model.id)
                return (
                  <label key={model.id} role="listitem" className="provider-models-dialog-item">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggle(model.id)}
                    />
                    <span className="provider-models-dialog-item-text" title={model.description || model.label || model.id}>
                      {model.label || model.id}
                    </span>
                  </label>
                )
              })
            )}
          </div>
          {saveError && (
            <div role="alert" className="provider-models-dialog-error">{saveError}</div>
          )}
          <div className="provider-models-dialog-footer">
            <Button variant="ghost" disabled={saving} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" disabled={saving || initialSelected.length === 0} loading={saving} onClick={onConfirm}>
              {t('providerSettings.modelsSaveSelected', { count: initialSelected.length })}
            </Button>
          </div>
        </div>
      </ResizablePanel>
    </div>
  )
}
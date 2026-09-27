import { useCallback, useEffect, useRef, useState } from 'react'
import ResizablePanel from './ResizablePanel'
import Button from './Button'
import Icon from './Icon'
import { providerApi, type ProviderImportResult, type ProviderImportSource, type ProviderTypeMeta } from '../api/client'
import { useI18n } from '../i18n'
import './ProviderImportDialog.css'
import {
  filterProviderImportCandidates,
  providerImportTabs,
  selectableProviderImportIds,
  toggleProviderImportSelection,
} from '../utils/providerImport'

interface Props {
  types: ProviderTypeMeta[]
  onClose: () => void
  onImported: () => void | Promise<void>
}

function ImportCheckboxMark({ checked }: { checked: boolean }) {
  return (
    <span className="provider-import-check" data-checked={checked} aria-hidden="true">
      {checked ? '✓' : ''}
    </span>
  )
}

export default function ProviderImportDialog({ types, onClose, onImported }: Props) {
  const { t } = useI18n()
  const translateRef = useRef(t)
  translateRef.current = t
  const [importSources, setImportSources] = useState<ProviderImportSource[]>([])
  const [importLoading, setImportLoading] = useState(false)
  const [importError, setImportError] = useState('')
  const [importSourceId, setImportSourceId] = useState('')
  const [importSourceType, setImportSourceType] = useState('all')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [importSaving, setImportSaving] = useState(false)
  const [importResult, setImportResult] = useState<ProviderImportResult | null>(null)
  const typeLabel = (id: string) => types.find((item) => item.id === id)?.label ?? id

  const loadImportSources = useCallback(async () => {
    setImportLoading(true)
    setImportError('')
    try {
      const result = await providerApi.importSources()
      setImportSources(result.sources)
    } catch (reason) {
      setImportError(reason instanceof Error ? reason.message : translateRef.current('providerSettings.importLoadFailed'))
    } finally {
      setImportLoading(false)
    }
  }, [])

  useEffect(() => { void loadImportSources() }, [loadImportSources])

  const closeImport = () => {
    if (!importSaving) onClose()
  }

  const toggleCandidate = (id: string) => {
    setSelectedIds((current) => toggleProviderImportSelection(current, id))
  }

  const importSelected = async () => {
    if (selectedIds.length === 0 || !importSourceId) return
    setImportSaving(true)
    setImportResult(null)
    setImportError('')
    try {
      const result = await providerApi.importFromCcSwitch(selectedIds)
      setImportResult(result)
      setSelectedIds([])
      if (result.imported.length > 0) {
        await onImported()
      }
      await loadImportSources()
    } catch (reason) {
      setImportError(reason instanceof Error ? reason.message : t('providerSettings.importLoadFailed'))
    } finally {
      setImportSaving(false)
    }
  }

  const activeImportSource = importSources.find((source) => source.id === importSourceId) ?? null
  const importTabs = providerImportTabs(
    activeImportSource?.providers ?? [],
    t('providerSettings.importAllTypes'),
  )
  const visibleImportCandidates = filterProviderImportCandidates(
    activeImportSource?.providers ?? [],
    importSourceType,
  )
  const selectableImportIds = selectableProviderImportIds(visibleImportCandidates)
  const allSelectableImportsSelected = selectableImportIds.length > 0
    && selectableImportIds.every((id) => selectedIds.includes(id))
  return (
        <div
          className="modal-overlay provider-import-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t('providerSettings.importTitle')}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeImport()
          }}
        >
          <ResizablePanel
            className="modal provider-import-panel"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-header provider-import-header">
              <span className="modal-title">{t('providerSettings.importTitle')}</span>
              <Button variant="icon" aria-label={t('settings.closeSettings')} onClick={closeImport}>✕</Button>
            </div>
            <div className="modal-body provider-import-body">
              <p className="provider-import-intro">
                {t('providerSettings.importIntro')}
              </p>
              {!importSourceId ? (
                <>
                  {importLoading && importSources.length === 0 ? (
                    <div className="provider-import-empty provider-import-empty--loading">
                      {t('settings.readingEngines')}
                    </div>
                  ) : importSources.length === 0 ? (
                    <div className="provider-import-empty">
                      {t('providerSettings.importSourcesEmpty')}
                    </div>
                  ) : (
                    <div className="provider-import-sources">
                      {importSources.map((source) => (
                        <button
                          key={source.id}
                          type="button"
                          onClick={() => {
                            setImportSourceId(source.id)
                            setImportSourceType('all')
                            setSelectedIds([])
                            setImportResult(null)
                          }}
                          className="provider-import-source"
                        >
                          <span className="provider-import-source-mark">
                            {source.name.slice(0, 2).toUpperCase()}
                          </span>
                          <span className="provider-import-source-content">
                            <span className="provider-import-source-name">
                              {source.name}
                            </span>
                            <span className="provider-import-source-description">
                              {source.description}
                            </span>
                          </span>
                          <span className="provider-import-source-count">
                            {source.provider_count}
                          </span>
                          <Icon name="chevron-right" size={16} strokeWidth={2} />
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="provider-import-refresh-row">
                    <Button
                      variant="ghost"
                      disabled={importLoading}
                      loading={importLoading}
                      onClick={() => void loadImportSources()}
                    >
                      {t('providerSettings.importRefresh')}
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  {activeImportSource && activeImportSource.providers.length === 0 ? (
                    <div className="provider-import-empty">
                      {t('providerSettings.importProvidersEmpty')}
                    </div>
                  ) : (
                    <>
                      <div
                        className="provider-import-tabs"
                        role="tablist"
                        aria-label={t('providerSettings.importTypeTabs')}
                      >
                        {importTabs.map((tab) => {
                          const active = importSourceType === tab.id
                          return (
                            <button
                              key={tab.id}
                              type="button"
                              role="tab"
                              aria-selected={active}
                              onClick={() => setImportSourceType(tab.id)}
                              className="provider-import-tab"
                            >
                              {tab.label}
                              <span className="provider-import-tab-count">{tab.count}</span>
                            </button>
                          )
                        })}
                      </div>
                      <button
                        className="provider-import-select-all"
                        type="button"
                        role="checkbox"
                        aria-checked={allSelectableImportsSelected}
                        disabled={selectableImportIds.length === 0}
                        onClick={() => setSelectedIds((current) => (
                          allSelectableImportsSelected
                            ? current.filter((id) => !selectableImportIds.includes(id))
                            : [...new Set([...current, ...selectableImportIds])]
                        ))}
                      >
                        <ImportCheckboxMark checked={allSelectableImportsSelected} />
                        {t('providerSettings.importSelectAll')}
                      </button>
                      <div className="provider-import-candidates">
                        {visibleImportCandidates.map((candidate) => {
                          const checked = selectedIds.includes(candidate.id)
                          const disabled = Boolean(candidate.error) || candidate.already_exists
                          return (
                            <button
                              className="provider-import-candidate"
                              type="button"
                              role="checkbox"
                              aria-checked={checked}
                              disabled={disabled}
                              onClick={() => toggleCandidate(candidate.id)}
                              key={candidate.id}
                            >
                            <ImportCheckboxMark checked={checked} />
                            <div className="provider-import-candidate-content">
                              <div className="provider-import-candidate-heading">
                                <span className="provider-import-candidate-name">{candidate.name}</span>
                                <span className="provider-import-type-badge">
                                  {typeLabel(candidate.type)}
                                </span>
                                <span className="provider-import-origin-badge">
                                  {candidate.source_type}
                                </span>
                                {candidate.already_exists && (
                                  <span className="provider-import-existing-badge">
                                    {t('providerSettings.importAlready')}
                                  </span>
                                )}
                              </div>
                              <div className="provider-import-candidate-url">
                                {candidate.base_url}
                                <span className="provider-import-key-state">
                                  {candidate.has_key ? t('providerSettings.hasKey') : t('providerSettings.noKey')}
                                </span>
                              </div>
                              {candidate.error && (
                                <div className="provider-import-candidate-error">
                                  {candidate.error}
                                </div>
                              )}
                            </div>
                            </button>
                          )
                        })}
                      </div>
                    </>
                  )}
                  <div className="field-hint provider-import-feedback" aria-live="polite">
                    {importResult && (
                      <span className="provider-import-result">
                        {importResult.imported.length > 0 && (
                          <span className="provider-import-result-success">
                            {t('providerSettings.importImported', { count: importResult.imported.length })}
                          </span>
                        )}
                        {importResult.skipped.length > 0 && (
                          <span className="provider-import-result-skipped">
                            {t('providerSettings.importSkipped', { count: importResult.skipped.length })}
                          </span>
                        )}
                        {importResult.errors.length > 0 && (
                          <span className="provider-import-result-errors">
                            {t('providerSettings.importErrors', { count: importResult.errors.length })}
                          </span>
                        )}
                      </span>
                    )}
                    {importError && (
                      <span className="provider-import-error">{importError}</span>
                    )}
                  </div>
                  <div className="provider-import-footer">
                    <Button
                      variant="ghost"
                      disabled={importSaving}
                      onClick={() => {
                        setImportSourceId('')
                        setImportSourceType('all')
                        setSelectedIds([])
                        setImportResult(null)
                        setImportError('')
                      }}
                    >
                      {t('providerSettings.importBack')}
                    </Button>
                    <div className="provider-import-footer-actions">
                      <Button
                        variant="ghost"
                        disabled={importLoading || importSaving}
                        loading={importLoading}
                        onClick={() => void loadImportSources()}
                      >
                        {t('providerSettings.importRefresh')}
                      </Button>
                      <Button
                        className="provider-import-submit"
                        variant="primary"
                        disabled={selectedIds.length === 0 || importLoading || importSaving}
                        loading={importSaving}
                        onClick={() => void importSelected()}
                      >
                        {t('providerSettings.importSelected', { count: selectedIds.length })}
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </ResizablePanel>
        </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import Button from '../components/Button'
import ConfirmDialog from '../components/ConfirmDialog'
import Field from '../components/Field'
import Icon from '../components/Icon'
import Input from '../components/Input'
import Select from '../components/Select'
import {
  providerApi,
  type EngineModel,
  type ProviderInfo,
  type ProviderImportResult,
  type ProviderImportSource,
  type ProviderTypeMeta,
} from '../api/client'
import { useI18n } from '../i18n'
import {
  filterProviderImportCandidates,
  providerImportTabs,
  selectableProviderImportIds,
  toggleProviderImportSelection,
} from '../utils/providerImport'

interface Props {
  /** 供应商变更后回调（设置页据此刷新引擎列表，同步 Pydantic AI 的供应商下拉） */
  onChanged?: () => void
}

interface ProviderForm {
  name: string
  type: string
  protocol: string
  base_url: string
  api_key: string
  clear_key: boolean
}

const EMPTY_FORM: ProviderForm = {
  name: '',
  type: 'custom',
  protocol: 'openai_chat_completions',
  base_url: '',
  api_key: '',
  clear_key: false,
}

function ProviderBadge({ verified, enabled }: { verified: boolean; enabled: boolean }) {
  const { t } = useI18n()
  if (!enabled) {
    return (
      <span style={{
        padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
        background: 'var(--surface)', color: 'var(--meta)',
      }}>
        {t('providerSettings.disabledBadge')}
      </span>
    )
  }
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
      color: verified ? 'var(--success)' : 'var(--warn)',
      background: verified
        ? 'color-mix(in oklab, var(--success), transparent 88%)'
        : 'color-mix(in oklab, var(--warn), transparent 88%)',
    }}>
      {verified ? t('providerSettings.verified') : t('providerSettings.notVerified')}
    </span>
  )
}

function ImportCheckboxMark({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 16, height: 16, flexShrink: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        borderRadius: 4, fontSize: 12, fontWeight: 800, lineHeight: 1,
        color: '#fff',
        background: checked ? 'var(--accent)' : 'var(--bg)',
        border: checked ? '1px solid var(--accent)' : '1px solid var(--border)',
      }}
    >
      {checked ? '✓' : ''}
    </span>
  )
}

export default function ProviderSettings({ onChanged }: Props) {
  const { t } = useI18n()
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [types, setTypes] = useState<ProviderTypeMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM)
  const [formError, setFormError] = useState('')
  const [formSaving, setFormSaving] = useState(false)
  const [keyRevealed, setKeyRevealed] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message: string }>>({})
  const [modelsLoadingId, setModelsLoadingId] = useState<string | null>(null)
  const [modelCounts, setModelCounts] = useState<Record<string, number>>({})
  const [modelFetchedAt, setModelFetchedAt] = useState<Record<string, string | null>>({})
  const [modelErrors, setModelErrors] = useState<Record<string, string>>({})
  const [modelLists, setModelLists] = useState<Record<string, EngineModel[]>>({})
  const [deleting, setDeleting] = useState<ProviderInfo | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [importSources, setImportSources] = useState<ProviderImportSource[]>([])
  const [importLoading, setImportLoading] = useState(false)
  const [importError, setImportError] = useState('')
  const [importSourceId, setImportSourceId] = useState('')
  const [importSourceType, setImportSourceType] = useState('all')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [importSaving, setImportSaving] = useState(false)
  const [importResult, setImportResult] = useState<ProviderImportResult | null>(null)
  const initialized = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const result = await providerApi.list()
      setProviders(result.providers)
      setTypes(result.types)
      setModelCounts(Object.fromEntries(
        result.providers.map((item) => [item.id, item.model_count]),
      ))
      setModelFetchedAt(Object.fromEntries(
        result.providers.map((item) => [item.id, item.models_fetched_at]),
      ))
      const lists: Record<string, EngineModel[]> = {}
      await Promise.all(
        result.providers
          .filter((item) => item.models_fetched_at)
          .map(async (item) => {
            try {
              const models = await providerApi.models(item.id, false)
              lists[item.id] = models.models
            } catch {
              // 缓存读取失败时保持空列表，行内状态仍会显示获取时间
            }
          }),
      )
      setModelLists(lists)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('providerSettings.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    void refresh()
  }, [refresh])

  const typeLabel = (id: string) => types.find((item) => item.id === id)?.label ?? id
  const typeDefaultBaseUrl = (id: string) => types.find((item) => item.id === id)?.default_base_url ?? ''
  const typeDefaultProtocol = (id: string) => types.find((item) => item.id === id)?.default_protocol ?? 'openai_chat_completions'

  const openCreate = () => {
    setEditingId(null)
    const typeId = types[0]?.id ?? 'custom'
    setForm({
      ...EMPTY_FORM,
      type: typeId,
      protocol: typeDefaultProtocol(typeId),
      base_url: typeDefaultBaseUrl(typeId),
    })
    setFormError('')
    setKeyRevealed(false)
    setFormOpen(true)
  }

  const openEdit = (provider: ProviderInfo) => {
    setEditingId(provider.id)
    setForm({
      name: provider.name,
      type: provider.type,
      protocol: provider.protocol,
      base_url: provider.base_url,
      api_key: '',
      clear_key: false,
    })
    setFormError('')
    setKeyRevealed(false)
    setFormOpen(true)
  }

  const closeForm = () => {
    setFormOpen(false)
    setEditingId(null)
    setForm(EMPTY_FORM)
    setFormError('')
    setKeyRevealed(false)
  }

  const changeType = (typeId: string) => {
    setForm((current) => {
      const defaultUrl = typeDefaultBaseUrl(typeId)
      // 类型切换时预填默认地址（仅当用户尚未自定义输入时）
      const keepUrl = current.base_url && current.base_url !== typeDefaultBaseUrl(current.type)
      return {
        ...current,
        type: typeId,
        protocol: typeDefaultProtocol(typeId),
        base_url: keepUrl ? current.base_url : defaultUrl,
      }
    })
    setFormError('')
  }

  const toggleReveal = async () => {
    if (keyRevealed) {
      setKeyRevealed(false)
      return
    }
    if (!editingId) {
      setKeyRevealed(true)
      return
    }
    const provider = providers.find((item) => item.id === editingId)
    if (!provider?.has_key) {
      setKeyRevealed(true)
      return
    }
    try {
      const result = await providerApi.reveal(editingId)
      setForm((current) => ({ ...current, api_key: result.value || '' }))
      setKeyRevealed(true)
    } catch {
      setFormError(t('providerSettings.saveFailed'))
    }
  }

  const save = async () => {
    const name = form.name.trim()
    const baseUrl = form.base_url.trim()
    if (!name) {
      setFormError(t('providerSettings.needsName'))
      return
    }
    if (!baseUrl) {
      setFormError(t('providerSettings.needsBaseUrl'))
      return
    }
    setFormSaving(true)
    setFormError('')
    try {
      const result = await providerApi.save({
        id: editingId || undefined,
        name,
        type: form.type,
        protocol: form.protocol,
        base_url: baseUrl,
        api_key: form.api_key,
        clear: form.clear_key ? { api_key: true } : undefined,
      })
      if (!result.saved || !result.provider) {
        setFormError(result.message || t('providerSettings.saveFailed'))
        return
      }
      setFormError('')
      closeForm()
      await refresh()
      onChanged?.()
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : t('providerSettings.saveFailed'))
    } finally {
      setFormSaving(false)
    }
  }

  const toggleEnabled = async (provider: ProviderInfo) => {
    setTogglingId(provider.id)
    setError('')
    try {
      await providerApi.save({
        id: provider.id,
        name: provider.name,
        type: provider.type,
        protocol: provider.protocol,
        base_url: provider.base_url,
        enabled: !provider.enabled,
      })
      await refresh()
      onChanged?.()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('providerSettings.saveFailed'))
    } finally {
      setTogglingId(null)
    }
  }

  const testProvider = async (provider: ProviderInfo) => {
    setTestingId(provider.id)
    setTestResults((current) => {
      const next = { ...current }
      delete next[provider.id]
      return next
    })
    try {
      const result = await providerApi.test(provider.id)
      setTestResults((current) => ({
        ...current,
        [provider.id]: { success: result.success, message: result.message },
      }))
      await refresh()
    } catch (reason) {
      setTestResults((current) => ({
        ...current,
        [provider.id]: { success: false, message: reason instanceof Error ? reason.message : t('providerSettings.test') },
      }))
    } finally {
      setTestingId(null)
    }
  }

  const loadModels = async (provider: ProviderInfo) => {
    setModelsLoadingId(provider.id)
    setModelErrors((current) => {
      const next = { ...current }
      delete next[provider.id]
      return next
    })
    try {
      const result = await providerApi.models(provider.id, true)
      setModelLists((current) => ({ ...current, [provider.id]: result.models }))
      setModelCounts((current) => ({ ...current, [provider.id]: result.models.length }))
      setModelFetchedAt((current) => ({
        ...current,
        [provider.id]: result.fetched_at || null,
      }))
      if (result.error) {
        setModelErrors((current) => ({ ...current, [provider.id]: String(result.error) }))
      }
    } catch (reason) {
      setModelErrors((current) => ({
        ...current,
        [provider.id]: reason instanceof Error ? reason.message : t('providerSettings.modelsFailed'),
      }))
    } finally {
      setModelsLoadingId(null)
    }
  }

  const confirmDelete = async () => {
    if (!deleting) return
    setDeleteError('')
    try {
      await providerApi.remove(deleting.id)
      setDeleting(null)
      await refresh()
      onChanged?.()
    } catch (reason) {
      setDeleteError(reason instanceof Error ? reason.message : t('providerSettings.deleteFailed', { error: '' }))
      setDeleting(null)
    }
  }

  const loadImportSources = async () => {
    setImportLoading(true)
    setImportError('')
    try {
      const result = await providerApi.importSources()
      setImportSources(result.sources)
    } catch (reason) {
      setImportError(reason instanceof Error ? reason.message : t('providerSettings.importLoadFailed'))
    } finally {
      setImportLoading(false)
    }
  }

  const openImport = () => {
    setImportOpen(true)
    setImportSourceId('')
    setImportSourceType('all')
    setSelectedIds([])
    setImportResult(null)
    setImportError('')
    void loadImportSources()
  }

  const closeImport = () => {
    if (importSaving) return
    setImportOpen(false)
    setImportSourceId('')
    setImportSourceType('all')
    setSelectedIds([])
    setImportResult(null)
    setImportError('')
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
        await refresh()
        onChanged?.()
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
  const saveDisabled = !form.name.trim() || !form.base_url.trim() || formSaving

  return (
    <div style={{ maxWidth: 960, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 18 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 20, fontWeight: 650, marginBottom: 6 }}>{t('providerSettings.title')}</h1>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>{t('providerSettings.intro')}</p>
        </div>
        <Button variant="ghost" onClick={() => void refresh()} disabled={loading}>
          {t('settings.refresh')}
        </Button>
        <Button variant="ghost" onClick={openImport}>
          <Icon name="download" size={14} strokeWidth={2} />
          {t('providerSettings.import')}
        </Button>
        <Button variant="primary" onClick={openCreate}>
          <Icon name="plus" size={14} strokeWidth={2} />
          {t('providerSettings.add')}
        </Button>
      </div>

      {error && (
        <div role="alert" style={{
          padding: '10px 12px', marginBottom: 12, borderRadius: 8,
          background: 'color-mix(in oklab, var(--danger), transparent 90%)',
          color: 'var(--danger)', fontSize: 13,
        }}>
          {error}
        </div>
      )}

      {loading && providers.length === 0 ? (
        <div style={{
          padding: 32, textAlign: 'center', color: 'var(--meta)',
          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12,
        }}>
          {t('settings.readingEngines')}
        </div>
      ) : providers.length === 0 ? (
        <div style={{
          padding: 32, textAlign: 'center', color: 'var(--meta)',
          background: 'var(--bg)', border: '1px dashed var(--border)', borderRadius: 12,
        }}>
          {t('providerSettings.empty')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {providers.map((provider) => {
            const testResult = testResults[provider.id]
            const modelCount = modelCounts[provider.id]
            const modelList = modelLists[provider.id] || []
            return (
              <div
                key={provider.id}
                data-provider-id={provider.id}
                style={{
                  borderRadius: 12,
                  border: '1px solid var(--border)',
                  background: 'var(--bg)',
                  opacity: provider.enabled ? 1 : 0.72,
                }}
              >
                <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{
                    width: 34, height: 34, borderRadius: 9, flexShrink: 0,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    background: 'color-mix(in oklab, var(--accent), transparent 86%)',
                    border: '1px solid color-mix(in oklab, var(--accent), transparent 72%)',
                    color: 'var(--accent)', fontSize: 12, fontWeight: 700,
                  }}>
                    {provider.name.slice(0, 2).toUpperCase()}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{provider.name}</span>
                      <span style={{
                        padding: '1px 6px', borderRadius: 999,
                        background: 'var(--surface)', color: 'var(--muted)',
                        fontSize: 11, textTransform: 'uppercase',
                      }}>
                        {typeLabel(provider.type)}
                      </span>
                    </div>
                    <div style={{ color: 'var(--muted)', fontSize: 11, overflowWrap: 'anywhere' }}>
                      {provider.base_url}
                      <span style={{ marginLeft: 8 }}>
                        {provider.has_key ? t('providerSettings.hasKey') : t('providerSettings.noKey')}
                      </span>
                    </div>
                    {testResult && (
                      <div
                        role="status"
                        style={{
                          marginTop: 7, fontSize: 11,
                          color: testResult.success ? 'var(--success)' : 'var(--danger)',
                        }}
                      >
                        {testResult.success ? '✓' : '×'} {testResult.message}
                      </div>
                    )}
                    {modelErrors[provider.id] && (
                      <div role="status" style={{ marginTop: 4, fontSize: 11, color: 'var(--danger)' }}>
                        × {t('providerSettings.modelsFailed')}: {modelErrors[provider.id]}
                      </div>
                    )}
                    {modelFetchedAt[provider.id] ? (
                      <div role="status" style={{ marginTop: 4, fontSize: 11, color: 'var(--success)' }}>
                        ✓ {t('providerSettings.modelsFetched', { count: modelCounts[provider.id] ?? 0 })}
                        {' · '}
                        {t('providerSettings.modelsFetchedAt', { time: modelFetchedAt[provider.id] ?? '' })}
                      </div>
                    ) : (
                      <div role="status" style={{ marginTop: 4, fontSize: 11, color: 'var(--meta)' }}>
                        {t('providerSettings.modelsNotFetched')}
                      </div>
                    )}
                    {modelList.length > 0 && (
                      <div role="list" style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {modelList.map((model) => (
                          <span
                            key={model.id}
                            role="listitem"
                            title={model.description || model.label || model.id}
                            style={{
                              padding: '2px 8px',
                              borderRadius: 999,
                              fontSize: 11,
                              background: 'var(--surface)',
                              color: 'var(--text)',
                              border: '1px solid var(--border)',
                              overflowWrap: 'anywhere',
                            }}
                          >
                            {model.label || model.id}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    style={{ minWidth: 62, height: 30, justifyContent: 'center' }}
                    disabled={testingId !== null}
                    loading={testingId === provider.id}
                    onClick={() => void testProvider(provider)}
                  >
                    {t('providerSettings.test')}
                  </Button>
                  <Button
                    variant="ghost"
                    style={{ minWidth: 62, height: 30, justifyContent: 'center' }}
                    disabled={modelsLoadingId !== null}
                    loading={modelsLoadingId === provider.id}
                    onClick={() => void loadModels(provider)}
                  >
                    {t('providerSettings.models')}
                    {modelCount !== undefined && !modelsLoadingId && (
                      <span style={{ marginLeft: 4, color: 'var(--meta)' }}>{modelCount}</span>
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    style={{ minWidth: 54, height: 30, justifyContent: 'center' }}
                    disabled={togglingId !== null}
                    loading={togglingId === provider.id}
                    title={t('providerSettings.enabledHint')}
                    onClick={() => void toggleEnabled(provider)}
                  >
                    {provider.enabled ? t('providerSettings.disable') : t('providerSettings.enable')}
                  </Button>
                  <Button
                    variant="ghost"
                    style={{ minWidth: 54, height: 30, justifyContent: 'center' }}
                    onClick={() => openEdit(provider)}
                  >
                    {t('common.edit')}
                  </Button>
                  <Button
                    variant="ghost"
                    style={{ minWidth: 54, height: 30, justifyContent: 'center' }}
                    onClick={() => {
                      setDeleteError('')
                      setDeleting(provider)
                    }}
                  >
                    <Icon name="trash" size={15} strokeWidth={2} />
                  </Button>
                  <ProviderBadge verified={provider.verified} enabled={provider.enabled} />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {importOpen && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t('providerSettings.importTitle')}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeImport()
          }}
          style={{ padding: 24 }}
        >
          <div
            className="modal"
            onMouseDown={(event) => event.stopPropagation()}
            style={{ width: 560, maxWidth: 'calc(100vw - 48px)' }}
          >
            <div className="modal-header" style={{ padding: '16px 20px' }}>
              <span className="modal-title">{t('providerSettings.importTitle')}</span>
              <Button variant="icon" aria-label={t('settings.closeSettings')} onClick={closeImport}>✕</Button>
            </div>
            <div className="modal-body" style={{ padding: '18px 20px 20px' }}>
              <p style={{ color: 'var(--muted)', fontSize: 12, margin: '0 0 14px' }}>
                {t('providerSettings.importIntro')}
              </p>
              {!importSourceId ? (
                <>
                  {importLoading && importSources.length === 0 ? (
                    <div style={{
                      padding: 28, textAlign: 'center', color: 'var(--meta)',
                      background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12,
                    }}>
                      {t('settings.readingEngines')}
                    </div>
                  ) : importSources.length === 0 ? (
                    <div style={{
                      padding: 28, textAlign: 'center', color: 'var(--meta)',
                      background: 'var(--bg)', border: '1px dashed var(--border)', borderRadius: 12,
                    }}>
                      {t('providerSettings.importSourcesEmpty')}
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
                          style={{
                            display: 'flex', alignItems: 'center', gap: 12,
                            padding: '10px 14px', borderRadius: 12, cursor: 'pointer',
                            border: '1px solid var(--border)', background: 'var(--bg)',
                            textAlign: 'left', font: 'inherit', color: 'inherit',
                          }}
                        >
                          <span style={{
                            width: 34, height: 34, borderRadius: 9, flexShrink: 0,
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            background: 'color-mix(in oklab, var(--accent), transparent 86%)',
                            border: '1px solid color-mix(in oklab, var(--accent), transparent 72%)',
                            color: 'var(--accent)', fontSize: 12, fontWeight: 700,
                          }}>
                            {source.name.slice(0, 2).toUpperCase()}
                          </span>
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>
                              {source.name}
                            </span>
                            <span style={{ display: 'block', color: 'var(--muted)', fontSize: 11, marginTop: 2 }}>
                              {source.description}
                            </span>
                          </span>
                          <span style={{
                            padding: '2px 8px', borderRadius: 999, fontSize: 11,
                            background: 'var(--surface)', color: 'var(--meta)',
                          }}>
                            {source.provider_count}
                          </span>
                          <Icon name="chevron-right" size={16} strokeWidth={2} />
                        </button>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
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
                    <div style={{
                      padding: 28, textAlign: 'center', color: 'var(--meta)',
                      background: 'var(--bg)', border: '1px dashed var(--border)', borderRadius: 12,
                    }}>
                      {t('providerSettings.importProvidersEmpty')}
                    </div>
                  ) : (
                    <>
                      <div
                        role="tablist"
                        aria-label={t('providerSettings.importTypeTabs')}
                        style={{
                          display: 'flex', gap: 6, marginBottom: 12,
                          paddingBottom: 2, overflowX: 'auto',
                        }}
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
                              style={{
                                flexShrink: 0, height: 30, padding: '0 10px',
                                borderRadius: 8, cursor: 'pointer', font: 'inherit',
                                fontSize: 12, fontWeight: active ? 650 : 500,
                                color: active ? 'var(--accent)' : 'var(--muted)',
                                background: active
                                  ? 'color-mix(in oklab, var(--accent), transparent 88%)'
                                  : 'var(--surface)',
                                border: active
                                  ? '1px solid color-mix(in oklab, var(--accent), transparent 55%)'
                                  : '1px solid var(--border-soft)',
                              }}
                            >
                              {tab.label}
                              <span style={{ marginLeft: 5, opacity: 0.72 }}>{tab.count}</span>
                            </button>
                          )
                        })}
                      </div>
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={allSelectableImportsSelected}
                        disabled={selectableImportIds.length === 0}
                        onClick={() => setSelectedIds((current) => (
                          allSelectableImportsSelected
                            ? current.filter((id) => !selectableImportIds.includes(id))
                            : [...new Set([...current, ...selectableImportIds])]
                        ))}
                        style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        marginBottom: 8, color: 'var(--muted)', fontSize: 12,
                          width: 'auto', height: 'auto', padding: 0,
                          border: 0, background: 'transparent',
                          cursor: selectableImportIds.length === 0 ? 'not-allowed' : 'pointer',
                          font: 'inherit',
                        }}
                      >
                        <ImportCheckboxMark checked={allSelectableImportsSelected} />
                        {t('providerSettings.importSelectAll')}
                      </button>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
                        {visibleImportCandidates.map((candidate) => {
                          const checked = selectedIds.includes(candidate.id)
                          const disabled = Boolean(candidate.error) || candidate.already_exists
                          return (
                            <button
                              type="button"
                              role="checkbox"
                              aria-checked={checked}
                              disabled={disabled}
                              onClick={() => toggleCandidate(candidate.id)}
                              key={candidate.id}
                              style={{
                                display: 'flex', alignItems: 'center', gap: 10,
                                width: '100%', textAlign: 'left', font: 'inherit', color: 'inherit',
                                padding: '9px 12px', borderRadius: 10, cursor: disabled ? 'not-allowed' : 'pointer',
                                border: '1px solid var(--border-soft)', background: 'var(--bg)',
                                opacity: disabled ? 0.6 : 1,
                              }}
                            >
                            <ImportCheckboxMark checked={checked} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                                <span style={{ fontSize: 13, fontWeight: 600 }}>{candidate.name}</span>
                                <span style={{
                                  padding: '1px 6px', borderRadius: 999,
                                  background: 'var(--surface)', color: 'var(--muted)',
                                  fontSize: 11, textTransform: 'uppercase',
                                }}>
                                  {typeLabel(candidate.type)}
                                </span>
                                <span style={{
                                  padding: '1px 6px', borderRadius: 999,
                                  background: 'color-mix(in oklab, var(--accent), transparent 90%)',
                                  color: 'var(--accent)', fontSize: 11,
                                }}>
                                  {candidate.source_type}
                                </span>
                                {candidate.already_exists && (
                                  <span style={{
                                    padding: '1px 6px', borderRadius: 999,
                                    background: 'var(--surface)', color: 'var(--meta)',
                                    fontSize: 11,
                                  }}>
                                    {t('providerSettings.importAlready')}
                                  </span>
                                )}
                              </div>
                              <div style={{ color: 'var(--muted)', fontSize: 11, overflowWrap: 'anywhere' }}>
                                {candidate.base_url}
                                <span style={{ marginLeft: 8 }}>
                                  {candidate.has_key ? t('providerSettings.hasKey') : t('providerSettings.noKey')}
                                </span>
                              </div>
                              {candidate.error && (
                                <div style={{ marginTop: 4, fontSize: 11, color: 'var(--danger)' }}>
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
                  <div className="field-hint" style={{ minHeight: 18, marginTop: 10 }} aria-live="polite">
                    {importResult && (
                      <span style={{ fontSize: 12 }}>
                        {importResult.imported.length > 0 && (
                          <span style={{ color: 'var(--success)' }}>
                            {t('providerSettings.importImported', { count: importResult.imported.length })}
                          </span>
                        )}
                        {importResult.skipped.length > 0 && (
                          <span style={{ color: 'var(--warn)', marginLeft: 8 }}>
                            {t('providerSettings.importSkipped', { count: importResult.skipped.length })}
                          </span>
                        )}
                        {importResult.errors.length > 0 && (
                          <span style={{ color: 'var(--danger)', marginLeft: 8 }}>
                            {t('providerSettings.importErrors', { count: importResult.errors.length })}
                          </span>
                        )}
                      </span>
                    )}
                    {importError && (
                      <span style={{ color: 'var(--danger)', fontSize: 12 }}>{importError}</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', marginTop: 4 }}>
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
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Button
                        variant="ghost"
                        disabled={importLoading || importSaving}
                        loading={importLoading}
                        onClick={() => void loadImportSources()}
                      >
                        {t('providerSettings.importRefresh')}
                      </Button>
                      <Button
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
          </div>
        </div>
      )}

      {formOpen && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={editingId ? t('providerSettings.editTitle') : t('providerSettings.newTitle')}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeForm()
          }}
          style={{ padding: 24 }}
        >
          <div
            className="modal"
            onMouseDown={(event) => event.stopPropagation()}
            style={{ width: 560, maxWidth: 'calc(100vw - 48px)' }}
          >
            <div className="modal-header" style={{ padding: '16px 20px' }}>
              <span className="modal-title">
                {editingId ? t('providerSettings.editTitle') : t('providerSettings.newTitle')}
              </span>
              <Button variant="icon" aria-label={t('settings.closeSettings')} onClick={closeForm}>✕</Button>
            </div>
            <div className="modal-body" style={{ padding: '18px 20px 20px' }}>
              <Field label={t('providerSettings.name')} htmlFor="provider-name" required>
                <Input
                  id="provider-name"
                  value={form.name}
                  placeholder={t('providerSettings.namePlaceholder')}
                  autoFocus
                  onChange={(event) => {
                    setForm((current) => ({ ...current, name: event.target.value }))
                    setFormError('')
                  }}
                  style={{ width: '100%', height: 32 }}
                />
              </Field>
              <Field label={t('providerSettings.type')} htmlFor="provider-type" required>
                <Select
                  id="provider-type"
                  value={form.type}
                  onChange={(event) => changeType(event.target.value)}
                  style={{ width: '100%', height: 32 }}
                >
                  {types.map((type) => (
                    <option key={type.id} value={type.id}>{type.label}</option>
                  ))}
                </Select>
              </Field>
              <Field label={t('providerSettings.protocol')} htmlFor="provider-protocol" required>
                <Select
                  id="provider-protocol"
                  value={form.protocol}
                  onChange={(event) => setForm((current) => ({
                    ...current,
                    protocol: event.target.value,
                  }))}
                  style={{ width: '100%', height: 32 }}
                >
                  <option value="anthropic_messages">{t('providerSettings.protocolAnthropic')}</option>
                  <option value="openai_responses">{t('providerSettings.protocolResponses')}</option>
                  <option value="openai_chat_completions">{t('providerSettings.protocolChat')}</option>
                </Select>
              </Field>
              <Field label={t('providerSettings.baseUrl')} htmlFor="provider-base-url" required>
                <Input
                  id="provider-base-url"
                  value={form.base_url}
                  placeholder={t('providerSettings.baseUrlPlaceholder')}
                  onChange={(event) => {
                    setForm((current) => ({ ...current, base_url: event.target.value }))
                    setFormError('')
                  }}
                  style={{ width: '100%', height: 32 }}
                />
              </Field>
              <Field
                label={t('providerSettings.apiKey')}
                htmlFor="provider-api-key"
                help={editingId && !form.clear_key && providers.find((item) => item.id === editingId)?.has_key
                  ? t('providerSettings.apiKeyKept')
                  : undefined}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Input
                    id="provider-api-key"
                    type={keyRevealed ? 'text' : 'password'}
                    value={form.api_key}
                    placeholder={t('providerSettings.apiKeyPlaceholder')}
                    onChange={(event) => {
                      setForm((current) => ({ ...current, api_key: event.target.value }))
                      setFormError('')
                    }}
                    style={{ flex: 1, minWidth: 0, height: 32 }}
                  />
                  <Button
                    variant="ghost"
                    style={{ height: 30, flexShrink: 0 }}
                    onClick={() => void toggleReveal()}
                  >
                    {keyRevealed ? t('providerSettings.hide') : t('providerSettings.reveal')}
                  </Button>
                  {editingId && providers.find((item) => item.id === editingId)?.has_key && (
                    <label
                      title={t('providerSettings.clearKey')}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 5,
                        flexShrink: 0, cursor: 'pointer', fontSize: 11,
                        color: 'var(--muted)', whiteSpace: 'nowrap',
                      }}
                    >
                      <input
                        id="provider-clear-key"
                        type="checkbox"
                        checked={form.clear_key}
                        onChange={(event) => {
                          setForm((current) => ({ ...current, clear_key: event.target.checked }))
                          setFormError('')
                        }}
                        style={{
                          width: 14, height: 14, padding: 0, margin: 0,
                          flexShrink: 0, accentColor: 'var(--accent)',
                        }}
                      />
                      {t('providerSettings.clearKey')}
                    </label>
                  )}
                </div>
              </Field>
              <div className="field-hint" style={{ minHeight: 18, marginBottom: 12 }} aria-live="polite">
                {formError ? (
                  <span style={{ color: 'var(--danger)', fontSize: 12 }}>{formError}</span>
                ) : null}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <Button variant="ghost" disabled={formSaving} onClick={closeForm}>
                  {t('common.cancel')}
                </Button>
                <Button variant="primary" disabled={saveDisabled} loading={formSaving} onClick={() => void save()}>
                  {t('providerSettings.save')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        title={t('providerSettings.deleteTitle')}
        message={deleting ? t('providerSettings.deleteMessage', { name: deleting.name }) : ''}
        danger
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
      />
      {deleteError && (
        <div role="alert" style={{
          marginTop: 10, padding: '9px 12px', borderRadius: 8, fontSize: 12,
          background: 'color-mix(in oklab, var(--danger), transparent 90%)',
          color: 'var(--danger)',
        }}>
          {deleteError}
        </div>
      )}
    </div>
  )
}

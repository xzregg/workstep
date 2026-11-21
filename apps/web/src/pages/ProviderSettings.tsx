import SettingsHelpButton from '../components/SettingsHelpButton'
import { notifyProvidersChanged } from '../hooks/useProjectProviders'
import ProviderImportDialog from '../components/ProviderImportDialog'
import ProviderModelsDialog from '../components/ProviderModelsDialog'
import ProviderSavedModels from '../components/ProviderSavedModels'
import ProviderEditorDialog, { type ProviderEditorTarget } from '../components/ProviderEditorDialog'
import { useCallback, useEffect, useRef, useState } from 'react'
import Button from '../components/Button'
import ConfirmDialog from '../components/ConfirmDialog'
import Icon from '../components/Icon'
import Spinner from '../components/Spinner'
import {
  providerApi,
  type EngineModel,
  type ProviderInfo,
  type ProviderTestResult,
  type ProviderTypeMeta,
} from '../api/client'
import { useI18n, type TKey, localizeErrorDisplay } from '../i18n'
import './ProviderSettings.css'
import {
  summarizeProviderProtocolModels,
  type ProviderProtocolModels,
} from '../utils/providerModels'

interface Props {
  /** 供应商变更后回调（设置页据此刷新引擎列表，同步 Pydantic AI 的供应商下拉） */
  onChanged?: () => void
  autoCreate?: boolean
}

const ALL_PROTOCOLS: { value: string; labelKey: TKey }[] = [
  { value: 'anthropic_messages', labelKey: 'providerSettings.protocolAnthropic' },
  { value: 'openai_responses', labelKey: 'providerSettings.protocolResponses' },
  { value: 'openai_chat_completions', labelKey: 'providerSettings.protocolChat' },
]

function ProviderBadge({ verified, enabled, testSuccess }: {
  verified: boolean; enabled: boolean; testSuccess?: boolean
}) {
  const { t } = useI18n()
  const status = !enabled ? 'disabled' : testSuccess === false ? 'failed'
    : (testSuccess ?? verified) ? 'verified' : 'unverified'
  const label = {
    disabled: 'providerSettings.disabledBadge',
    failed: 'providerSettings.testFailed',
    verified: 'providerSettings.verified',
    unverified: 'providerSettings.notVerified',
  } as const
  return (
    <span className={`provider-settings-badge provider-settings-badge--${status}`}>
      {t(label[status])}
    </span>
  )
}

export default function ProviderSettings({ onChanged: onCatalogChanged, autoCreate = false }: Props) {
  const onChanged = () => { notifyProvidersChanged(); onCatalogChanged?.() }
  const { t } = useI18n()
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [types, setTypes] = useState<ProviderTypeMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editorTarget, setEditorTarget] = useState<ProviderEditorTarget | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message: string }>>({})
  const [modelsLoadingId, setModelsLoadingId] = useState<string | null>(null)
  const [modelCounts, setModelCounts] = useState<Record<string, number>>({})
  const [modelFetchedAt, setModelFetchedAt] = useState<Record<string, string | null>>({})
  const [modelErrors, setModelErrors] = useState<Record<string, string>>({})
  const [modelGroups, setModelGroups] = useState<Record<string, ProviderProtocolModels[]>>({})
  const [deleting, setDeleting] = useState<ProviderInfo | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const initialized = useRef(false)
  const autoCreateHandled = useRef(false)

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
      const groups: Record<string, ProviderProtocolModels[]> = {}
      const counts: Record<string, number> = {}
      const fetchedAt: Record<string, string | null> = {}
      await Promise.all(
        result.providers.map(async (item) => {
          const protocols = item.protocols?.length ? item.protocols : [item.protocol]
          const entries = await Promise.all(protocols.map(async (protocol) => {
            try {
              const response = await providerApi.models(item.id, false, protocol)
              return {
                protocol,
                models: response.models,
                fetchedAt: response.fetched_at || null,
              }
            } catch {
              return { protocol, models: [], fetchedAt: null }
            }
          }))
          const summary = summarizeProviderProtocolModels(entries)
          groups[item.id] = summary.groups
          counts[item.id] = summary.uniqueCount
          fetchedAt[item.id] = summary.latestFetchedAt
        }),
      )
      setModelGroups(groups)
      setModelCounts(counts)
      setModelFetchedAt(fetchedAt)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('providerSettings.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    void refresh()
  }, [refresh])

  const typeLabel = (id: string) => types.find((item) => item.id === id)?.label ?? id
  const openCreate = () => setEditorTarget({ mode: 'create' })

  useEffect(() => {
    if (!autoCreate || loading || autoCreateHandled.current || editorTarget) return
    autoCreateHandled.current = true
    openCreate()
  }, [autoCreate, loading, editorTarget]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleEnabled = async (provider: ProviderInfo) => {
    setTogglingId(provider.id)
    setError('')
    try {
      await providerApi.save({
        id: provider.id,
        name: provider.name,
        type: provider.type,
        protocols: provider.protocols?.length ? provider.protocols : [provider.protocol],
        protocol: provider.protocol,
        base_url: provider.base_url,
        protocol_base_urls: provider.protocol_base_urls,
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
      const protocols = provider.protocols?.length ? provider.protocols : [provider.protocol]
      const results: Array<ProviderTestResult & { label: string }> = []
      for (const protocol of protocols) {
        const result = await providerApi.test(provider.id, protocol)
        const option = ALL_PROTOCOLS.find((item) => item.value === protocol)
        results.push({
          ...result,
          label: option ? t(option.labelKey) : protocol,
        })
      }
      const success = results.every((result) => result.success)
      setTestResults((current) => ({
        ...current,
        [provider.id]: {
          success,
          message: results
            .map((result) => `${result.label}: ${result.message}`)
            .join('；'),
        },
      }))
      if (provider.managed) {
        const savedStatus = results.at(-1)?.test_success
        if (savedStatus !== undefined) {
          setProviders((current) => current.map((item) => item.id === provider.id
            ? { ...item, test_success: savedStatus, verified: savedStatus === true } : item))
        }
      } else {
        await refresh()
      }
    } catch (reason) {
      setTestResults((current) => ({
        ...current,
        [provider.id]: { success: false, message: reason instanceof Error ? reason.message : t('providerSettings.test') },
      }))
    } finally {
      setTestingId(null)
    }
  }

  const [modelsDialog, setModelsDialog] = useState<{
    provider: ProviderInfo
    groups: ProviderProtocolModels[]
    preview: EngineModel[]
    selected: string[]
    saving: boolean
    error: string
  } | null>(null)

  const protocolLabel = (protocol: string) => {
    const option = ALL_PROTOCOLS.find((item) => item.value === protocol)
    return option ? t(option.labelKey) : protocol
  }

  const loadModels = async (provider: ProviderInfo) => {
    if (modelsLoadingId !== null || modelsDialog) return
    setModelErrors((current) => {
      const next = { ...current }
      delete next[provider.id]
      return next
    })
    setModelsLoadingId(provider.id)
    try {
      const protocols = [...new Set(provider.protocols?.length ? provider.protocols : [provider.protocol])]
      const results = await Promise.all(protocols.map(async (protocol) => {
        try {
          const preview = await providerApi.previewModels(provider.id, protocol)
          if (preview.error) return { protocol, error: preview.error }
          const saved = await providerApi.models(provider.id, false, protocol).catch(() => null)
          const savedIds = new Set((saved?.models || []).map((item) => item.id))
          const initial = preview.models.filter((item) => savedIds.has(item.id)).map((item) => item.id)
          return { protocol, models: preview.models, fetchedAt: null,
            selected: initial.length ? initial : preview.models.map((item) => item.id) }
        } catch (reason) {
          return { protocol, error: reason instanceof Error ? reason.message : t('providerSettings.modelsFailed') }
        }
      }))
      const errors = results.filter((result) => 'error' in result)
      if (errors.length) {
        setModelErrors((current) => ({
          ...current,
          [provider.id]: errors.map((result) => `${protocolLabel(result.protocol)}: ${result.error}`).join('；'),
        }))
      }
      const successful = results.filter(
        (result): result is Extract<typeof result, { models: EngineModel[] }> => result.models !== undefined,
      )
      if (!successful.length) return
      const { groups } = summarizeProviderProtocolModels(successful)
      setModelsDialog({
        provider,
        groups,
        preview: [...new Map(groups.flatMap((group) => group.models).map((model) => [model.id, model])).values()],
        selected: [...new Set(successful.flatMap((result) => result.selected))],
        saving: false,
        error: '',
      })
    } catch (reason) {
      setModelErrors((current) => ({
        ...current,
        [provider.id]: reason instanceof Error ? reason.message : t('providerSettings.modelsFailed'),
      }))
    } finally {
      setModelsLoadingId(null)
    }
  }

  const confirmModelsSelection = async () => {
    if (!modelsDialog || modelsDialog.saving) return
    const { provider, groups, selected } = modelsDialog
    setModelsDialog((current) => (current ? { ...current, saving: true, error: '' } : current))
    try {
      for (const group of groups) {
        await providerApi.saveModelSelection(
          provider.id, group.protocol, group.models.filter((item) => selected.includes(item.id)),
        )
      }
      setModelsDialog(null)
      await refresh()
      onChanged?.()
    } catch (reason) {
      setModelsDialog((current) => (current
        ? { ...current, saving: false, error: reason instanceof Error ? reason.message : t('providerSettings.modelsFailed') }
        : current))
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

  return (
    <div className="provider-settings-page">
      <div className="provider-settings-header">
        <div className="provider-settings-heading">
          <div className="settings-heading-row"><h1 className="provider-settings-title">{t('providerSettings.title')}<SettingsHelpButton section="providers" /></h1><Button variant="ghost" onClick={() => void refresh()} disabled={loading}>{t('settings.refresh')}</Button></div>
          <p className="provider-settings-intro">{t('providerSettings.intro')}</p>
        </div>
        <div className="provider-settings-header-actions">
          <Button variant="ghost" onClick={() => setImportOpen(true)}>
            <Icon name="download" size={14} strokeWidth={2} />
            {t('providerSettings.import')}
          </Button>
          <Button variant="primary" onClick={openCreate}>
            <Icon name="plus" size={14} strokeWidth={2} />
            {t('providerSettings.add')}
          </Button>
        </div>
      </div>

      {error && (
        <div role="alert" className="provider-settings-alert">
          {localizeErrorDisplay(error)}
        </div>
      )}

      {loading && providers.length === 0 ? (
        <div className="provider-settings-empty provider-settings-empty--loading">
          {t('settings.readingEngines')}
        </div>
      ) : providers.length === 0 ? (
        <div className="provider-settings-empty">
          {t('providerSettings.empty')}
        </div>
      ) : (
        <div className="provider-settings-list">
          {providers.map((provider) => {
            const testResult = testResults[provider.id]
            const modelCount = modelCounts[provider.id]
            const providerModelGroups = modelGroups[provider.id] || []
            return (
              <div
                key={provider.id}
                data-provider-id={provider.id}
                className={`provider-settings-card${provider.enabled ? '' : ' provider-settings-card--disabled'}`}
              >
                <div className="provider-settings-card-row">
                  <span className="provider-settings-avatar">
                    {provider.name.slice(0, 2).toUpperCase()}
                  </span>
                  <div className="provider-settings-card-content">
                    <div className="provider-settings-card-heading">
                      <span className="provider-settings-card-name">{provider.name}</span>
                      <span className="provider-settings-type-badge">
                        {typeLabel(provider.type)}
                      </span>
                    </div>
                    <div className="provider-settings-card-detail">
                      {(provider.protocols?.length ? provider.protocols : [provider.protocol]).map((protocol) => {
                        const option = ALL_PROTOCOLS.find((item) => item.value === protocol)
                        return (
                          <div key={protocol}>
                            {option ? t(option.labelKey) : protocol}: {' '}
                            {provider.protocol_base_urls?.[protocol] || provider.base_url}
                          </div>
                        )
                      })}
                      <div>{provider.has_key ? t('providerSettings.hasKey') : t('providerSettings.noKey')}</div>
                    </div>
                    {testResult && (
                      <div role="status" className={`provider-settings-test-status provider-settings-test-status--${testResult.success ? 'success' : 'failure'}`}>
                        {testResult.success ? '✓' : '×'} {testResult.message}
                      </div>
                    )}
                    {modelErrors[provider.id] && (
                      <div role="status" className="provider-settings-model-status provider-settings-model-status--error">
                        × {t('providerSettings.modelsFailed')}: {modelErrors[provider.id]}
                      </div>
                    )}
                    {modelFetchedAt[provider.id] ? (
                      <div role="status" className="provider-settings-model-status provider-settings-model-status--success">
                        ✓ {t('providerSettings.modelsFetched', { count: modelCounts[provider.id] ?? 0 })}
                        {' · '}
                        {t('providerSettings.modelsFetchedAt', { time: modelFetchedAt[provider.id] ?? '' })}
                      </div>
                    ) : (
                      <div role="status" className="provider-settings-model-status provider-settings-model-status--empty">
                        {t('providerSettings.modelsNotFetched')}
                      </div>
                    )}
                    <ProviderSavedModels
                      providerName={provider.name}
                      groups={providerModelGroups}
                      protocolLabel={protocolLabel}
                    />
                    {provider.managed && <p className="provider-settings-card-detail">{t('providerSettings.managedHint')}</p>}
                  </div>
                  <div className="provider-settings-card-actions">
                    <Button
                      variant="ghost"
                      className="provider-settings-action provider-settings-action--wide"
                      disabled={testingId !== null}
                      loading={testingId === provider.id}
                      onClick={() => void testProvider(provider)}
                    >
                      {t('providerSettings.test')}
                    </Button>
                    {!provider.managed && <>
                    <Button
                      variant="ghost"
                      className="provider-settings-action provider-settings-action--wide"
                      disabled={modelsLoadingId !== null}
                      loading={modelsLoadingId === provider.id}
                      onClick={() => void loadModels(provider)}
                    >
                      {t('providerSettings.models')}
                      {modelCount !== undefined && !modelsLoadingId && (
                        <span className="provider-settings-model-count">{modelCount}</span>
                      )}
                    </Button>
                    <span className="provider-settings-toggle" title={t('providerSettings.enabledHint')}>
                      <button
                        type="button"
                        className="settings-switch"
                        role="switch"
                        aria-label={`${provider.name} · ${t('providerSettings.enable')}`}
                        aria-checked={provider.enabled}
                        aria-busy={togglingId === provider.id}
                        disabled={togglingId !== null}
                        onClick={() => void toggleEnabled(provider)}
                      >
                        <span className="settings-switch-thumb" />
                      </button>
                      {togglingId === provider.id && <Spinner />}
                    </span>
                    <Button
                      variant="ghost"
                      className="provider-settings-action"
                      onClick={() => setEditorTarget({ mode: 'edit', provider })}
                    >
                      {t('common.edit')}
                    </Button>
                    <Button
                      variant="ghost"
                      className="provider-settings-action provider-settings-action--copy"
                      onClick={() => setEditorTarget({ mode: 'copy', provider })}
                    >
                      {t('providerSettings.copy')}
                    </Button>
                    <Button
                      variant="ghost"
                      className="provider-settings-action provider-settings-action--delete"
                      aria-label={t('providerSettings.deleteTitle')}
                      onClick={() => {
                        setDeleteError('')
                        setDeleting(provider)
                      }}
                    >
                      <Icon name="trash" size={15} strokeWidth={2} />
                    </Button>
                    </>}
                    <ProviderBadge verified={provider.verified} enabled={provider.enabled}
                      testSuccess={provider.managed
                        ? (provider.test_success === undefined ? testResult?.success : provider.test_success ?? undefined)
                        : undefined} />
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {importOpen && <ProviderImportDialog
        types={types}
        onClose={() => setImportOpen(false)}
        onImported={async () => { await refresh(); onChanged?.() }}
      />}

      {editorTarget && <ProviderEditorDialog
        target={editorTarget}
        types={types}
        onClose={() => setEditorTarget(null)}
        onSaved={async () => { await refresh(); onChanged?.() }}
      />}

      {modelsDialog && <ProviderModelsDialog
        providerName={modelsDialog.provider.name}
        protocolLabel={t('providerSettings.models')}
        models={modelsDialog.preview}
        initialSelected={modelsDialog.selected}
        saving={modelsDialog.saving}
        saveError={modelsDialog.error}
        onToggle={(id) => setModelsDialog((current) => {
          if (!current) return current
          const has = current.selected.includes(id)
          return {
            ...current,
            selected: has
              ? current.selected.filter((item) => item !== id)
              : [...current.selected, id],
          }
        })}
        onSelectAll={(ids) => setModelsDialog((current) => {
          if (!current) return current
          const next = new Set(current.selected)
          ids.forEach((id) => next.add(id))
          return { ...current, selected: [...next] }
        })}
        onClear={(ids) => setModelsDialog((current) => {
          if (!current) return current
          const remove = new Set(ids)
          return { ...current, selected: current.selected.filter((id) => !remove.has(id)) }
        })}
        onConfirm={() => void confirmModelsSelection()}
        onClose={() => setModelsDialog(null)}
      />}

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
        <div role="alert" className="provider-settings-alert provider-settings-alert--delete">
          {localizeErrorDisplay(deleteError)}
        </div>
      )}
    </div>
  )
}

import ResizablePanel from '../components/ResizablePanel'
import ProviderImportDialog from '../components/ProviderImportDialog'
import { useCallback, useEffect, useRef, useState } from 'react'
import Button from '../components/Button'
import ConfirmDialog from '../components/ConfirmDialog'
import Field from '../components/Field'
import Icon from '../components/Icon'
import Input from '../components/Input'
import Select from '../components/Select'
import {
  providerApi,
  type ProviderInfo,
  type ProviderTestResult,
  type ProviderTypeMeta,
} from '../api/client'
import { useI18n, type TKey } from '../i18n'
import {
  summarizeProviderProtocolModels,
  type ProviderProtocolModels,
} from '../utils/providerModels'

interface Props {
  /** 供应商变更后回调（设置页据此刷新引擎列表，同步 Pydantic AI 的供应商下拉） */
  onChanged?: () => void
  autoCreate?: boolean
}

interface ProviderForm {
  name: string
  type: string
  protocols: string[]
  protocol_base_urls: Record<string, string>
  api_key: string
  clear_key: boolean
}

const EMPTY_FORM: ProviderForm = {
  name: '',
  type: 'custom',
  protocols: ['openai_chat_completions'],
  protocol_base_urls: { openai_chat_completions: '' },
  api_key: '',
  clear_key: false,
}

const ALL_PROTOCOLS: { value: string; labelKey: TKey }[] = [
  { value: 'anthropic_messages', labelKey: 'providerSettings.protocolAnthropic' },
  { value: 'openai_responses', labelKey: 'providerSettings.protocolResponses' },
  { value: 'openai_chat_completions', labelKey: 'providerSettings.protocolChat' },
]

function ProviderBadge({ verified, enabled }: { verified: boolean; enabled: boolean }) {
  const { t } = useI18n()
  if (!enabled) {
    return (
      <span style={{
        padding: '2px 8px', borderRadius: 999, fontSize: 'calc(11px * var(--font-scale))', fontWeight: 600,
        background: 'var(--surface)', color: 'var(--meta)',
      }}>
        {t('providerSettings.disabledBadge')}
      </span>
    )
  }
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 999, fontSize: 'calc(11px * var(--font-scale))', fontWeight: 600,
      color: verified ? 'var(--success)' : 'var(--warn)',
      background: verified
        ? 'color-mix(in oklab, var(--success), transparent 88%)'
        : 'color-mix(in oklab, var(--warn), transparent 88%)',
    }}>
      {verified ? t('providerSettings.verified') : t('providerSettings.notVerified')}
    </span>
  )
}

export default function ProviderSettings({ onChanged, autoCreate = false }: Props) {
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
  const [copySourceName, setCopySourceName] = useState('')
  const [copyingId, setCopyingId] = useState<string | null>(null)
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
  }, [])

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    void refresh()
  }, [refresh])

  const typeLabel = (id: string) => types.find((item) => item.id === id)?.label ?? id
  const typeDefaultBaseUrl = (id: string) => types.find((item) => item.id === id)?.default_base_url ?? ''
  const typeDefaultProtocols = (id: string) =>
    types.find((item) => item.id === id)?.default_protocols?.length
      ? types.find((item) => item.id === id)!.default_protocols
      : [types.find((item) => item.id === id)?.default_protocol ?? 'openai_chat_completions']

  const toggleProtocol = (value: string) => {
    setForm((current) => {
      const present = current.protocols.includes(value)
      return {
        ...current,
        protocols: present
          ? current.protocols.filter((item) => item !== value)
          : [...current.protocols, value],
        protocol_base_urls: present
          ? current.protocol_base_urls
          : {
              ...current.protocol_base_urls,
              [value]: current.protocol_base_urls[value] || typeDefaultBaseUrl(current.type),
            },
      }
    })
  }

  const openCreate = () => {
    setEditingId(null)
    setCopySourceName('')
    const typeId = types[0]?.id ?? 'custom'
    setForm({
      ...EMPTY_FORM,
      type: typeId,
      protocols: typeDefaultProtocols(typeId),
      protocol_base_urls: Object.fromEntries(
        typeDefaultProtocols(typeId).map((protocol) => [protocol, typeDefaultBaseUrl(typeId)]),
      ),
    })
    setFormError('')
    setKeyRevealed(false)
    setFormOpen(true)
  }

  useEffect(() => {
    if (!autoCreate || loading || autoCreateHandled.current || formOpen) return
    autoCreateHandled.current = true
    openCreate()
  }, [autoCreate, loading, formOpen, types]) // eslint-disable-line react-hooks/exhaustive-deps

  const openEdit = (provider: ProviderInfo) => {
    const protocols = provider.protocols?.length ? provider.protocols : [provider.protocol]
    setEditingId(provider.id)
    setCopySourceName('')
    setForm({
      name: provider.name,
      type: provider.type,
      protocols,
      protocol_base_urls: Object.fromEntries(
        protocols.map((protocol) => [
          protocol,
          provider.protocol_base_urls?.[protocol] || provider.base_url,
        ]),
      ),
      api_key: '',
      clear_key: false,
    })
    setFormError('')
    setKeyRevealed(false)
    setFormOpen(true)
  }

  const openCopy = async (provider: ProviderInfo) => {
    setCopyingId(provider.id)
    setError('')
    try {
      const apiKey = provider.has_key
        ? (await providerApi.reveal(provider.id)).value || ''
        : ''
      const protocols = provider.protocols?.length ? provider.protocols : [provider.protocol]
      setEditingId(null)
      setCopySourceName(provider.name)
      setForm({
        name: t('providerSettings.copyName', { name: provider.name }),
        type: provider.type,
        protocols,
        protocol_base_urls: Object.fromEntries(
          protocols.map((protocol) => [
            protocol,
            provider.protocol_base_urls?.[protocol] || provider.base_url,
          ]),
        ),
        api_key: apiKey,
        clear_key: false,
      })
      setFormError('')
      setKeyRevealed(false)
      setFormOpen(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('providerSettings.copyFailed'))
    } finally {
      setCopyingId(null)
    }
  }

  const closeForm = () => {
    setFormOpen(false)
    setEditingId(null)
    setCopySourceName('')
    setForm(EMPTY_FORM)
    setFormError('')
    setKeyRevealed(false)
  }

  const changeType = (typeId: string) => {
    setForm((current) => {
      const defaultUrl = typeDefaultBaseUrl(typeId)
      const protocols = typeDefaultProtocols(typeId)
      return {
        ...current,
        type: typeId,
        protocols,
        protocol_base_urls: Object.fromEntries(
          protocols.map((protocol) => [protocol, defaultUrl]),
        ),
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
    if (!name) {
      setFormError(t('providerSettings.needsName'))
      return
    }
    if (!form.protocols.length) {
      setFormError(t('providerSettings.protocolsRequired'))
      return
    }
    const protocolBaseUrls = Object.fromEntries(
      form.protocols.map((protocol) => [
        protocol,
        (form.protocol_base_urls[protocol] || '').trim(),
      ]),
    )
    if (Object.values(protocolBaseUrls).some((value) => !value)) {
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
        protocols: form.protocols,
        protocol: form.protocols[0],
        base_url: protocolBaseUrls[form.protocols[0]],
        protocol_base_urls: protocolBaseUrls,
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
      const protocols = provider.protocols?.length ? provider.protocols : [provider.protocol]
      const entries: ProviderProtocolModels[] = []
      const errors: string[] = []
      for (const protocol of protocols) {
        const result = await providerApi.models(provider.id, true, protocol)
        entries.push({
          protocol,
          models: result.models,
          fetchedAt: result.fetched_at || null,
        })
        if (result.error) {
          const option = ALL_PROTOCOLS.find((item) => item.value === protocol)
          errors.push(`${option ? t(option.labelKey) : protocol}: ${result.error}`)
        }
      }
      const summary = summarizeProviderProtocolModels(entries)
      setModelGroups((current) => ({ ...current, [provider.id]: summary.groups }))
      setModelCounts((current) => ({ ...current, [provider.id]: summary.uniqueCount }))
      setModelFetchedAt((current) => ({
        ...current,
        [provider.id]: summary.latestFetchedAt,
      }))
      if (errors.length) {
        setModelErrors((current) => ({ ...current, [provider.id]: errors.join('；') }))
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

  const saveDisabled = !form.name.trim()
    || !form.protocols.length
    || form.protocols.some((protocol) => !form.protocol_base_urls[protocol]?.trim())
    || formSaving

  return (
    <div className="provider-settings-page" style={{ maxWidth: 960, margin: '0 auto' }}>
      <div className="provider-settings-header" style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 18 }}>
        <div className="provider-settings-heading" style={{ flex: 1 }}>
          <h1 style={{ fontSize: 'calc(20px * var(--font-scale))', fontWeight: 650, marginBottom: 6 }}>{t('providerSettings.title')}</h1>
          <p style={{ color: 'var(--muted)', fontSize: 'calc(13px * var(--font-scale))' }}>{t('providerSettings.intro')}</p>
        </div>
        <div className="provider-settings-header-actions">
          <Button variant="ghost" onClick={() => void refresh()} disabled={loading}>
            {t('settings.refresh')}
          </Button>
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
        <div role="alert" style={{
          padding: '10px 12px', marginBottom: 12, borderRadius: 8,
          background: 'color-mix(in oklab, var(--danger), transparent 90%)',
          color: 'var(--danger)', fontSize: 'calc(13px * var(--font-scale))',
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
            const providerModelGroups = modelGroups[provider.id] || []
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
                <div className="provider-settings-card-row" style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                  <span style={{
                    width: 34, height: 34, borderRadius: 9, flexShrink: 0,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    background: 'color-mix(in oklab, var(--accent), transparent 86%)',
                    border: '1px solid color-mix(in oklab, var(--accent), transparent 72%)',
                    color: 'var(--accent)', fontSize: 'calc(12px * var(--font-scale))', fontWeight: 700,
                  }}>
                    {provider.name.slice(0, 2).toUpperCase()}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                      <span style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600 }}>{provider.name}</span>
                      <span style={{
                        padding: '1px 6px', borderRadius: 999,
                        background: 'var(--surface)', color: 'var(--muted)',
                        fontSize: 'calc(11px * var(--font-scale))', textTransform: 'uppercase',
                      }}>
                        {typeLabel(provider.type)}
                      </span>
                    </div>
                    <div style={{ color: 'var(--muted)', fontSize: 'calc(11px * var(--font-scale))', overflowWrap: 'anywhere' }}>
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
                      <div
                        role="status"
                        style={{
                          marginTop: 7, fontSize: 'calc(11px * var(--font-scale))',
                          color: testResult.success ? 'var(--success)' : 'var(--danger)',
                        }}
                      >
                        {testResult.success ? '✓' : '×'} {testResult.message}
                      </div>
                    )}
                    {modelErrors[provider.id] && (
                      <div role="status" style={{ marginTop: 4, fontSize: 'calc(11px * var(--font-scale))', color: 'var(--danger)' }}>
                        × {t('providerSettings.modelsFailed')}: {modelErrors[provider.id]}
                      </div>
                    )}
                    {modelFetchedAt[provider.id] ? (
                      <div role="status" style={{ marginTop: 4, fontSize: 'calc(11px * var(--font-scale))', color: 'var(--success)' }}>
                        ✓ {t('providerSettings.modelsFetched', { count: modelCounts[provider.id] ?? 0 })}
                        {' · '}
                        {t('providerSettings.modelsFetchedAt', { time: modelFetchedAt[provider.id] ?? '' })}
                      </div>
                    ) : (
                      <div role="status" style={{ marginTop: 4, fontSize: 'calc(11px * var(--font-scale))', color: 'var(--meta)' }}>
                        {t('providerSettings.modelsNotFetched')}
                      </div>
                    )}
                    {providerModelGroups.some((group) => group.models.length > 0) && (
                      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 7 }}>
                        {providerModelGroups.filter((group) => group.models.length > 0).map((group) => {
                          const option = ALL_PROTOCOLS.find((item) => item.value === group.protocol)
                          return (
                            <div key={group.protocol} data-model-protocol={group.protocol}>
                              <div style={{
                                marginBottom: 4,
                                color: 'var(--muted)',
                                fontSize: 'calc(10px * var(--font-scale))',
                                fontWeight: 650,
                              }}>
                                {option ? t(option.labelKey) : group.protocol}
                                {' · '}
                                {t('providerSettings.modelsCount', { count: group.models.length })}
                              </div>
                              <div role="list" style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                {group.models.map((model) => (
                                  <span
                                    key={model.id}
                                    role="listitem"
                                    title={model.description || model.label || model.id}
                                    style={{
                                      padding: '2px 8px',
                                      borderRadius: 999,
                                      fontSize: 'calc(11px * var(--font-scale))',
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
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                  <div className="provider-settings-card-actions" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 6 }}>
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
                      style={{ minWidth: 76, height: 30, justifyContent: 'center' }}
                      disabled={copyingId !== null}
                      loading={copyingId === provider.id}
                      onClick={() => void openCopy(provider)}
                    >
                      {t('providerSettings.copy')}
                    </Button>
                    <Button
                      variant="ghost"
                      style={{ minWidth: 30, width: 30, height: 30, padding: 0, justifyContent: 'center' }}
                      aria-label={t('providerSettings.deleteTitle')}
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

      {formOpen && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={editingId
            ? t('providerSettings.editTitle')
            : copySourceName
              ? t('providerSettings.copyTitle')
              : t('providerSettings.newTitle')}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeForm()
          }}
          style={{ padding: 24 }}
        >
          <ResizablePanel
            className="modal"
            onMouseDown={(event) => event.stopPropagation()}
            style={{ width: 560, maxWidth: 'calc(100vw - 48px)' }}
          >
            <div className="modal-header" style={{ padding: '16px 20px' }}>
              <span className="modal-title">
                {editingId
                  ? t('providerSettings.editTitle')
                  : copySourceName
                    ? t('providerSettings.copyTitle')
                    : t('providerSettings.newTitle')}
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
              <Field label={t('providerSettings.protocols')} required>
                <div className="provider-protocol-options">
                  {ALL_PROTOCOLS.map((option) => {
                    const enabled = form.protocols.includes(option.value)
                    return (
                      <div className="provider-protocol-setting" key={option.value}>
                        <label className="provider-protocol-toggle">
                          <span>{t(option.labelKey)}</span>
                          <input
                            type="checkbox"
                            role="switch"
                            checked={enabled}
                            onChange={() => toggleProtocol(option.value)}
                          />
                          <span className="provider-protocol-switch" aria-hidden="true" />
                        </label>
                        {form.protocols.includes(option.value) && (
                          <Field
                            className="provider-protocol-address"
                            label={t('providerSettings.baseUrl')}
                            htmlFor={`provider-base-url-${option.value}`}
                            required
                          >
                            <Input
                              id={`provider-base-url-${option.value}`}
                              value={form.protocol_base_urls[option.value] || ''}
                              placeholder={t('providerSettings.baseUrlPlaceholder')}
                              onChange={(event) => {
                                const value = event.target.value
                                setForm((current) => ({
                                  ...current,
                                  protocol_base_urls: {
                                    ...current.protocol_base_urls,
                                    [option.value]: value,
                                  },
                                }))
                                setFormError('')
                              }}
                              style={{ width: '100%', height: 32 }}
                            />
                          </Field>
                        )}
                      </div>
                    )
                  })}
                </div>
                <div style={{ fontSize: 12, opacity: 0.65, marginTop: 6 }}>
                  {t('providerSettings.protocolsHint')}
                </div>
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
                        flexShrink: 0, cursor: 'pointer', fontSize: 'calc(11px * var(--font-scale))',
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
                  <span style={{ color: 'var(--danger)', fontSize: 'calc(12px * var(--font-scale))' }}>{formError}</span>
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
          </ResizablePanel>
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
          marginTop: 10, padding: '9px 12px', borderRadius: 8, fontSize: 'calc(12px * var(--font-scale))',
          background: 'color-mix(in oklab, var(--danger), transparent 90%)',
          color: 'var(--danger)',
        }}>
          {deleteError}
        </div>
      )}
    </div>
  )
}

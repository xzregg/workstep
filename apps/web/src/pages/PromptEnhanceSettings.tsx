import { useEffect, useRef, useState } from 'react'
import { assistantApi, providerApi, type EngineModel } from '../api/client'
import Button from '../components/Button'
import Select from '../components/Select'
import { useI18n } from '../i18n'

export default function PromptEnhanceSettings() {
  const { t } = useI18n()
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [protocol, setProtocol] = useState('')
  const [providers, setProviders] = useState<EnhanceProviderInfo[]>([])
  const [models, setModels] = useState<EngineModel[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [modelError, setModelError] = useState('')
  const loaded = useRef(false)

  const loadConfig = async () => {
    setLoading(true)
    setError('')
    setNotice('')
    try {
      const result = await assistantApi.enhanceConfig()
      setProviderId(result.provider_id || '')
      setModel(result.model || '')
      setProviders(result.providers || [])
      const configuredProvider = result.providers?.find((item) => item.id === result.provider_id)
      setProtocol(result.protocol || configuredProvider?.protocols?.[0] || '')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('settings.enhanceLoadFailed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (loaded.current) return
    loaded.current = true
    void loadConfig()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!providerId) {
      setModels([])
      setModelError('')
      return
    }
    if (!protocol) {
      setModels([])
      return
    }
    let active = true
    setModelsLoading(true)
    setModelError('')
    providerApi.models(providerId, false, protocol)
      .then((result) => {
        if (!active) return
        setModels(result.models || [])
        setModelError(result.error || '')
      })
      .catch((reason) => {
        if (!active) return
        setModels([])
        setModelError(reason instanceof Error ? reason.message : t('settings.enhanceLoadFailed'))
      })
      .finally(() => {
        if (active) setModelsLoading(false)
      })
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, protocol])

  const changeProvider = (value: string) => {
    setProviderId(value)
    setProtocol(providers.find((item) => item.id === value)?.protocols?.[0] || '')
    setModel('')
    setNotice('')
  }

  const changeProtocol = (value: string) => {
    setProtocol(value)
    setModel('')
    setNotice('')
  }

  const protocolLabel = (value: string) => {
    if (value === 'anthropic_messages') return t('providerSettings.protocolAnthropic')
    if (value === 'openai_responses') return t('providerSettings.protocolResponses')
    if (value === 'openai_chat_completions') return t('providerSettings.protocolChat')
    return value
  }

  const selectedProvider = providers.find((item) => item.id === providerId)

  const save = async () => {
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const result = await assistantApi.setEnhanceConfig({ providerId, model, protocol })
      setProviderId(result.provider_id)
      setModel(result.model)
      setProtocol(result.protocol)
      setNotice(t('settings.enhanceSaved'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('settings.enhanceSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ padding: 20, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg)', marginTop: 14 }}>
      <div style={{ fontSize: 'calc(14px * var(--font-scale))', fontWeight: 650, marginBottom: 4 }}>{t('settings.enhanceTitle')}</div>
      <div style={{ color: 'var(--muted)', fontSize: 'calc(12px * var(--font-scale))', marginBottom: 14 }}>
        {t('settings.enhanceIntro')}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <label style={{ flexShrink: 0, fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600, width: 84 }}>
          {t('settings.enhanceProvider')}
        </label>
        <Select
          value={providerId}
          disabled={loading || saving}
          onChange={(event) => changeProvider(event.target.value)}
          aria-label={t('settings.enhanceProvider')}
          style={{ flex: 1, minWidth: 0, height: 30 }}
        >
          <option value="">{t('settings.enhanceSelectProvider')}</option>
          {providers.filter((item) => item.enabled).map((item) => (
            <option key={item.id} value={item.id}>{item.name}</option>
          ))}
          {providers.filter((item) => !item.enabled).map((item) => (
            <option key={item.id} value={item.id}>{item.name}{t('flow.currentConfigSuffix')}</option>
          ))}
        </Select>
      </div>
      {providerId && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <label style={{ flexShrink: 0, fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600, width: 84 }}>
            {t('settings.enhanceProtocol')}
          </label>
          <Select
            value={protocol}
            disabled={loading || saving}
            onChange={(event) => changeProtocol(event.target.value)}
            aria-label={t('settings.enhanceProtocol')}
            style={{ flex: 1, minWidth: 0, height: 30 }}
          >
            <option value="">{t('settings.enhanceSelectProtocol')}</option>
            {(selectedProvider?.protocols || []).map((item) => (
              <option key={item} value={item}>{protocolLabel(item)}</option>
            ))}
          </Select>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <label style={{ flexShrink: 0, fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600, width: 84 }}>
          {t('settings.enhanceModel')}
        </label>
        <Select
          value={model}
          disabled={!providerId || !protocol || modelsLoading || saving}
          onChange={(event) => setModel(event.target.value)}
          aria-label={t('settings.enhanceModel')}
          style={{ flex: 1, minWidth: 0, height: 30 }}
        >
          <option value="">
            {!providerId ? t('settings.enhanceSelectProvider') : modelsLoading ? t('flow.modelsLoading') : t('settings.enhanceSelectModel')}
          </option>
          {model && !models.some((item) => item.id === model) && (
            <option value={model}>{model}{t('flow.currentConfigSuffix')}</option>
          )}
          {models.map((item) => (
            <option key={item.id} value={item.id}>{item.label || item.id}</option>
          ))}
        </Select>
        {providerId && (
          <Button
            variant="ghost"
            style={{ flexShrink: 0, height: 28, padding: '0 8px', fontSize: 'calc(11px * var(--font-scale))' }}
            disabled={!protocol || modelsLoading || saving}
            onClick={() => {
              setModelsLoading(true)
              setModelError('')
              providerApi.models(providerId, true, protocol)
                .then((result) => {
                  setModels(result.models || [])
                  setModelError(result.error || '')
                })
                .catch((reason) => setModelError(reason instanceof Error ? reason.message : t('settings.enhanceLoadFailed')))
                .finally(() => setModelsLoading(false))
            }}
          >
            {t('settings.enhanceRefresh')}
          </Button>
        )}
      </div>
      {modelError && (
        <div style={{ marginBottom: 8, fontSize: 'calc(11px * var(--font-scale))', color: 'var(--warn)' }}>
          {t('settings.enhanceModelErrorHint', { error: modelError })}
        </div>
      )}
      <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div style={{ fontSize: 'calc(11px * var(--font-scale))', color: error ? 'var(--danger)' : notice ? 'var(--success)' : 'var(--meta)' }}>
          {error || notice}
        </div>
        <Button
          variant="primary"
          disabled={loading || saving || Boolean(providerId && (!protocol || !model))}
          loading={saving}
          onClick={() => void save()}
        >
          {t('settings.enhanceSave')}
        </Button>
      </div>
    </div>
  )
}

interface EnhanceProviderInfo {
  id: string
  name: string
  type: string
  base_url: string
  protocols: string[]
  enabled: boolean
}

import { useEffect, useRef, useState } from 'react'
import { assistantApi, providerApi, fetchEngineModels, getCachedEngineModels, type AssistantConfigInfo, type AssistantConfiguredDefaults, type EngineInfo, type EngineModel, type ProviderInfo } from '../api/client'
import EngineSelect from '../components/EngineSelect'
import { THINKING_EFFORT_LEVELS } from '../components/CoordinatorConfigBar'
import Button from '../components/Button'
import Select from '../components/Select'
import { useI18n, type TFunction, type TKey } from '../i18n'
import PromptEnhanceSettings from './PromptEnhanceSettings'

const ASSISTANT_NAME_KEYS: Record<string, TKey> = {
  task_coordinator: 'settings.assistantNames.taskCoordinator',
  task_create: 'settings.assistantNames.taskCreate',
  workflow_gen: 'settings.assistantNames.workflowGen',
  chat_session: 'settings.assistantNames.chatSession',
  channel_chat: 'settings.assistantNames.channelChat',
}

export function getAssistantLabel(name: string, t: TFunction): string {
  const key = ASSISTANT_NAME_KEYS[name]
  return key ? t(key) : name
}

export default function AgentAssistantSettings() {
  const { t } = useI18n()
  const [assistants, setAssistants] = useState<AssistantConfigInfo[]>([])
  const [selectedName, setSelectedName] = useState('')
  const [fields, setFields] = useState<string[]>(['engine'])
  const [resolvedDefaults, setResolvedDefaults] = useState<AssistantConfiguredDefaults | null>(null)
  const [engines, setEngines] = useState<EngineInfo[]>([])
  const [engine, setEngine] = useState('')
  const [model, setModel] = useState('')
  const [fastModel, setFastModel] = useState('')
  const [visionModel, setVisionModel] = useState('')
  const [thinkingEffort, setThinkingEffort] = useState('')
  const [providerId, setProviderId] = useState('')
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [providersLoading, setProvidersLoading] = useState(false)
  const [models, setModels] = useState<EngineModel[]>([])
  const [loading, setLoading] = useState(true)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const initialized = useRef(false)
  const engineRef = useRef('')
  const [error, setError] = useState('')
  const [modelError, setModelError] = useState('')
  const [notice, setNotice] = useState('')

  const applyAssistant = (info: AssistantConfigInfo) => {
    setSelectedName(info.name)
    setFields(info.fields)
    setResolvedDefaults(info.resolved || null)
    setEngines(info.available_engines as EngineInfo[])
    setEngine(info.configured.engine || '')
    setModel(info.configured.model || '')
    setFastModel(info.configured.fast_model || '')
    setVisionModel(info.configured.vision_model || '')
    setThinkingEffort(info.configured.thinking_effort || '')
    setProviderId(info.configured.provider_id || '')
    setModelError('')
    setNotice('')
    setError('')
  }

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    assistantApi.list()
      .then(({ assistants: items }) => {
        setAssistants(items)
        if (items.length > 0) applyAssistant(items[0])
        setError('')
      })
      .catch((reason) => setError(
        reason instanceof Error ? reason.message : t('settings.readAssistantFailed')
      ))
      .finally(() => setLoading(false))
    setProvidersLoading(true)
    providerApi.list()
      .then((result) => setProviders(
        result.providers.filter((item) => item.enabled),
      ))
      .finally(() => setProvidersLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  engineRef.current = engine
  const selectedEngineInfo = engines.find((item) => item.id === engine)
  const engineSupportsProvider = Boolean(selectedEngineInfo?.supports_provider)
  const compatibleProviders = providers.filter((item) => (
    (selectedEngineInfo?.provider_protocols || []).some((protocol) =>
      (item.protocols?.length ? item.protocols : [item.protocol]).includes(protocol),
    )
  ))

  const loadAssistantModels = async (engineId: string, force: boolean) => {
    if (!force) {
      const cached = getCachedEngineModels(
        engineId,
        engineSupportsProvider ? providerId : '',
      )
      if (cached) {
        if (engineRef.current !== engineId) return
        setModels(cached.models || [])
        setModelError(cached.error || '')
        setModelsLoading(false)
        return
      }
    }
    setModelsLoading(true)
    setModelError('')
    try {
      const result = await fetchEngineModels(
        engineId,
        force,
        engineSupportsProvider ? providerId : '',
      )
      if (engineRef.current !== engineId) return
      setModels(result.models || [])
      setModelError(result.error || '')
    } catch (reason) {
      if (engineRef.current !== engineId) return
      setModels([])
      setModelError(reason instanceof Error ? reason.message : t('settings.readModelsFailed'))
    } finally {
      if (engineRef.current === engineId) setModelsLoading(false)
    }
  }

  useEffect(() => {
    if (!engine) {
      setModels([])
      setModelError('')
      return
    }
    void loadAssistantModels(engine, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine])

  useEffect(() => {
    if (engineSupportsProvider) {
      // 切换供应商只读已保存的模型列表；远端请求仅由刷新按钮触发。
      void loadAssistantModels(engine, false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, engineSupportsProvider])

  const changeEngine = (engineId: string) => {
    setEngine(engineId)
    setModel('')
    setFastModel('')
    setVisionModel('')
    setProviderId('')
    setNotice('')
  }

  const save = async () => {
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const result = await assistantApi.setConfig(selectedName, {
        engine,
        model: fields.includes('model') ? model : '',
        fastModel: fields.includes('fast_model') ? fastModel : '',
        visionModel: fields.includes('vision_model') ? visionModel : '',
        thinkingEffort: fields.includes('thinking_effort') ? thinkingEffort : '',
        providerId: fields.includes('provider_id') && engineSupportsProvider ? providerId : '',
      })
      setAssistants((prev) => prev.map((item) =>
        item.name === selectedName
          ? {
            ...item,
            configured: { ...item.configured, ...result.configured },
            resolved: {
              engine: '',
              model: '',
              fast_model: '',
              vision_model: '',
              thinking_effort: '',
              provider_id: '',
              ...(item.resolved || {}),
              ...result.resolved,
            },
          }
          : item,
      ))
      setResolvedDefaults((current) => current
        ? { ...current, ...result.resolved }
        : {
          engine: '',
          model: '',
          fast_model: '',
          vision_model: '',
          thinking_effort: '',
          provider_id: '',
          ...result.resolved,
        }
      )
      setNotice(t('settings.saveAssistantSuccess'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('settings.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 'calc(20px * var(--font-scale))', fontWeight: 650, marginBottom: 6 }}>{t('settings.assistantTitle')}</h1>
        <p style={{ color: 'var(--muted)', fontSize: 'calc(13px * var(--font-scale))' }}>
          {t('settings.assistantIntro')}
        </p>
      </div>
      <div style={{ padding: 20, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg)' }}>
        <div
          role="group"
          aria-label={t('settings.assistantSelectAria')}
          style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}
        >
          {assistants.map((item) => {
            const active = item.name === selectedName
            return (
              <button
                key={item.name}
                type="button"
                disabled={loading || saving}
                onClick={() => applyAssistant(item)}
                style={{
                  height: 30, padding: '0 14px', border: active ? '1px solid var(--accent)' : '1px solid var(--border)',
                  borderRadius: 999, cursor: loading || saving ? 'default' : 'pointer',
                  background: active ? 'color-mix(in oklab, var(--accent), transparent 88%)' : 'transparent',
                  color: active ? 'var(--accent)' : 'var(--fg-2)',
                  fontSize: 'calc(12px * var(--font-scale))', fontWeight: 600, fontFamily: 'var(--font-body)',
                }}
              >
                {getAssistantLabel(item.name, t)}
              </button>
            )
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <label style={{ flexShrink: 0, fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600, width: 84 }}>
            {t('settings.assistantEngine')}
          </label>
          <EngineSelect
            engines={engines}
            value={engine}
            onChange={changeEngine}
            disabled={loading || saving}
            requireCoordinator
            allowUnconfiguredBuiltin
            defaultOption={{ value: '', label: t('settings.followDefaultEngine') }}
            ariaLabel={t('settings.defaultAssistantAria')}
            style={{ flex: 1, minWidth: 0, height: 30 }}
          />
        </div>
        {engineSupportsProvider && fields.includes('provider_id') && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <label style={{ flexShrink: 0, fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600, width: 84 }}>
              {t('settings.assistantProvider')}
            </label>
            <Select
              value={providerId}
              disabled={providersLoading || saving}
              onChange={(event) => {
                setProviderId(event.target.value)
                setModel('')
                setFastModel('')
                setVisionModel('')
              }}
              aria-label={t('settings.assistantProviderAria')}
              style={{ flex: 1, minWidth: 0, height: 30 }}
            >
              <option value="">
                {providersLoading
                  ? t('flow.modelsLoading')
                  : t('settings.followEngineProvider')}
              </option>
              {compatibleProviders.length === 0 && !providersLoading && (
                <option value="" disabled>
                  {t('settings.assistantProviderEmpty')}
                </option>
              )}
              {compatibleProviders.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name || item.id}
                </option>
              ))}
            </Select>
          </div>
        )}
        {fields.includes('model') && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <label style={{ flexShrink: 0, fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600, width: 84 }}>
              {t('settings.reasoningModel')}
            </label>
            <Select
              value={model}
              disabled={!engine || modelsLoading || saving}
              onChange={(event) => setModel(event.target.value)}
              aria-label={t('settings.defaultReasoningAria')}
              style={{
                flex: 1, minWidth: 0, height: 30,
              }}
            >
              <option value="">
                {!engine ? t('settings.selectEngineFirst') : modelsLoading ? t('flow.modelsLoading') : t('flow.engineDefaultModel')}
              </option>
              {model && !models.some((item) => item.id === model) && (
                <option value={model}>{model}{t('flow.currentConfigSuffix')}</option>
              )}
              {models.map((item) => (
                <option key={item.id} value={item.id}>{item.label || item.id}</option>
              ))}
            </Select>
            {engine && (
              <Button
                variant="ghost"
                style={{ flexShrink: 0, height: 28, padding: '0 8px', fontSize: 'calc(11px * var(--font-scale))' }}
                disabled={modelsLoading || saving}
                onClick={() => void loadAssistantModels(engine, true)}
              >
                {t('settings.refresh')}
              </Button>
            )}
          </div>
        )}
        {fields.includes('fast_model') && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <label style={{ flexShrink: 0, fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600, width: 84 }}>
              {t('settings.fastModel')}
            </label>
            <Select
              value={fastModel}
              disabled={!engine || modelsLoading || saving}
              onChange={(event) => setFastModel(event.target.value)}
              aria-label={t('settings.defaultFastAria')}
              style={{
                flex: 1, minWidth: 0, height: 30,
              }}
            >
              <option value="">
                {!engine ? t('settings.selectEngineFirst') : modelsLoading ? t('flow.modelsLoading') : t('settings.followReasoning')}
              </option>
              {fastModel && !models.some((item) => item.id === fastModel) && (
                <option value={fastModel}>{fastModel}{t('flow.currentConfigSuffix')}</option>
              )}
              {models.map((item) => (
                <option key={item.id} value={item.id}>{item.label || item.id}</option>
              ))}
            </Select>
          </div>
        )}
        {fields.includes('thinking_effort') && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <label style={{ flexShrink: 0, fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600, width: 84 }}>
              {t('coord.thinkingEffort')}
            </label>
            <Select
              value={thinkingEffort}
              disabled={loading || saving}
              onChange={(event) => setThinkingEffort(event.target.value)}
              title={t('coord.thinkingEffortTitle')}
              style={{ flex: 1, minWidth: 0, height: 30 }}
            >
              <option value="">
                {resolvedDefaults?.thinking_effort
                  ? t('settings.followEngineDefaultWithValue', {
                    value: t(`coord.thinkingLevels.${resolvedDefaults.thinking_effort as 'auto'}`),
                  })
                  : t('settings.followEngineDefault')}
              </option>
              {THINKING_EFFORT_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {t(`coord.thinkingLevels.${level}`)}
                </option>
              ))}
            </Select>
          </div>
        )}
        {fields.includes('vision_model') && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <label style={{ flexShrink: 0, fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600, width: 84 }}>
              {t('settings.visionModel')}
            </label>
            <Select
              value={visionModel}
              disabled={!engine || modelsLoading || saving}
              onChange={(event) => setVisionModel(event.target.value)}
              aria-label={t('settings.defaultVisionAria')}
              style={{
                flex: 1, minWidth: 0, height: 30,
              }}
            >
              <option value="">
                {!engine ? t('settings.selectEngineFirst') : modelsLoading ? t('flow.modelsLoading') : t('settings.followReasoning')}
              </option>
              {visionModel && !models.some((item) => item.id === visionModel) && (
                <option value={visionModel}>{visionModel}{t('flow.currentConfigSuffix')}</option>
              )}
              {models.map((item) => (
                <option key={item.id} value={item.id}>{item.label || item.id}</option>
              ))}
            </Select>
          </div>
        )}
        <div style={{ marginBottom: 12, fontSize: 'calc(11px * var(--font-scale))', color: 'var(--meta)' }}>
          {t('settings.modelRolesHint')}
        </div>
        {modelError && (
          <div style={{ marginTop: 7, fontSize: 'calc(11px * var(--font-scale))', color: 'var(--warn)' }}>
            {t('settings.modelErrorHint', { error: modelError })}
          </div>
        )}
        <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div style={{ fontSize: 'calc(11px * var(--font-scale))', color: error ? 'var(--danger)' : notice ? 'var(--success)' : 'var(--meta)' }}>
            {error || notice || t('settings.inProgressHint')}
          </div>
          <Button variant="primary" disabled={loading || saving} loading={saving} onClick={() => void save()}>
            {t('settings.saveAssistant')}
          </Button>
        </div>
      </div>
      <PromptEnhanceSettings />
    </div>
  )
}

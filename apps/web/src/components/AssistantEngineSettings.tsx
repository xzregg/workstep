import SettingsHelpButton from './SettingsHelpButton'
import './AssistantEngineSettings.css'
import { useEffect, useRef, useState } from 'react'
import { assistantApi, providerApi, systemSettingsApi, type ModelSetting, fetchEngineModels, getCachedEngineModels, type AssistantConfigInfo, type AssistantConfiguredDefaults, type EngineInfo, type EngineModel, type ProviderInfo } from '../api/client'
import EngineSelect from './EngineSelect'
import { engineLabel } from '../engineMeta'
import { engineEffortOptions, thinkingEffortLabel } from '../utils/thinkingEffort'
import Button from './Button'
import Select from './Select'
import { useI18n, type TFunction, type TKey } from '../i18n'
import PromptEnhanceSettings from '../pages/PromptEnhanceSettings'

const ASSISTANT_NAME_KEYS: Record<string, TKey> = {
  prototype: 'prototype.title',
  task_coordinator: 'settings.assistantNames.taskCoordinator',
  task_create: 'settings.assistantNames.taskCreate',
  workflow_gen: 'settings.assistantNames.workflowGen',
  chat_session: 'settings.assistantNames.chatSession',
  channel_chat: 'settings.assistantNames.channelChat',
  digital_person: 'digitalPerson.title',
  digital_person_reflection: 'digitalPerson.proactive',
}

export function getAssistantLabel(name: string, t: TFunction): string {
  const key = ASSISTANT_NAME_KEYS[name]
  return key ? t(key) : name
}

export default function AssistantEngineSettings({ assistantName, onDirtyChange, onBusyChange, section = 'all' }: { assistantName?: string; onDirtyChange?: (dirty: boolean) => void; onBusyChange?: (busy: boolean) => void; section?: 'all' | 'vision' }) {
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
  const [visionCapability, setVisionCapability] = useState<boolean | null>(null)
  const [modelSettings, setModelSettings] = useState<ModelSetting[]>([])
  const [models, setModels] = useState<EngineModel[]>([])
  const [loading, setLoading] = useState(true)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  useEffect(() => { onBusyChange?.(saving) }, [saving, onBusyChange])
  useEffect(() => () => onBusyChange?.(false), [onBusyChange])
  const initialized = useRef(false)
  const engineRef = useRef('')
  const modelRequest = useRef(0)
  const [error, setError] = useState('')
  const [modelError, setModelError] = useState('')
  const [notice, setNotice] = useState('')
  const [savedSnapshot, setSavedSnapshot] = useState('')
  const snapshot = JSON.stringify([engine, model, fastModel, visionModel, thinkingEffort, providerId])
  useEffect(() => { onDirtyChange?.(saving || (!!savedSnapshot && (snapshot !== savedSnapshot || visionCapability !== null))) }, [saving, savedSnapshot, snapshot, visionCapability, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

  const applyAssistant = (info: AssistantConfigInfo) => {
    setSavedSnapshot(JSON.stringify([info.configured.engine || '', info.configured.model || '', info.configured.fast_model || '', info.configured.vision_model || '', info.configured.thinking_effort || '', info.configured.provider_id || '']))
    setVisionCapability(null)
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
        const visible = assistantName
          ? items.filter(item => item.name === assistantName)
          : items.filter(item => !['digital_person','digital_person_reflection'].includes(item.name))
        setAssistants(visible)
        if (visible.length > 0) applyAssistant(visible[0])
        else throw new Error(t('settings.readAssistantFailed'))
        setError('')
      })
      .catch((reason) => setError(
        reason instanceof Error ? reason.message : t('settings.readAssistantFailed')
      ))
      .finally(() => setLoading(false))
    if (section === 'vision') {
      systemSettingsApi.modelSettings().then(value => setModelSettings(value.prices)).catch(reason => setError(String(reason)))
    }
    setProvidersLoading(true)
    providerApi.list()
      .then((result) => setProviders(
        result.providers.filter((item) => item.enabled),
      ))
      .catch(reason => setError(String(reason)))
      .finally(() => setProvidersLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const effectiveEngine = engine || resolvedDefaults?.engine || ''
  const effectiveProvider = providerId || (!engine ? resolvedDefaults?.provider_id : '') || engines.find(item => item.id === effectiveEngine)?.config?.values.provider_id || ''
  engineRef.current = effectiveEngine
  const selectedEngineInfo = engines.find((item) => item.id === effectiveEngine)
  const thinkingOptions = engineEffortOptions(engines.find(item => item.id === (engine || resolvedDefaults?.engine)))
  const engineSupportsProvider = Boolean(selectedEngineInfo?.supports_provider)
  const compatibleProviders = providers.filter((item) => (
    (selectedEngineInfo?.provider_protocols || []).some((protocol) =>
      (item.protocols?.length ? item.protocols : [item.protocol]).includes(protocol),
    )
  ))

  const supportsImages = (modelId: string) => {
    const settings = modelSettings.filter(setting => setting.model === modelId)
    const setting = (effectiveProvider ? settings.find(setting => setting.provider_id === effectiveProvider) : undefined)
      || settings.find(setting => setting.engine_id === effectiveEngine)
      || settings.find(setting => !setting.provider_id && !setting.engine_id)
    return setting?.supports_multimodal === true
  }
  const visionSupportsImages = visionCapability ?? supportsImages(visionModel)

  const loadAssistantModels = async (engineId: string, force: boolean) => {
    const requestId = ++modelRequest.current
    if (!force) {
      const cached = getCachedEngineModels(
        engineId,
        engineSupportsProvider ? effectiveProvider : '',
      )
      if (cached) {
        if (engineRef.current !== engineId || modelRequest.current !== requestId) return
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
        engineSupportsProvider ? effectiveProvider : '',
      )
      if (engineRef.current !== engineId || modelRequest.current !== requestId) return
      setModels(result.models || [])
      setModelError(result.error || '')
    } catch (reason) {
      if (engineRef.current !== engineId || modelRequest.current !== requestId) return
      setModels([])
      setModelError(reason instanceof Error ? reason.message : t('settings.readModelsFailed'))
    } finally {
      if (engineRef.current === engineId && modelRequest.current === requestId) setModelsLoading(false)
    }
  }

  useEffect(() => {
    if (!effectiveEngine) { modelRequest.current++; setModels([]); setModelError(''); setModelsLoading(false); return }
    void loadAssistantModels(effectiveEngine, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveEngine, effectiveProvider, engineSupportsProvider])

  const changeEngine = (engineId: string) => {
    setEngine(engineId)
    setModel('')
    setFastModel('')
    setVisionModel('')
    setVisionCapability(null)
    setProviderId('')
    setNotice('')
  }

  const save = async () => {
    setSaving(true)
    setError('')
    setNotice('')
    try {
      if (section === 'vision' && visionModel && visionCapability !== null) {
        const settings = await systemSettingsApi.modelSettings()
        const source = effectiveProvider ? { provider_id: effectiveProvider, engine_id: null } : { provider_id: null, engine_id: effectiveEngine }
        const index = settings.prices.findIndex(item => item.model === visionModel && (item.provider_id || null) === source.provider_id && (item.engine_id || null) === source.engine_id)
        const prices = [...settings.prices]
        const value = { ...(index >= 0 ? prices[index] : { model: visionModel, model_type: 'chat' as const, input_price: 0, output_price: 0, cache_price: 0, ...source }), supports_multimodal: visionCapability }
        if (index >= 0) prices[index] = value
        else prices.push(value)
        const saved = await systemSettingsApi.saveModelSettings({ currency: settings.currency, usd_to_cny_rate: settings.usd_to_cny_rate, prices })
        setModelSettings(saved.prices)
        setVisionCapability(null)
      }
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
      setSavedSnapshot(snapshot)
      setNotice(t(assistantName==='digital_person_reflection'?'digitalPerson.thinkingModelSaved':'settings.saveAssistantSuccess'))
    } catch (reason) {
      const message=reason instanceof Error?reason.message:t('settings.saveFailed')
      setError(assistantName==='digital_person_reflection'&&message==='Chat session is running'?t('digitalPerson.thinkingModelBusy'):message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="assistant-engine-root">
      {!assistantName && <div className="assistant-engine-heading">
        <h1 className="assistant-engine-title">{t('settings.assistantTitle')}<SettingsHelpButton section="assistants" /></h1>
        <p className="assistant-engine-intro">
          {t('settings.assistantIntro')}
        </p>
      </div>}
      {assistantName && <p className="assistant-engine-intro">{t(assistantName==='digital_person_reflection'?'digitalPerson.thinkingModelHint':section === 'vision' ? 'digitalPerson.visionModelHint' : 'digitalPerson.engineHint')}</p>}
      <div className="assistant-engine-panel">
        {!assistantName && <div
          role="group"
          aria-label={t('settings.assistantSelectAria')}
          className="assistant-engine-tabs"
        >
          {assistants.map((item) => {
            const active = item.name === selectedName
            return (
              <button
                key={item.name}
                type="button"
                disabled={loading || saving}
                onClick={() => applyAssistant(item)}
                className="assistant-engine-tab" aria-pressed={active}
              >
                {getAssistantLabel(item.name, t)}
              </button>
            )
          })}
        </div>}
        <div className="assistant-engine-row">
          <label className="assistant-engine-label">
            {t('settings.assistantEngine')}
          </label>
          <EngineSelect
            engines={engines}
            value={engine}
            onChange={changeEngine}
            disabled={loading || saving}
            requireCoordinator
            allowUnconfiguredBuiltin
            defaultOption={{ value: '', label: section === 'vision' && resolvedDefaults?.engine ? `${t('settings.followDefaultEngine')}（${engineLabel(resolvedDefaults.engine, t)}）` : t('settings.followDefaultEngine') }}
            ariaLabel={t('settings.defaultAssistantAria')}
            className="assistant-engine-control"
          />
        </div>
        {engineSupportsProvider && fields.includes('provider_id') && (
          <div className="assistant-engine-row">
            <label className="assistant-engine-label">
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
                setVisionCapability(null)
              }}
              aria-label={t('settings.assistantProviderAria')}
              className="assistant-engine-control"
            >
              <option value="">
                {providersLoading
                  ? t('flow.modelsLoading')
                  : section === 'vision' && effectiveProvider ? `${t('settings.followEngineProvider')}（${providers.find(item => item.id === effectiveProvider)?.name || effectiveProvider}）` : t('settings.followEngineProvider')}
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
        {section !== 'vision' && fields.includes('model') && (
          <div className="assistant-engine-row">
            <label className="assistant-engine-label">
              {t('settings.reasoningModel')}
            </label>
            <Select
              value={model}
              disabled={!effectiveEngine || modelsLoading || saving}
              onChange={(event) => setModel(event.target.value)}
              aria-label={t('settings.defaultReasoningAria')}
              className="assistant-engine-control"
            >
              <option value="">
                {!effectiveEngine ? t('settings.selectEngineFirst') : modelsLoading ? t('flow.modelsLoading') : t('flow.engineDefaultModel')}
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
                className="assistant-engine-refresh"
                disabled={modelsLoading || saving}
                onClick={() => void loadAssistantModels(engine, true)}
              >
                {t('settings.refresh')}
              </Button>
            )}
          </div>
        )}
        {section !== 'vision' && fields.includes('fast_model') && (
          <div className="assistant-engine-row">
            <label className="assistant-engine-label">
              {t('settings.fastModel')}
            </label>
            <Select
              value={fastModel}
              disabled={!effectiveEngine || modelsLoading || saving}
              onChange={(event) => setFastModel(event.target.value)}
              aria-label={t('settings.defaultFastAria')}
              className="assistant-engine-control"
            >
              <option value="">
                {!effectiveEngine ? t('settings.selectEngineFirst') : modelsLoading ? t('flow.modelsLoading') : t('settings.followReasoning')}
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
        {section !== 'vision' && fields.includes('thinking_effort') && (
          <div className="assistant-engine-row">
            <label className="assistant-engine-label">
              {t('coord.thinkingEffort')}
            </label>
            <Select
              value={thinkingEffort}
              disabled={loading || saving}
              onChange={(event) => setThinkingEffort(event.target.value)}
              title={t('coord.thinkingEffortTitle')}
              className="assistant-engine-control"
            >
              <option value="">
                {resolvedDefaults?.thinking_effort
                  ? t('settings.followEngineDefaultWithValue', {
                    value: thinkingEffortLabel(resolvedDefaults.thinking_effort, t, thinkingOptions),
                  })
                  : t('settings.followEngineDefault')}
              </option>
              {thinkingOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {thinkingEffortLabel(option.value, t, thinkingOptions)}
                </option>
              ))}
            </Select>
          </div>
        )}
        {fields.includes('vision_model') && (
          <div className="assistant-engine-row">
            <label className="assistant-engine-label">
              {t('settings.visionModel')}
            </label>
            <Select
              value={visionModel}
              disabled={!effectiveEngine || modelsLoading || saving}
              onChange={(event) => { setVisionModel(event.target.value); setVisionCapability(null) }}
              aria-label={t('settings.defaultVisionAria')}
              className="assistant-engine-control"
            >
              <option value="">
                {!effectiveEngine ? t('settings.selectEngineFirst') : modelsLoading ? t('flow.modelsLoading') : t('settings.followReasoning')}
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
        {section === 'vision' && visionModel && <label className="assistant-engine-vision-capability"><input type="checkbox" checked={visionSupportsImages} disabled={loading || saving} onChange={event => setVisionCapability(event.target.checked)} />{t('digitalPerson.supportsImageInput')}</label>}
        {section !== 'vision' && <div className="assistant-engine-hint">{t('settings.modelRolesHint')}</div>}
        {modelError && (
          <div className="assistant-engine-error">
            {t('settings.modelErrorHint', { error: modelError })}
          </div>
        )}
        <div className="assistant-engine-footer">
          <div className="assistant-engine-notice" data-status={error ? "error" : notice ? "success" : undefined}>
            {error || notice || t('settings.inProgressHint')}
          </div>
          <Button variant="primary" disabled={loading || saving || !selectedName || (section === 'vision' && (!effectiveEngine || (!!visionModel && !visionSupportsImages) || modelsLoading))} loading={saving} onClick={() => void save()}>
            {t('settings.saveAssistant')}
          </Button>
        </div>
      </div>
      {!assistantName && <PromptEnhanceSettings />}
    </div>
  )
}

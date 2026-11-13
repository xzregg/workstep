import './AssistantEngineSettings.css'
import { useEffect, useRef, useState } from 'react'
import { assistantApi, providerApi, fetchEngineModels, getCachedEngineModels, type AssistantConfigInfo, type AssistantConfiguredDefaults, type EngineInfo, type EngineModel, type ProviderInfo } from '../api/client'
import EngineSelect from './EngineSelect'
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
}

export function getAssistantLabel(name: string, t: TFunction): string {
  const key = ASSISTANT_NAME_KEYS[name]
  return key ? t(key) : name
}

export default function AssistantEngineSettings({ assistantName, onDirtyChange }: { assistantName?: string; onDirtyChange?: (dirty: boolean) => void }) {
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
  const modelRequest = useRef(0)
  const [error, setError] = useState('')
  const [modelError, setModelError] = useState('')
  const [notice, setNotice] = useState('')
  const [savedSnapshot, setSavedSnapshot] = useState('')
  const snapshot = JSON.stringify([engine, model, fastModel, visionModel, thinkingEffort, providerId])
  useEffect(() => { onDirtyChange?.(saving || (!!savedSnapshot && snapshot !== savedSnapshot)) }, [saving, savedSnapshot, snapshot, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

  const applyAssistant = (info: AssistantConfigInfo) => {
    setSavedSnapshot(JSON.stringify([info.configured.engine || '', info.configured.model || '', info.configured.fast_model || '', info.configured.vision_model || '', info.configured.thinking_effort || '', info.configured.provider_id || '']))
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
        const visible = assistantName ? items.filter(item => item.name === assistantName) : items
        setAssistants(visible)
        if (visible.length > 0) applyAssistant(visible[0])
        else throw new Error(t('settings.readAssistantFailed'))
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
      .catch(reason => setError(String(reason)))
      .finally(() => setProvidersLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  engineRef.current = engine
  const selectedEngineInfo = engines.find((item) => item.id === engine)
  const thinkingOptions = engineEffortOptions(engines.find(item => item.id === (engine || resolvedDefaults?.engine)))
  const engineSupportsProvider = Boolean(selectedEngineInfo?.supports_provider)
  const compatibleProviders = providers.filter((item) => (
    (selectedEngineInfo?.provider_protocols || []).some((protocol) =>
      (item.protocols?.length ? item.protocols : [item.protocol]).includes(protocol),
    )
  ))

  const loadAssistantModels = async (engineId: string, force: boolean) => {
    const requestId = ++modelRequest.current
    if (!force) {
      const cached = getCachedEngineModels(
        engineId,
        engineSupportsProvider ? providerId : '',
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
        engineSupportsProvider ? providerId : '',
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
    if (!engine) { modelRequest.current++; setModels([]); setModelError(''); setModelsLoading(false); return }
    void loadAssistantModels(engine, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, providerId, engineSupportsProvider])

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
      setSavedSnapshot(snapshot)
      setNotice(t('settings.saveAssistantSuccess'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('settings.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="assistant-engine-root">
      {!assistantName && <div className="assistant-engine-heading">
        <h1 className="assistant-engine-title">{t('settings.assistantTitle')}</h1>
        <p className="assistant-engine-intro">
          {t('settings.assistantIntro')}
        </p>
      </div>}
      {assistantName && <p className="assistant-engine-intro">{t('digitalPerson.engineHint')}</p>}
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
            defaultOption={{ value: '', label: t('settings.followDefaultEngine') }}
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
              }}
              aria-label={t('settings.assistantProviderAria')}
              className="assistant-engine-control"
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
          <div className="assistant-engine-row">
            <label className="assistant-engine-label">
              {t('settings.reasoningModel')}
            </label>
            <Select
              value={model}
              disabled={!engine || modelsLoading || saving}
              onChange={(event) => setModel(event.target.value)}
              aria-label={t('settings.defaultReasoningAria')}
              className="assistant-engine-control"
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
                className="assistant-engine-refresh"
                disabled={modelsLoading || saving}
                onClick={() => void loadAssistantModels(engine, true)}
              >
                {t('settings.refresh')}
              </Button>
            )}
          </div>
        )}
        {fields.includes('fast_model') && (
          <div className="assistant-engine-row">
            <label className="assistant-engine-label">
              {t('settings.fastModel')}
            </label>
            <Select
              value={fastModel}
              disabled={!engine || modelsLoading || saving}
              onChange={(event) => setFastModel(event.target.value)}
              aria-label={t('settings.defaultFastAria')}
              className="assistant-engine-control"
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
              disabled={!engine || modelsLoading || saving}
              onChange={(event) => setVisionModel(event.target.value)}
              aria-label={t('settings.defaultVisionAria')}
              className="assistant-engine-control"
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
        <div className="assistant-engine-hint">
          {t('settings.modelRolesHint')}
        </div>
        {modelError && (
          <div className="assistant-engine-error">
            {t('settings.modelErrorHint', { error: modelError })}
          </div>
        )}
        <div className="assistant-engine-footer">
          <div className="assistant-engine-notice" data-status={error ? "error" : notice ? "success" : undefined}>
            {error || notice || t('settings.inProgressHint')}
          </div>
          <Button variant="primary" disabled={loading || saving || !selectedName} loading={saving} onClick={() => void save()}>
            {t('settings.saveAssistant')}
          </Button>
        </div>
      </div>
      {!assistantName && <PromptEnhanceSettings />}
    </div>
  )
}

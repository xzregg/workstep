import Icon from '../components/Icon'
import { useEffect, useMemo, useRef, useState } from 'react'
import Button from '../components/Button'
import Input from '../components/Input'
import Select from '../components/Select'
import {
  assistantApi,
  engineApi,
  fetchEngineModels,
  getCachedEngineModels,
  invalidateEngineModels,
  providerApi,
  type AssistantConfigInfo,
  type EngineInfo,
  type EngineInspectResult,
  type EngineInstallResult,
  type EngineModel,
  type EngineTestResult,
  type ProviderInfo,
} from '../api/client'
import EngineConfigForm, { type EngineConfigFormHandle } from '../components/EngineConfigForm'
import EngineSelect from '../components/EngineSelect'
import { THINKING_EFFORT_LEVELS } from '../components/CoordinatorConfigBar'
import TemplateSettings from './TemplateSettings'
import ProviderSettings from './ProviderSettings'
import {
  ENGINE_COLORS,
  engineLabel,
  engineDescription,
} from '../engineMeta'
import { useI18n, type TKey } from '../i18n'
import { useProjectStore } from '../stores/projectStore'
import { useUserSettingsStore } from '../stores/userSettingsStore'


function EngineIcon({ engine }: { engine: EngineInfo }) {
  const color = ENGINE_COLORS[engine.id] || 'var(--muted)'
  const initials = engine.id === 'claude'
    ? 'C'
    : engine.id === 'codex'
      ? '⌘'
      : engine.id.slice(0, 2).toUpperCase()
  return (
    <span style={{
      width: 34, height: 34, borderRadius: 9, flexShrink: 0,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      background: `color-mix(in oklab, ${color}, transparent 86%)`,
      border: `1px solid color-mix(in oklab, ${color}, transparent 72%)`,
      color, fontSize: 13, fontWeight: 700,
    }}>
      {initials}
    </span>
  )
}

function ExecutionDefaultSettings({
  engines,
  loading,
}: {
  engines: EngineInfo[]
  loading: boolean
}) {
  const { t } = useI18n()
  const [engine, setEngine] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loadingConfig, setLoadingConfig] = useState(false)
  const initialized = useRef(false)

  const loadExecutionConfig = async () => {
    setLoadingConfig(true)
    setError('')
    setNotice('')
    try {
      const config = await engineApi.executionConfig()
      setEngine(config.engine)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('settings.readDefaultFailed'))
    } finally {
      setLoadingConfig(false)
    }
  }

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    void loadExecutionConfig()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = async () => {
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const result = await engineApi.setExecutionConfig(engine)
      setEngine(result.engine)
      setNotice(t('settings.saveDefaultSuccess'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('settings.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ padding: 14, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg)', marginBottom: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 650, marginBottom: 4 }}>{t('settings.defaultExecutionEngine')}</div>
      <div style={{ color: 'var(--muted)', fontSize: 11, marginBottom: 10 }}>
        {t('settings.defaultEngineHint')}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <EngineSelect
          engines={engines}
          value={engine}
          onChange={setEngine}
          disabled={loading || saving}
          defaultOption={{ value: '', label: t('settings.systemDefault') }}
          ariaLabel={t('settings.defaultEngineAria')}
          style={{ width: 300, height: 30 }}
        />
        <Button variant="primary" style={{ height: 30 }} disabled={saving || loading || loadingConfig} loading={saving} onClick={() => void save()}>
          {t('settings.saveDefault')}
        </Button>
      </div>
      {(error || notice) && (
        <div style={{ marginTop: 6, fontSize: 11, color: error ? 'var(--danger)' : 'var(--success)' }}>
          {error || notice}
        </div>
      )}
    </div>
  )
}

const ASSISTANT_NAME_KEYS: Record<string, TKey> = {
  task_coordinator: 'settings.assistantNames.taskCoordinator',
  task_create: 'settings.assistantNames.taskCreate',
  workflow_gen: 'settings.assistantNames.workflowGen',
  chat_session: 'settings.assistantNames.chatSession',
}

function AgentAssistantSettings() {
  const { t } = useI18n()
  const [assistants, setAssistants] = useState<AssistantConfigInfo[]>([])
  const [selectedName, setSelectedName] = useState('')
  const [fields, setFields] = useState<string[]>(['engine'])
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

  const loadAssistantModels = async (engineId: string, force: boolean) => {
    if (!force) {
      const cached = getCachedEngineModels(engineId)
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
        engineId === 'pydantic_ai' ? providerId : '',
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
    if (engine === 'pydantic_ai') {
      // 切换供应商读取已保存的模型列表；未保存过才由后端拉取一次并保存。
      void loadAssistantModels(engine, false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId])

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
        providerId: fields.includes('provider_id') && engine === 'pydantic_ai' ? providerId : '',
      })
      setAssistants((prev) => prev.map((item) =>
        item.name === selectedName
          ? { ...item, configured: { ...item.configured, ...result.configured } }
          : item,
      ))
      setNotice(t('settings.saveAssistantSuccess'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('settings.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const assistantLabel = (info: AssistantConfigInfo) =>
    t(ASSISTANT_NAME_KEYS[info.name] || 'settings.assistantSelect')

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 650, marginBottom: 6 }}>{t('settings.assistantTitle')}</h1>
        <p style={{ color: 'var(--muted)', fontSize: 13 }}>
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
                  fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-body)',
                }}
              >
                {assistantLabel(item)}
              </button>
            )
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <label style={{ flexShrink: 0, fontSize: 13, fontWeight: 600, width: 84 }}>
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
        {engine === 'pydantic_ai' && fields.includes('provider_id') && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <label style={{ flexShrink: 0, fontSize: 13, fontWeight: 600, width: 84 }}>
              {t('settings.assistantProvider')}
            </label>
            <Select
              value={providerId}
              disabled={providersLoading || saving}
              onChange={(event) => setProviderId(event.target.value)}
              aria-label={t('settings.assistantProviderAria')}
              style={{ flex: 1, minWidth: 0, height: 30 }}
            >
              <option value="">
                {providersLoading
                  ? t('flow.modelsLoading')
                  : t('settings.followEngineProvider')}
              </option>
              {providers.length === 0 && !providersLoading && (
                <option value="" disabled>
                  {t('settings.assistantProviderEmpty')}
                </option>
              )}
              {providers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name || item.id}
                </option>
              ))}
            </Select>
          </div>
        )}
        {fields.includes('model') && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <label style={{ flexShrink: 0, fontSize: 13, fontWeight: 600, width: 84 }}>
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
                style={{ flexShrink: 0, height: 28, padding: '0 8px', fontSize: 11 }}
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
            <label style={{ flexShrink: 0, fontSize: 13, fontWeight: 600, width: 84 }}>
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
            <label style={{ flexShrink: 0, fontSize: 13, fontWeight: 600, width: 84 }}>
              {t('coord.thinkingEffort')}
            </label>
            <Select
              value={thinkingEffort}
              disabled={loading || saving}
              onChange={(event) => setThinkingEffort(event.target.value)}
              title={t('coord.thinkingEffortTitle')}
              style={{ flex: 1, minWidth: 0, height: 30 }}
            >
              <option value="">{t('coord.thinkingEffortDefault')}</option>
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
            <label style={{ flexShrink: 0, fontSize: 13, fontWeight: 600, width: 84 }}>
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
        <div style={{ marginBottom: 12, fontSize: 11, color: 'var(--meta)' }}>
          {t('settings.modelRolesHint')}
        </div>
        {modelError && (
          <div style={{ marginTop: 7, fontSize: 11, color: 'var(--warn)' }}>
            {t('settings.modelErrorHint', { error: modelError })}
          </div>
        )}
        <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div style={{ fontSize: 11, color: error ? 'var(--danger)' : notice ? 'var(--success)' : 'var(--meta)' }}>
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

function PromptEnhanceSettings() {
  const { t } = useI18n()
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
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
    let active = true
    setModelsLoading(true)
    setModelError('')
    providerApi.models(providerId)
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
  }, [providerId])

  const changeProvider = (value: string) => {
    setProviderId(value)
    setModel('')
    setNotice('')
  }

  const save = async () => {
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const result = await assistantApi.setEnhanceConfig({ providerId, model })
      setProviderId(result.provider_id)
      setModel(result.model)
      setNotice(t('settings.enhanceSaved'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('settings.enhanceSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ padding: 20, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg)', marginTop: 14 }}>
      <div style={{ fontSize: 14, fontWeight: 650, marginBottom: 4 }}>{t('settings.enhanceTitle')}</div>
      <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 14 }}>
        {t('settings.enhanceIntro')}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <label style={{ flexShrink: 0, fontSize: 13, fontWeight: 600, width: 84 }}>
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <label style={{ flexShrink: 0, fontSize: 13, fontWeight: 600, width: 84 }}>
          {t('settings.enhanceModel')}
        </label>
        <Select
          value={model}
          disabled={!providerId || modelsLoading || saving}
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
            style={{ flexShrink: 0, height: 28, padding: '0 8px', fontSize: 11 }}
            disabled={modelsLoading || saving}
            onClick={() => {
              setModelsLoading(true)
              setModelError('')
              providerApi.models(providerId)
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
        <div style={{ marginBottom: 8, fontSize: 11, color: 'var(--warn)' }}>
          {t('settings.enhanceModelErrorHint', { error: modelError })}
        </div>
      )}
      <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div style={{ fontSize: 11, color: error ? 'var(--danger)' : notice ? 'var(--success)' : 'var(--meta)' }}>
          {error || notice}
        </div>
        <Button
          variant="primary"
          disabled={loading || saving}
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
  enabled: boolean
}

interface SettingsPageProps {
  onClose: () => void
}

export default function SettingsPage({ onClose }: SettingsPageProps) {
  const { t, locale, setLocale } = useI18n()
  const userName = useUserSettingsStore((state) => state.userName)
  const userSettingsLoading = useUserSettingsStore((state) => state.loading)
  const userSettingsError = useUserSettingsStore((state) => state.error)
  const saveUserName = useUserSettingsStore((state) => state.saveUserName)
  const [userNameDraft, setUserNameDraft] = useState(userName)
  const [userNameSaved, setUserNameSaved] = useState(false)
  const initialized = useRef(false)
  const [engines, setEngines] = useState<EngineInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [testingEngine, setTestingEngine] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, EngineTestResult>>({})
  const [installingEngine, setInstallingEngine] = useState<string | null>(null)
  const [installResults, setInstallResults] = useState<Record<string, EngineInstallResult>>({})
  const [models, setModels] = useState<Record<string, EngineModel[]>>({})
  const [defaultModels, setDefaultModels] = useState<Record<string, string>>({})
  const [modelErrors, setModelErrors] = useState<Record<string, string>>({})
  const [modelsLoading, setModelsLoading] = useState<Record<string, boolean>>({})
  const [savingModel, setSavingModel] = useState<string | null>(null)
  const [customModelMode, setCustomModelMode] = useState<Record<string, boolean>>({})
  const [customModelDrafts, setCustomModelDrafts] = useState<Record<string, string>>({})
  const [editingEngine, setEditingEngine] = useState<string | null>(null)
  const [expandedConfigs, setExpandedConfigs] = useState<Record<string, boolean>>({})
  const engineFormRefs = useRef<Record<string, EngineConfigFormHandle | null>>({})
  const [engineFormState, setEngineFormState] = useState<Record<string, { saving: boolean; canSave: boolean }>>({})
  const [pathDraft, setPathDraft] = useState('')
  const [pathSaving, setPathSaving] = useState(false)
  const [pathError, setPathError] = useState('')
  const [inspecting, setInspecting] = useState(false)
  const [inspectResult, setInspectResult] = useState<EngineInspectResult | null>(null)
  const [inspectError, setInspectError] = useState('')
  const [activeSection, setActiveSection] = useState<'engines' | 'providers' | 'assistants' | 'templates' | 'system'>('providers')

  useEffect(() => {
    setUserNameDraft(userName)
  }, [userName])

  const handleSaveUserName = async () => {
    if (!await saveUserName(userNameDraft)) return
    setUserNameDraft(userNameDraft.trim())
    setUserNameSaved(true)
  }

  const loadEngineModels = async (engineId: string, force = false) => {
    if ((models[engineId] || modelsLoading[engineId]) && !force) return
    setModelsLoading((current) => ({ ...current, [engineId]: true }))
    let result
    try {
      result = await fetchEngineModels(engineId, force)
    } catch (modelError) {
      result = {
        engine_id: engineId,
        models: [],
        default_model: '',
        error: modelError instanceof Error ? modelError.message : t('settings.readModelsFailed'),
      }
    }
    setModels((current) => ({ ...current, [result.engine_id]: result.models }))
    setDefaultModels((current) => ({
      ...current,
      [result.engine_id]: result.default_model,
    }))
    setCustomModelMode((current) => ({
      ...current,
      [result.engine_id]: Boolean(
        result.default_model
        && !result.models.some((model) => model.id === result.default_model)
      ),
    }))
    setCustomModelDrafts((current) => ({
      ...current,
      [result.engine_id]: result.default_model,
    }))
    setModelErrors((current) => {
      const next = { ...current }
      if (result.error) next[result.engine_id] = result.error
      else delete next[result.engine_id]
      return next
    })
    setModelsLoading((current) => ({ ...current, [result.engine_id]: false }))
  }

  const clearEngineModelCache = (engineId: string) => {
    invalidateEngineModels(engineId)
    setModels((current) => {
      const next = { ...current }
      delete next[engineId]
      return next
    })
    setDefaultModels((current) => {
      const next = { ...current }
      delete next[engineId]
      return next
    })
    setCustomModelMode((current) => {
      const next = { ...current }
      delete next[engineId]
      return next
    })
    setCustomModelDrafts((current) => {
      const next = { ...current }
      delete next[engineId]
      return next
    })
    setModelErrors((current) => {
      const next = { ...current }
      delete next[engineId]
      return next
    })
  }

  const loadEngines = async (rescan: boolean) => {
    setLoading(true)
    setError('')
    try {
      const result = rescan
        ? await engineApi.refresh()
        : await engineApi.list()
      setEngines(result.engines)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('settings.readEnginesFailed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    void loadEngines(false)
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const testEngine = async (engineId: string) => {
    setTestingEngine(engineId)
    setTestResults((current) => {
      const next = { ...current }
      delete next[engineId]
      return next
    })
    try {
      const result = await engineApi.test(engineId)
      setTestResults((current) => ({ ...current, [engineId]: result }))
      if (result.engine) {
        setEngines((current) => current.map((engine) =>
          engine.id === engineId ? result.engine as EngineInfo : engine
        ))
      }
    } catch (testError) {
      setTestResults((current) => ({
        ...current,
        [engineId]: {
          engine_id: engineId,
          success: false,
          message: testError instanceof Error ? testError.message : t('settings.testFailed'),
          duration_ms: 0,
        },
      }))
    } finally {
      setTestingEngine(null)
    }
  }

  const installEngine = async (engineId: string) => {
    setInstallingEngine(engineId)
    setInstallResults((current) => {
      const next = { ...current }
      delete next[engineId]
      return next
    })
    try {
      const result = await engineApi.install(engineId)
      setInstallResults((current) => ({ ...current, [engineId]: result }))
      if (result.success) {
        // 安装成功后重新扫描，让该引擎进入可用列表
        await loadEngines(true)
      }
    } catch (installError) {
      setInstallResults((current) => ({
        ...current,
        [engineId]: {
          engine_id: engineId,
          success: false,
          already_installed: false,
          message: installError instanceof Error
            ? installError.message
            : t('settings.installFailed', { error: '' }),
        },
      }))
    } finally {
      setInstallingEngine(null)
    }
  }

  const viewCapabilities = async (engineId: string) => {
    setInspecting(true)
    setInspectResult(null)
    setInspectError('')
    const project = useProjectStore.getState().activeProject
    try {
      const result = await engineApi.inspect(
        engineId,
        project?.id,
        project?.path || undefined,
      )
      setInspectResult(result)
    } catch (inspectError) {
      setInspectError(
        inspectError instanceof Error
          ? inspectError.message
          : t('settings.inspectFailed', { error: '' }),
      )
    } finally {
      setInspecting(false)
    }
  }

  const saveDefaultModel = async (engineId: string, model: string) => {
    const previous = defaultModels[engineId] || ''
    setDefaultModels((current) => ({ ...current, [engineId]: model }))
    setSavingModel(engineId)
    setEngines((current) => current.map((engine) =>
      engine.id === engineId ? { ...engine, verified: false } : engine
    ))
    try {
      const result = await engineApi.setDefaultModel(engineId, model)
      setDefaultModels((current) => ({
        ...current,
        [engineId]: result.default_model,
      }))
    } catch {
      setDefaultModels((current) => ({ ...current, [engineId]: previous }))
    } finally {
      setSavingModel(null)
    }
  }

  const selectDefaultModel = (engineId: string, value: string) => {
    if (value === '__custom__') {
      const currentModel = defaultModels[engineId] || ''
      const isBuiltIn = (models[engineId] || []).some(
        (model) => model.id === currentModel
      )
      setCustomModelDrafts((current) => ({
        ...current,
        [engineId]: isBuiltIn ? '' : currentModel,
      }))
      setCustomModelMode((current) => ({ ...current, [engineId]: true }))
      return
    }
    setCustomModelMode((current) => ({ ...current, [engineId]: false }))
    void saveDefaultModel(engineId, value)
  }

  const saveCustomModel = (engineId: string) => {
    const model = (customModelDrafts[engineId] || '').trim()
    if (model !== (defaultModels[engineId] || '')) {
      void saveDefaultModel(engineId, model)
    }
  }

  const toggleConfig = (engineId: string) => {
    setExpandedConfigs((current) => ({ ...current, [engineId]: !current[engineId] }))
  }

  const openPathEditor = (engine: EngineInfo) => {
    setEditingEngine(engine.id)
    setPathDraft(engine.configured_path || engine.binary_path || '')
    setPathError('')
  }

  const saveBinaryPath = async (engineId: string) => {
    setPathSaving(true)
    setPathError('')
    try {
      const result = await engineApi.setBinaryPath(engineId, pathDraft)
      if (!result.saved || !result.engine) {
        setPathError(result.message || t('settings.saveFailed'))
        return
      }
      setEngines((current) => current.map((engine) =>
        engine.id === engineId ? result.engine as EngineInfo : engine
      ))
      setEditingEngine(null)
      clearEngineModelCache(engineId)
    } catch (saveError) {
      setPathError(saveError instanceof Error ? saveError.message : t('settings.saveFailed'))
    } finally {
      setPathSaving(false)
    }
  }

  const enginePriority = (id: string) => (
    id === 'pydantic_ai' ? 0 : 1
  )
  const sortedEngines = useMemo(
    () => [...engines].sort((a, b) =>
      enginePriority(a.id) - enginePriority(b.id)
      || Number(b.installed) - Number(a.installed)
    ),
    [engines],
  )
  const installedCount = sortedEngines.filter((engine) => engine.installed).length
  const versionSummary = (version: string | null) =>
    version?.split(/\r?\n/, 1)[0]?.trim() || ''

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t('nav.settings')}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      style={{ padding: 24 }}
    >
      <div
        className="modal"
        onMouseDown={(event) => event.stopPropagation()}
        style={{
          width: 'min(1080px, calc(100vw - 48px))',
          height: 'min(860px, calc(100vh - 48px))',
          maxHeight: 'calc(100vh - 48px)',
        }}
      >
        <div className="modal-header" style={{ padding: '16px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <Icon name="sliders-horizontal" size={18} strokeWidth={2} />
            <span className="modal-title">{t('nav.settings')}</span>
          </div>
          <Button variant="icon" aria-label={t('settings.closeSettings')} onClick={onClose}>✕</Button>
        </div>

      <div className="settings-layout" style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <aside className="settings-nav" style={{
        width: 184, flexShrink: 0, padding: '18px 12px',
        background: 'var(--surface)', borderRight: '1px solid var(--border-soft)',
      }}>
        <div style={{
          padding: '0 10px 8px', color: 'var(--meta)',
          fontSize: 11, fontWeight: 600, letterSpacing: '0.4px',
        }}>
          {t('nav.settings')}
        </div>
        <button
          aria-current={activeSection === 'providers' ? 'page' : undefined}
          onClick={() => setActiveSection('providers')}
          style={{
            width: '100%', height: 38, padding: '0 11px',
            display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
            gap: 9, borderRadius: 8, background: activeSection === 'providers' ? 'var(--bg)' : 'transparent',
            color: activeSection === 'providers' ? 'var(--fg)' : 'var(--muted)', fontSize: 13, fontWeight: 600,
          }}
        >
          <Icon name="sliders-horizontal" size={16} strokeWidth={2} />
          {t('providerSettings.nav')}
        </button>
        <button
          aria-current={activeSection === 'engines' ? 'page' : undefined}
          onClick={() => setActiveSection('engines')}
          style={{
            width: '100%', height: 38, padding: '0 11px', marginTop: 5,
            display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
            gap: 9, borderRadius: 8, background: activeSection === 'engines' ? 'var(--bg)' : 'transparent',
            color: activeSection === 'engines' ? 'var(--fg)' : 'var(--muted)', fontSize: 13, fontWeight: 600,
          }}
        >
          <Icon name="sliders-horizontal" size={16} strokeWidth={2} />
          {t('settings.enginesNav')}
        </button>
        <button
          aria-current={activeSection === 'assistants' ? 'page' : undefined}
          onClick={() => setActiveSection('assistants')}
          style={{
            width: '100%', height: 38, padding: '0 11px', marginTop: 5,
            display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
            gap: 9, borderRadius: 8, background: activeSection === 'assistants' ? 'var(--bg)' : 'transparent',
            color: activeSection === 'assistants' ? 'var(--fg)' : 'var(--muted)', fontSize: 13, fontWeight: 600,
          }}
        >
          <span aria-hidden="true" style={{ fontSize: 16 }}>✦</span>
          {t('settings.assistantNav')}
        </button>
        <button
          aria-current={activeSection === 'templates' ? 'page' : undefined}
          onClick={() => setActiveSection('templates')}
          style={{
            width: '100%', height: 38, padding: '0 11px', marginTop: 5,
            display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
            gap: 9, borderRadius: 8, background: activeSection === 'templates' ? 'var(--bg)' : 'transparent',
            color: activeSection === 'templates' ? 'var(--fg)' : 'var(--muted)', fontSize: 13, fontWeight: 600,
          }}
        >
          <Icon name="layout-grid" size={16} strokeWidth={2} />
          {t('settings.templatesNav')}
        </button>
        <button
          aria-current={activeSection === 'system' ? 'page' : undefined}
          onClick={() => setActiveSection('system')}
          style={{
            width: '100%', height: 38, padding: '0 11px', marginTop: 5,
            display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
            gap: 9, borderRadius: 8, background: activeSection === 'system' ? 'var(--bg)' : 'transparent',
            color: activeSection === 'system' ? 'var(--fg)' : 'var(--muted)', fontSize: 13, fontWeight: 600,
          }}
        >
          <span aria-hidden="true" style={{ fontSize: 15 }}>文</span>
          {t('settings.systemNav')}
        </button>
      </aside>

      <section className="settings-content" style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', padding: '24px 28px 40px' }}>
        {activeSection === 'engines' ? (
        <div style={{ maxWidth: 960, margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 18 }}>
            <div style={{ flex: 1 }}>
              <h1 style={{ fontSize: 20, fontWeight: 650, marginBottom: 6 }}>{t('settings.enginesTitle')}</h1>
              <p style={{ color: 'var(--muted)', fontSize: 13 }}>
                {t('settings.enginesIntro')}
              </p>
            </div>
            <Button
              variant="ghost"
              onClick={() => void loadEngines(true)}
              disabled={loading}
              loading={loading}
            >
              <span aria-hidden="true">↻</span>
              {t('settings.rescan')}
            </Button>
          </div>

          <ExecutionDefaultSettings engines={engines} loading={loading} />          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 8,
          }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              {t('settings.enginesConfig')}
              {!loading && <span style={{ marginLeft: 6, color: 'var(--meta)', fontWeight: 400 }}>({installedCount}/{sortedEngines.length})</span>}
            </span>
            <span style={{ fontSize: 11, color: 'var(--meta)' }}>
              {t('settings.configFormHint')}
            </span>
          </div>

          {error && (
            <div role="alert" style={{
              padding: '10px 12px', marginBottom: 12, borderRadius: 8,
              background: 'color-mix(in oklab, var(--danger), transparent 90%)',
              color: 'var(--danger)', fontSize: 13,
            }}>
              {t('settings.scanFailed', { error })}
            </div>
          )}

          {loading && engines.length === 0 ? (
            <div style={{
              padding: 32, textAlign: 'center', color: 'var(--meta)',
              background: 'var(--bg)', border: '1px solid var(--border)',
              borderRadius: 12,
            }}>
              {t('settings.readingEngines')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {sortedEngines.map((engine) => {
                const testResult = testResults[engine.id]
                const installResult = installResults[engine.id]
                const isTesting = testingEngine === engine.id
                const isInstalling = installingEngine === engine.id
                const engineModels = models[engine.id] || []
                const savedDefaultModel = defaultModels[engine.id] || ''
                const usesCustomModel = Boolean(
                  customModelMode[engine.id]
                  || (
                    savedDefaultModel
                    && !engineModels.some((model) => model.id === savedDefaultModel)
                  )
                )
                const modelSelectRow = (
                  <>
                    <span
                      style={{
                        flexShrink: 0, fontSize: 11, fontWeight: 600,
                        color: 'var(--muted)',
                      }}
                    >
                      {t('chatInput.model')}
                    </span>
                    <Select
                      id={`default-model-${engine.id}`}
                      aria-label={t('settings.defaultModelAria', { name: engineLabel(engine.id, t) })}
                      title={t('settings.defaultModelTitle')}
                      value={usesCustomModel ? '__custom__' : savedDefaultModel}
                      disabled={Boolean(modelsLoading[engine.id]) || savingModel === engine.id}
                      onClick={() => void loadEngineModels(engine.id)}
                      onChange={(event) => selectDefaultModel(engine.id, event.target.value)}
                      style={{
                        flex: '0 1 auto', minWidth: 0, maxWidth: 240, width: 'auto', height: 28,
                      }}
                    >
                      <option value="">
                        {modelsLoading[engine.id] ? t('settings.readingModels') : t('settings.followEngineDefault')}
                      </option>
                      {engineModels.map((model) => (
                        <option key={model.id} value={model.id}>{model.label}</option>
                      ))}
                      <option value="__custom__">{t('settings.customModelOption')}</option>
                    </Select>
                    {savingModel === engine.id && (
                      <span style={{ flexShrink: 0, color: 'var(--meta)', fontSize: 11 }}>
                        {t('settings.saving')}
                      </span>
                    )}
                    {usesCustomModel && (
                      <>
                        <span
                          style={{
                            flexShrink: 0, fontSize: 11,
                            color: 'var(--muted)',
                          }}
                        >
                          {t('settings.customModel')}
                        </span>
                        <Input
                          id={`custom-model-${engine.id}`}
                          value={customModelDrafts[engine.id] ?? savedDefaultModel}
                          placeholder={t('settings.customModelPlaceholder')}
                          disabled={savingModel === engine.id}
                          onChange={(event) => setCustomModelDrafts((current) => ({
                            ...current,
                            [engine.id]: event.target.value,
                          }))}
                          onBlur={() => saveCustomModel(engine.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.currentTarget.blur()
                            }
                          }}
                          style={{
                            flex: '0 1 auto', minWidth: 0, maxWidth: 200, width: 'auto', height: 28,
                          }}
                        />
                      </>
                    )}
                    {!modelsLoading[engine.id] && (
                      <Button
                        variant="ghost"
                        style={{ flexShrink: 0, height: 24, padding: '0 8px', fontSize: 11 }}
                        onClick={() => void loadEngineModels(engine.id, true)}
                      >
                        {t('settings.refresh')}
                      </Button>
                    )}
                  </>
                )
                const isExpanded = expandedConfigs[engine.id] === true
                return (
                <div
                  key={engine.id}
                  data-engine-id={engine.id}
                  data-installed={engine.installed}
                  style={{
                    borderRadius: 12,
                    border: `1px solid ${engine.installed ? 'var(--border)' : 'var(--border-soft)'}`,
                    background: 'var(--bg)',
                    opacity: engine.installed ? 1 : 0.62,
                  }}
                >
                  <div style={{
                    padding: '12px 14px', display: 'flex',
                    alignItems: 'center', gap: 12, flexWrap: 'wrap', rowGap: 8,
                  }}>
                  <Button
                    variant="ghost"
                    aria-label={isExpanded ? t('settings.collapseConfig') : t('settings.expandConfig')}
                    title={isExpanded ? t('settings.collapseConfig') : t('settings.expandConfig')}
                    onClick={() => toggleConfig(engine.id)}
                    style={{
                      flexShrink: 0, width: 28, height: 28, padding: 0,
                      justifyContent: 'center',
                    }}
                  >
                    <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size={14} />
                  </Button>
                  <EngineIcon engine={engine} />
                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={isExpanded}
                    onClick={() => toggleConfig(engine.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        toggleConfig(engine.id)
                      }
                    }}
                    title={isExpanded ? t('settings.collapseConfig') : t('settings.expandConfig')}
                    style={{ flex: 1, minWidth: 0, cursor: 'pointer' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{engineLabel(engine.id, t)}</span>
                      {engine.mode && (
                        <span style={{
                          padding: '1px 6px', borderRadius: 999,
                          background: 'var(--surface)', color: 'var(--muted)',
                          fontSize: 11, textTransform: 'uppercase',
                        }}>
                          {engine.mode}
                        </span>
                      )}
                    </div>
                    <div style={{ color: 'var(--muted)', fontSize: 11, overflowWrap: 'anywhere' }}>
                      {engineDescription(engine.id, t)}
                      {engine.version && <span> · {versionSummary(engine.version)}</span>}
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
                        {testResult.duration_ms > 0 && ` · ${testResult.duration_ms}ms`}
                      </div>
                    )}
                    {installResult && (
                      <div
                        role="status"
                        style={{
                          marginTop: 7, fontSize: 11,
                          color: installResult.success ? 'var(--success)' : 'var(--danger)',
                          overflowWrap: 'anywhere',
                        }}
                      >
                        {installResult.success ? '✓' : '×'} {installResult.message}
                      </div>
                    )}
                  </div>
                  {engine.installed && (
                    <Button
                      variant="ghost"
                      style={{ minWidth: 62, height: 30, justifyContent: 'center' }}
                      disabled={testingEngine !== null}
                      loading={isTesting}
                      onClick={() => void testEngine(engine.id)}
                    >
                      {t('settings.test')}
                    </Button>
                  )}

                  {!engine.installed && engine.installable && (
                    <Button
                      variant="ghost"
                      style={{ minWidth: 62, height: 30, justifyContent: 'center' }}
                      disabled={installingEngine !== null}
                      loading={isInstalling}
                      title={engine.install_command
                        ? `${t('settings.installHint')}：${engine.install_command}`
                        : undefined}
                      onClick={() => void installEngine(engine.id)}
                    >
                      {t('settings.install')}
                    </Button>
                  )}
                  {engine.id === 'pydantic_ai' && engine.installed && (
                    <Button
                      variant="ghost"
                      style={{ minWidth: 62, height: 30, justifyContent: 'center' }}
                      disabled={inspecting}
                      loading={inspecting}
                      onClick={() => void viewCapabilities(engine.id)}
                    >
                      {t('settings.viewCapabilities')}
                    </Button>
                  )}


                  <span style={{
                    minWidth: 60, textAlign: 'center', padding: '3px 8px',
                    borderRadius: 999, fontSize: 11, fontWeight: 600,
                    color: engine.verified
                      ? 'var(--success)'
                      : engine.installed ? 'var(--warn)' : 'var(--meta)',
                    background: engine.verified
                      ? 'color-mix(in oklab, var(--success), transparent 88%)'
                      : engine.installed
                        ? 'color-mix(in oklab, var(--warn), transparent 88%)'
                      : 'var(--surface)',
                  }}>
                    {engine.verified ? t('settings.verified') : engine.installed ? t('engine.needsTest') : t('engine.notInstalled')}
                  </span>
                  {engine.config && (
                    <Button
                      variant="primary"
                      style={{ minWidth: 84, height: 30, justifyContent: 'center' }}
                      disabled={!engineFormState[engine.id]?.canSave}
                      loading={engineFormState[engine.id]?.saving}
                      onClick={() => {
                        if (!isExpanded) {
                          setExpandedConfigs((current) => ({ ...current, [engine.id]: true }))
                        }
                        engineFormRefs.current[engine.id]?.save()
                      }}
                    >
                      {t('engineForm.saveConfig')}
                    </Button>
                  )}
                  </div>
                  <div style={{ display: isExpanded ? undefined : 'none' }}>
                  {engine.config && (
                    <EngineConfigForm
                      ref={(el) => { engineFormRefs.current[engine.id] = el }}
                      engineId={engine.id}
                      config={engine.config}
                      footerSlot={engine.installed ? (
                        <>
                          {modelSelectRow}
                          {engine.id !== 'pydantic_ai' && (
                            <Button
                              variant="ghost"
                              style={{ flexShrink: 0, height: 24, padding: '0 8px', fontSize: 11 }}
                              onClick={() => openPathEditor(engine)}
                            >
                              {t('settings.editPath')}
                            </Button>
                          )}
                        </>
                      ) : undefined}
                      onFormStateChange={(state) => setEngineFormState((current) => ({
                        ...current,
                        [engine.id]: state,
                      }))}
                      onSaved={(result) => {
                        if (result.engine) {
                          setEngines((current) => current.map((item) =>
                            item.id === engine.id ? result.engine as EngineInfo : item
                          ))
                        }
                        clearEngineModelCache(engine.id)
                      }}
                    />
                  )}
                  {engine.installed && (!engine.config || modelErrors[engine.id]) && (
                    <div style={{
                      padding: '9px 14px',
                      borderTop: '1px solid var(--border-soft)',
                      background: 'var(--surface)',
                    }}>
                      {!engine.config && (
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: 8,
                          flexWrap: 'wrap', rowGap: 8,
                        }}>
                          {modelSelectRow}
                          {engine.id !== 'pydantic_ai' && (
                            <Button
                              variant="ghost"
                              style={{ flexShrink: 0, height: 24, padding: '0 8px', fontSize: 11 }}
                              onClick={() => openPathEditor(engine)}
                            >
                              {t('settings.editPath')}
                            </Button>
                          )}
                        </div>
                      )}
                      {modelErrors[engine.id] && (
                        <div style={{
                          marginTop: 4, color: 'var(--meta)', fontSize: 11,
                        }}>
                          {t('settings.modelErrorHint2', { error: modelErrors[engine.id] })}
                        </div>
                      )}
                    </div>
                  )}
                  {!engine.installed && engine.id !== 'pydantic_ai' && (
                    <div style={{
                      padding: '9px 14px', borderTop: '1px solid var(--border-soft)',
                      background: 'var(--surface)', borderRadius: '0 0 12px 12px',
                    }}>
                      <Button
                        variant="ghost"
                        style={{ height: 28, padding: '0 10px', fontSize: 12 }}
                        onClick={() => openPathEditor(engine)}
                      >
                        {t('settings.editPath')}
                      </Button>
                    </div>
                  )}
                  {editingEngine === engine.id && (
                    <div style={{
                      padding: '10px 14px 12px', borderTop: '1px solid var(--border-soft)',
                      background: 'var(--surface)', borderRadius: '0 0 12px 12px',
                    }}>
                      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 7 }}>
                        {t('settings.binaryPath')}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Input
                          value={pathDraft}
                          onChange={(event) => setPathDraft(event.target.value)}
                          placeholder={t('settings.binaryPathPlaceholder')}
                          autoFocus
                          style={{
                            flex: 1, minWidth: 0, height: 30,
                            border: `1px solid ${pathError ? 'var(--danger)' : 'var(--border)'}`,
                          }}
                        />
                        <Button
                          variant="ghost"
                          disabled={pathSaving}
                          onClick={() => setEditingEngine(null)}
                        >
                          {t('common.cancel')}
                        </Button>
                        <Button
                          variant="primary"
                          disabled={pathSaving}
                          loading={pathSaving}
                          onClick={() => void saveBinaryPath(engine.id)}
                        >
                          {t('settings.saveAndScan')}
                        </Button>
                      </div>
                      <div style={{
                        marginTop: 6, fontSize: 11,
                        color: pathError ? 'var(--danger)' : 'var(--meta)',
                      }}>
                        {pathError || t('settings.pathHint')}
                      </div>
                    </div>
                  )}
                  </div>
                </div>
                )
              })}
            </div>
          )}
        </div>
        ) : activeSection === 'providers' ? (
          <ProviderSettings
            onChanged={() => {
              clearEngineModelCache('pydantic_ai')
              void loadEngines(false)
            }}
          />
        ) : activeSection === 'templates' ? (
          <TemplateSettings />
        ) : activeSection === 'system' ? (
          <div style={{ maxWidth: 640, margin: '0 auto' }}>
            <h1 style={{ fontSize: 20, fontWeight: 650, marginBottom: 6 }}>{t('settings.systemTitle')}</h1>
            <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 22 }}>
              {t('settings.systemIntro')}
            </p>
            <div style={{ paddingBottom: 22, marginBottom: 22, borderBottom: '1px solid var(--border-soft)' }}>
              <h2 style={{ fontSize: 14, fontWeight: 650, marginBottom: 5 }}>{t('settings.userName')}</h2>
              <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 10 }}>
                {t('settings.userNameIntro')}
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, maxWidth: 420 }}>
                <Input
                  value={userNameDraft}
                  onChange={(event) => {
                    setUserNameDraft(event.target.value)
                    setUserNameSaved(false)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && userNameDraft.trim() && !userSettingsLoading) void handleSaveUserName()
                  }}
                  placeholder={t('settings.userNamePlaceholder')}
                  aria-label={t('settings.userName')}
                  maxLength={80}
                  style={{ flex: 1 }}
                />
                <Button
                  variant="primary"
                  loading={userSettingsLoading}
                  disabled={!userNameDraft.trim()}
                  onClick={() => void handleSaveUserName()}
                >
                  {t('common.save')}
                </Button>
              </div>
              {userNameSaved && (
                <div role="status" style={{ marginTop: 7, color: 'var(--success)', fontSize: 11 }}>
                  {t('settings.userNameSaved')}
                </div>
              )}
              {userSettingsError && (
                <div role="status" style={{ marginTop: 7, color: 'var(--danger)', fontSize: 11 }}>
                  {userSettingsError}
                </div>
              )}
            </div>
            <h2 style={{ fontSize: 14, fontWeight: 650, marginBottom: 5 }}>{t('nav.language')}</h2>
            <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 12 }}>
              {t('settings.languageIntro')}
            </p>
            <div
              role="group"
              aria-label={t('nav.language')}
              style={{
                display: 'flex', maxWidth: 320,
                border: '1px solid var(--border-soft)', borderRadius: 10,
                overflow: 'hidden', background: 'var(--bg)',
              }}
            >
              {(['zh-CN', 'zh-TW', 'en-US', 'ja-JP'] as const).map((lang) => (
                <button
                  key={lang}
                  type="button"
                  onClick={() => setLocale(lang)}
                  style={{
                    flex: 1, height: 38, border: 'none', cursor: 'pointer',
                    background: locale === lang ? 'var(--accent)' : 'transparent',
                    color: locale === lang ? 'var(--accent-fg)' : 'var(--fg-2)',
                    fontSize: 13, fontWeight: 600, fontFamily: 'var(--font-body)',
                  }}
                >
                  {lang === 'zh-CN' ? '简体中文'
                    : lang === 'zh-TW' ? '繁體中文'
                      : lang === 'ja-JP' ? '日本語'
                        : 'English'}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <AgentAssistantSettings />
        )}
      </section>
      </div>
      </div>
      {(inspecting || inspectResult || inspectError) && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t('settings.viewCapabilitiesTitle')}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setInspectResult(null)
              setInspectError('')
            }
          }}
          style={{ padding: 24, zIndex: 60 }}
        >
          <div
            className="modal"
            onMouseDown={(event) => event.stopPropagation()}
            style={{ width: 640, maxWidth: 'calc(100vw - 48px)', maxHeight: 'calc(100vh - 48px)' }}
          >
            <div className="modal-header" style={{ padding: '16px 20px' }}>
              <span className="modal-title">{t('settings.viewCapabilitiesTitle')}</span>
              <Button
                variant="icon"
                aria-label={t('settings.closeSettings')}
                onClick={() => {
                  setInspectResult(null)
                  setInspectError('')
                }}
              >✕</Button>
            </div>
            <div className="modal-body" style={{ padding: '18px 20px 20px', overflowY: 'auto' }}>
              {inspecting ? (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--meta)', fontSize: 13 }}>
                  {t('settings.inspectLoading')}
                </div>
              ) : inspectError ? (
                <div role="status" style={{ color: 'var(--danger)', fontSize: 13, overflowWrap: 'anywhere' }}>
                  × {inspectError}
                </div>
              ) : inspectResult ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <div style={{ fontSize: 12, color: 'var(--meta)', overflowWrap: 'anywhere' }}>
                    {inspectResult.project_root
                      ? t('settings.inspectProject', { path: inspectResult.project_root })
                      : t('settings.inspectProjectNone')}
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 7 }}>
                      {t('settings.inspectSkills')}
                      <span style={{ color: 'var(--meta)', fontWeight: 400 }}>
                        {' '}· {inspectResult.skills.length}
                      </span>
                    </div>
                    {inspectResult.skills.length === 0 ? (
                      <div style={{ color: 'var(--muted)', fontSize: 12 }}>
                        {t('settings.inspectSkillsEmpty')}
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {inspectResult.skills.map((skill) => (
                          <div
                            key={`${skill.source_dir}:${skill.name}`}
                            style={{
                              border: '1px solid var(--border-soft)', borderRadius: 8,
                              padding: '8px 10px', background: 'var(--surface)',
                            }}
                          >
                            <div style={{ fontSize: 12, fontWeight: 600 }}>{skill.name}</div>
                            {skill.description && (
                              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                                {skill.description}
                              </div>
                            )}
                            <div style={{ fontSize: 11, color: 'var(--meta)', marginTop: 4, overflowWrap: 'anywhere' }}>
                              {skill.source_dir}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 7 }}>
                      {t('settings.inspectMcp')}
                      <span style={{ color: 'var(--meta)', fontWeight: 400 }}>
                        {' '}· {inspectResult.mcp_servers.length}
                      </span>
                    </div>
                    {inspectResult.mcp_supported ? (
                      <div style={{ fontSize: 12, color: 'var(--success)', marginBottom: 6 }}>
                        ✓ {t('settings.inspectMcpSupported')}
                      </div>
                    ) : (
                      <div style={{ fontSize: 12, color: 'var(--warn)', marginBottom: 6, overflowWrap: 'anywhere' }}>
                        {inspectResult.mcp_error || t('settings.inspectMcpUnsupported')}
                      </div>
                    )}
                    {inspectResult.mcp_servers.length === 0 ? (
                      <div style={{ color: 'var(--muted)', fontSize: 12 }}>
                        {t('settings.inspectMcpEmpty')}
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {inspectResult.mcp_servers.map((server) => (
                          <div
                            key={server.name}
                            style={{
                              border: '1px solid var(--border-soft)', borderRadius: 8,
                              padding: '8px 10px', background: 'var(--surface)',
                            }}
                          >
                            <div style={{ fontSize: 12, fontWeight: 600 }}>{server.name}</div>
                            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, overflowWrap: 'anywhere' }}>
                              {server.command} {server.args.join(' ')}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}
      </div>
  )
}

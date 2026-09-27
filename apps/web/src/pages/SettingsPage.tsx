import AgentAssistantSettings from './AgentAssistantSettings'
import ResizablePanel from '../components/ResizablePanel'
import GitScanSettings from './GitScanSettings'
import ProjectDirectorySetting from '../components/ProjectDirectorySetting'
import { useCompactLayout } from '../hooks/useCompactLayout'
import { useOverlay } from '../hooks/useOverlay'
import Icon from '../components/Icon'
import { useEffect, useMemo, useRef, useState } from 'react'
import Button from '../components/Button'
import Input from '../components/Input'
import Select from '../components/Select'
import SegmentedControl from '../components/SegmentedControl'
import {
  engineApi,
  fetchEngineModels,
  invalidateEngineModels,
  providerApi,
  type EngineInfo,
  type EngineInspectResult,
  type EngineModel,
  type EngineTestResult,
} from '../api/client'
import EngineConfigForm, { type EngineConfigFormHandle } from '../components/EngineConfigForm'
import ExecutionDefaultSettings from '../components/ExecutionDefaultSettings'
import SettingsNavigation, { type SettingsSection } from '../components/SettingsNavigation'
import EngineRuntimeControl from '../components/EngineRuntimeControl'
import TemplateSettings from './TemplateSettings'
import ProviderSettings from './ProviderSettings'
import RemoteProjectSettings from './RemoteProjectSettings'
import ModelPricingSettings from './ModelPricingSettings'
import ChannelsPage from './ChannelsPage'
import GlobalConcurrencySettings from './GlobalConcurrencySettings'
import {
  ENGINE_COLORS,
  engineLabel,
  engineDescription,
  sortExecutionEngines,
} from '../engineMeta'
import { useI18n } from '../i18n'
import { useProjectStore } from '../stores/projectStore'
import { publishEngineCatalog } from '../stores/engineAvailabilityStore'
import { useOnboardingStore } from '../stores/onboardingStore'
import { useUserSettingsStore } from '../stores/userSettingsStore'
import {
  loadFontSizePreference,
  saveFontSizePreference,
  type FontSizePreference,
} from '../utils/fontSizePreference'


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
      color, fontSize: 'calc(13px * var(--font-scale))', fontWeight: 700,
    }}>
      {initials}
    </span>
  )
}

export type { SettingsSection } from '../components/SettingsNavigation'
export type SettingsFocusTarget = 'provider-create' | 'execution-engine'

interface SettingsPageProps {
  onClose: () => void
  initialSection?: SettingsSection
  focusTarget?: SettingsFocusTarget
  preferredProviderId?: string | null
  onConfigurationChanged?: () => void
}

export default function SettingsPage({
  onClose,
  initialSection = 'providers',
  focusTarget,
  preferredProviderId,
  onConfigurationChanged,
}: SettingsPageProps) {
  const { t, locale, setLocale } = useI18n()
  const compactLayout = useCompactLayout()
  const settingsDialogRef = useRef<HTMLDivElement>(null)
  useOverlay(true, onClose, settingsDialogRef, compactLayout)
  const userName = useUserSettingsStore((state) => state.userName)
  const userSettingsLoading = useUserSettingsStore((state) => state.loading)
  const userSettingsError = useUserSettingsStore((state) => state.error)
  const saveUserName = useUserSettingsStore((state) => state.saveUserName)
  const openMode = useUserSettingsStore((state) => state.openMode)
  const saveOpenMode = useUserSettingsStore((state) => state.saveOpenMode)
  const [userNameDraft, setUserNameDraft] = useState(userName)
  const [userNameSaved, setUserNameSaved] = useState(false)
  const [fontSize, setFontSize] = useState(loadFontSizePreference)
  const initialized = useRef(false)
  const [engines, setEngines] = useState<EngineInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [testingEngine, setTestingEngine] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, EngineTestResult>>({})
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
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection)
  const [preferredProviderProtocol, setPreferredProviderProtocol] = useState('')
  useEffect(() => {
    setActiveSection(initialSection)
  }, [initialSection])

  // 引擎的安装 / 配置 / 测试状态每次变化都同步给共享可用性，聊天框和步骤引擎下拉
  // 才能立即跟随禁用状态（设置弹框是浮层，不会卸载底下的聊天页）。
  useEffect(() => {
    if (engines.length > 0) publishEngineCatalog(engines)
  }, [engines])

  useEffect(() => {
    if (activeSection !== 'engines' || focusTarget !== 'execution-engine') return
    const timer = window.setTimeout(() => {
      document.getElementById('settings-default-execution-engine')?.scrollIntoView({ block: 'center' })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [activeSection, focusTarget])

  useEffect(() => {
    if (!preferredProviderId) { setPreferredProviderProtocol(''); return }
    providerApi.list().then((result) => {
      setPreferredProviderProtocol(
        result.providers.find((provider) => provider.id === preferredProviderId)?.protocol || '',
      )
    }).catch(() => setPreferredProviderProtocol(''))
  }, [preferredProviderId])

  useEffect(() => {
    setUserNameDraft(userName)
  }, [userName])

  const handleSaveUserName = async () => {
    if (!await saveUserName(userNameDraft)) return
    setUserNameDraft(userNameDraft.trim())
    setUserNameSaved(true)
  }

  const handleFontSizeChange = (value: FontSizePreference) => {
    setFontSize(value)
    saveFontSizePreference(value)
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
        default_model: defaultModels[engineId] || '',
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
      setDefaultModels((current) => ({
        ...Object.fromEntries(result.engines.map((engine) => [engine.id, engine.default_model || ''])),
        ...current,
      }))
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



  const testEngine = async (engineId: string) => {
    setTestingEngine(engineId)
    setTestResults((current) => {
      const next = { ...current }
      delete next[engineId]
      return next
    })
    try {
      const testInput = engineFormRefs.current[engineId]?.getTestInput()
      const selectedModel = (
        customModelMode[engineId]
          ? customModelDrafts[engineId]
          : defaultModels[engineId]
      ) || ''
      const result = await engineApi.test(engineId, testInput, selectedModel)
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
    const isExpanded = expandedConfigs[engineId] === true
    if (!isExpanded) void loadEngineModels(engineId, false)
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

  const sortedEngines = useMemo(
    () => sortExecutionEngines(engines),
    [engines],
  )
  const installedCount = sortedEngines.filter((engine) => engine.installed).length
  const versionSummary = (version: string | null) =>
    version?.split(/\r?\n/, 1)[0]?.trim() || ''

  return (
    <div
      ref={settingsDialogRef}
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t('nav.settings')}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      style={{ padding: 24 }}
    >
      <ResizablePanel
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
      <SettingsNavigation activeSection={activeSection} onSelect={setActiveSection} />

      <section className="settings-content" style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', padding: '24px 28px 40px' }}>
        {activeSection === 'engines' ? (
        <div className="engine-settings-page" style={{ maxWidth: 960, margin: '0 auto' }}>
          <div className="engine-settings-header" style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 18 }}>
            <div style={{ flex: 1 }}>
              <h1 style={{ fontSize: 'calc(20px * var(--font-scale))', fontWeight: 650, marginBottom: 6 }}>{t('settings.enginesTitle')}</h1>
              <p style={{ color: 'var(--muted)', fontSize: 'calc(13px * var(--font-scale))' }}>
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

          <ExecutionDefaultSettings engines={sortedEngines} loading={loading} onChanged={onConfigurationChanged} />          <div className="engine-settings-section-heading" style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 8,
          }}>
            <span style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600 }}>
              {t('settings.enginesConfig')}
              {!loading && <span style={{ marginLeft: 6, color: 'var(--meta)', fontWeight: 400 }}>({installedCount}/{sortedEngines.length})</span>}
            </span>
            <span style={{ fontSize: 'calc(11px * var(--font-scale))', color: 'var(--meta)' }}>
              {t('settings.configFormHint')}
            </span>
          </div>

          {error && (
            <div role="alert" style={{
              padding: '10px 12px', marginBottom: 12, borderRadius: 8,
              background: 'color-mix(in oklab, var(--danger), transparent 90%)',
              color: 'var(--danger)', fontSize: 'calc(13px * var(--font-scale))',
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
                const isTesting = testingEngine === engine.id
                const engineModels = models[engine.id] || []
                const savedDefaultModel = defaultModels[engine.id] || ''
                const usesCustomModel = Boolean(
                  customModelMode[engine.id]
                  || (
                    models[engine.id] !== undefined
                    && savedDefaultModel
                    && !engineModels.some((model) => model.id === savedDefaultModel)
                  )
                )
                const modelSelectRow = (
                  <>
                    <span
                      style={{
                        flexShrink: 0, fontSize: 'calc(11px * var(--font-scale))', fontWeight: 600,
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
                      onChange={(event) => selectDefaultModel(engine.id, event.target.value)}
                      style={{
                        flex: '0 1 auto', minWidth: 0, maxWidth: 240, width: 'auto', height: 28,
                      }}
                    >
                      <option value="">
                        {modelsLoading[engine.id] ? t('settings.readingModels') : t('settings.followEngineDefault')}
                      </option>
                      {savedDefaultModel && !engineModels.some((model) => model.id === savedDefaultModel) && !usesCustomModel && (
                        <option value={savedDefaultModel}>{savedDefaultModel}</option>
                      )}
                      {engineModels.map((model) => (
                        <option key={model.id} value={model.id}>{model.label}</option>
                      ))}
                      <option value="__custom__">{t('settings.customModelOption')}</option>
                    </Select>
                    {savingModel === engine.id && (
                      <span style={{ flexShrink: 0, color: 'var(--meta)', fontSize: 'calc(11px * var(--font-scale))' }}>
                        {t('settings.saving')}
                      </span>
                    )}
                    {usesCustomModel && (
                      <>
                        <span
                          style={{
                            flexShrink: 0, fontSize: 'calc(11px * var(--font-scale))',
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
                        style={{ flexShrink: 0, height: 24, padding: '0 8px', fontSize: 'calc(11px * var(--font-scale))' }}
                        onClick={() => void loadEngineModels(engine.id, true)}
                      >
                        {t('settings.refresh')}
                      </Button>
                    )}
                  </>
                )
                const isExpanded = expandedConfigs[engine.id] === true
                const onboardingCompatible = Boolean(
                  focusTarget === 'execution-engine'
                  && preferredProviderProtocol
                  && engine.supports_provider
                  && engine.provider_protocols.includes(preferredProviderProtocol),
                )
                return (
                <div
                  key={engine.id}
                  data-engine-id={engine.id}
                  data-installed={engine.installed}
                  data-onboarding-compatible={onboardingCompatible || undefined}
                  style={{
                    borderRadius: 12,
                    border: `1px solid ${onboardingCompatible ? 'var(--accent)' : engine.installed ? 'var(--border)' : 'var(--border-soft)'}`,
                    background: 'var(--bg)',
                    opacity: engine.installed || engine.runtime_manageable ? 1 : 0.62,
                  }}
                >
                  <div className="engine-settings-card-row" style={{
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
                    className="engine-settings-card-summary"
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
                      <span style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600 }}>{engineLabel(engine.id, t)}</span>
                      {onboardingCompatible && (
                        <span style={{ padding: '1px 6px', borderRadius: 999, background: 'var(--accent-light)', color: 'var(--accent)', fontSize: 'calc(11px * var(--font-scale))' }}>
                          {t('onboarding.compatibleEngine')}
                        </span>
                      )}
                      {engine.mode && (
                        <span style={{
                          padding: '1px 6px', borderRadius: 999,
                          background: 'var(--surface)', color: 'var(--muted)',
                          fontSize: 'calc(11px * var(--font-scale))', textTransform: 'uppercase',
                        }}>
                          {engine.mode}
                        </span>
                      )}
                    </div>
                    <div style={{ color: 'var(--muted)', fontSize: 'calc(11px * var(--font-scale))', overflowWrap: 'anywhere' }}>
                      {engineDescription(engine.id, t)}
                      {engine.version && <span> · {versionSummary(engine.version)}</span>}
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
                        {testResult.duration_ms > 0 && ` · ${testResult.duration_ms}ms`}
                      </div>
                    )}

                  </div>
                  <div className="engine-settings-card-actions">
                  {engine.runtime_manageable && (
                    <EngineRuntimeControl engineId={engine.id} onChanged={() => loadEngines(true)} />
                  )}
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
                    borderRadius: 999, fontSize: 'calc(11px * var(--font-scale))', fontWeight: 600,
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
                  </div>
                  <div style={{ display: isExpanded ? undefined : 'none' }}>
                  {engine.config && (
                    <EngineConfigForm
                      ref={(el) => { engineFormRefs.current[engine.id] = el }}
                      engineId={engine.id}
                      config={engine.config}
                      modelOptions={engineModels}
                      modelOptionsLoading={Boolean(modelsLoading[engine.id])}
                      modelOptionsError={modelErrors[engine.id] || ''}
                      onRefreshModelOptions={() => void loadEngineModels(engine.id, true)}
                      footerSlot={engine.installed ? (
                        <>
                          {modelSelectRow}
                          {engine.id !== 'pydantic_ai' && (
                            <Button
                              variant="ghost"
                              style={{ flexShrink: 0, height: 24, padding: '0 8px', fontSize: 'calc(11px * var(--font-scale))' }}
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
                        onConfigurationChanged?.()
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
                              style={{ flexShrink: 0, height: 24, padding: '0 8px', fontSize: 'calc(11px * var(--font-scale))' }}
                              onClick={() => openPathEditor(engine)}
                            >
                              {t('settings.editPath')}
                            </Button>
                          )}
                        </div>
                      )}
                      {modelErrors[engine.id] && (
                        <div style={{
                          marginTop: 4, color: 'var(--meta)', fontSize: 'calc(11px * var(--font-scale))',
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
                        style={{ height: 28, padding: '0 10px', fontSize: 'calc(12px * var(--font-scale))' }}
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
                      <div style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600, marginBottom: 7 }}>
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
                        marginTop: 6, fontSize: 'calc(11px * var(--font-scale))',
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
            autoCreate={focusTarget === 'provider-create'}
            onChanged={() => {
              clearEngineModelCache('pydantic_ai')
              void loadEngines(false)
              onConfigurationChanged?.()
            }}
          />
        ) : activeSection === 'pricing' ? (
          <ModelPricingSettings />
        ) : activeSection === 'templates' ? (
          <TemplateSettings />
        ) : activeSection === 'channels' ? (
          <ChannelsPage />
        ) : activeSection === 'remote' ? (
          <RemoteProjectSettings />
        ) : activeSection === 'concurrency' ? (
          <GlobalConcurrencySettings />
        ) : activeSection === 'git' ? (
          <GitScanSettings />
        ) : activeSection === 'system' ? (
          <div style={{ maxWidth: 640, margin: '0 auto' }}>
            <h1 style={{ fontSize: 'calc(20px * var(--font-scale))', fontWeight: 650, marginBottom: 6 }}>{t('settings.systemTitle')}</h1>
            <p style={{ color: 'var(--muted)', fontSize: 'calc(13px * var(--font-scale))', marginBottom: 22 }}>
              {t('settings.systemIntro')}
            </p>
            <div style={{ paddingBottom: 22, marginBottom: 22, borderBottom: '1px solid var(--border-soft)' }}>
              <h2 style={{ fontSize: 'calc(14px * var(--font-scale))', fontWeight: 650, marginBottom: 5 }}>{t('settings.userName')}</h2>
              <p style={{ color: 'var(--muted)', fontSize: 'calc(12px * var(--font-scale))', marginBottom: 10 }}>
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
                <div role="status" style={{ marginTop: 7, color: 'var(--success)', fontSize: 'calc(11px * var(--font-scale))' }}>
                  {t('settings.userNameSaved')}
                </div>
              )}
              {userSettingsError && (
                <div role="status" style={{ marginTop: 7, color: 'var(--danger)', fontSize: 'calc(11px * var(--font-scale))' }}>
                  {userSettingsError}
                </div>
              )}
            </div>
            <ProjectDirectorySetting />
            <div style={{ paddingBottom: 22, marginBottom: 22, borderBottom: '1px solid var(--border-soft)' }}>
              <h2 style={{ fontSize: 'calc(14px * var(--font-scale))', fontWeight: 650, marginBottom: 5 }}>{t('settings.openMode')}</h2>
              <button
                type="button"
                className="settings-switch"
                role="switch"
                aria-checked={openMode}
                aria-label={t('settings.openMode')}
                disabled={userSettingsLoading}
                onClick={() => void saveOpenMode(!openMode)}
                style={{ background: openMode ? 'var(--accent)' : 'var(--border)' }}
              >
                <span className="settings-switch-thumb" />
              </button>
            </div>
            <div style={{ paddingBottom: 22, marginBottom: 22, borderBottom: '1px solid var(--border-soft)' }}>
              <h2 style={{ fontSize: 'calc(14px * var(--font-scale))', fontWeight: 650, marginBottom: 5 }}>{t('settings.fontSize')}</h2>
              <p style={{ color: 'var(--muted)', fontSize: 'calc(12px * var(--font-scale))', marginBottom: 12 }}>
                {t('settings.fontSizeIntro')}
              </p>
              <SegmentedControl
                ariaLabel={t('settings.fontSize')}
                value={fontSize}
                onChange={handleFontSizeChange}
                options={[
                  { value: 'small', label: t('settings.fontSizeSmall') },
                  { value: 'standard', label: t('settings.fontSizeStandard') },
                  { value: 'large', label: t('settings.fontSizeLarge') },
                  { value: 'extraLarge', label: t('settings.fontSizeExtraLarge') },
                ]}
                style={{ maxWidth: 360 }}
              />
            </div>
            <div style={{ paddingBottom: 22, marginBottom: 22, borderBottom: '1px solid var(--border-soft)' }}>
              <h2 style={{ fontSize: 'calc(14px * var(--font-scale))', fontWeight: 650, marginBottom: 5 }}>{t('settings.onboardingTitle')}</h2>
              <p style={{ color: 'var(--muted)', fontSize: 'calc(12px * var(--font-scale))', marginBottom: 12 }}>
                {t('settings.onboardingIntro')}
              </p>
              <Button
                variant="ghost"
                onClick={() => {
                  useOnboardingStore.getState().reopen()
                  onClose()
                }}
              >
                <Icon name="sparkles" size={16} strokeWidth={2} />
                {t('onboarding.reopen')}
              </Button>
            </div>
            <h2 style={{ fontSize: 'calc(14px * var(--font-scale))', fontWeight: 650, marginBottom: 5 }}>{t('nav.language')}</h2>
            <p style={{ color: 'var(--muted)', fontSize: 'calc(12px * var(--font-scale))', marginBottom: 12 }}>
              {t('settings.languageIntro')}
            </p>
            <SegmentedControl
              ariaLabel={t('nav.language')}
              value={locale}
              onChange={setLocale}
              options={[
                { value: 'zh-CN', label: '简体中文' },
                { value: 'zh-TW', label: '繁體中文' },
                { value: 'en-US', label: 'English' },
                { value: 'ja-JP', label: '日本語' },
              ]}
              style={{ maxWidth: 320 }}
            />
          </div>
        ) : (
          <AgentAssistantSettings />
        )}
      </section>

      </div>
      </ResizablePanel>
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
          <ResizablePanel
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
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--meta)', fontSize: 'calc(13px * var(--font-scale))' }}>
                  {t('settings.inspectLoading')}
                </div>
              ) : inspectError ? (
                <div role="status" style={{ color: 'var(--danger)', fontSize: 'calc(13px * var(--font-scale))', overflowWrap: 'anywhere' }}>
                  × {inspectError}
                </div>
              ) : inspectResult ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <div style={{ fontSize: 'calc(12px * var(--font-scale))', color: 'var(--meta)', overflowWrap: 'anywhere' }}>
                    {inspectResult.project_root
                      ? t('settings.inspectProject', { path: inspectResult.project_root })
                      : t('settings.inspectProjectNone')}
                  </div>
                  <div>
                    <div style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600, marginBottom: 7 }}>
                      {t('settings.inspectSkills')}
                      <span style={{ color: 'var(--meta)', fontWeight: 400 }}>
                        {' '}· {inspectResult.skills.length}
                      </span>
                    </div>
                    {inspectResult.skills.length === 0 ? (
                      <div style={{ color: 'var(--muted)', fontSize: 'calc(12px * var(--font-scale))' }}>
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
                            <div style={{ fontSize: 'calc(12px * var(--font-scale))', fontWeight: 600 }}>{skill.name}</div>
                            {skill.description && (
                              <div style={{ fontSize: 'calc(12px * var(--font-scale))', color: 'var(--muted)', marginTop: 2 }}>
                                {skill.description}
                              </div>
                            )}
                            <div style={{ fontSize: 'calc(11px * var(--font-scale))', color: 'var(--meta)', marginTop: 4, overflowWrap: 'anywhere' }}>
                              {skill.source_dir}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div>
                    <div style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600, marginBottom: 7 }}>
                      {t('settings.inspectMcp')}
                      <span style={{ color: 'var(--meta)', fontWeight: 400 }}>
                        {' '}· {inspectResult.mcp_servers.length}
                      </span>
                    </div>
                    {inspectResult.mcp_supported ? (
                      <div style={{ fontSize: 'calc(12px * var(--font-scale))', color: 'var(--success)', marginBottom: 6 }}>
                        ✓ {t('settings.inspectMcpSupported')}
                      </div>
                    ) : (
                      <div style={{ fontSize: 'calc(12px * var(--font-scale))', color: 'var(--warn)', marginBottom: 6, overflowWrap: 'anywhere' }}>
                        {inspectResult.mcp_error || t('settings.inspectMcpUnsupported')}
                      </div>
                    )}
                    {inspectResult.mcp_servers.length === 0 ? (
                      <div style={{ color: 'var(--muted)', fontSize: 'calc(12px * var(--font-scale))' }}>
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
                            <div style={{ fontSize: 'calc(12px * var(--font-scale))', fontWeight: 600 }}>{server.name}</div>
                            <div style={{ fontSize: 'calc(11px * var(--font-scale))', color: 'var(--muted)', marginTop: 2, overflowWrap: 'anywhere' }}>
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
          </ResizablePanel>
        </div>
      )}
      </div>
  )
}

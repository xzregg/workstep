import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import EngineCapabilitiesDialog from './EngineCapabilitiesDialog'
import Button from './Button'
import Input from './Input'
import Select from './Select'
import Icon from './Icon'
import EngineConfigForm, { type EngineConfigFormHandle } from './EngineConfigForm'
import ExecutionDefaultSettings from './ExecutionDefaultSettings'
import CustomEngineOnboardingButton from './CustomEngineOnboardingButton'
import CustomEngineControls from './CustomEngineControls'
import EngineRuntimeControl from './EngineRuntimeControl'
import { engineApi, fetchEngineModels, invalidateEngineModels, type EngineInfo, type EngineModel, type EngineTestResult } from '../api/client'
import { ENGINE_COLORS, engineLabel, engineDescription, sortExecutionEngines } from '../engineMeta'
import { useI18n } from '../i18n'
import { publishEngineCatalog } from '../stores/engineAvailabilityStore'
import './EngineSettingsPanel.css'

function EngineIcon({ engine }: { engine: EngineInfo }) {
  const color = ENGINE_COLORS[engine.id] || 'var(--muted)'
  const initials = engine.id === 'claude'
    ? 'C'
    : engine.id === 'codex'
      ? '⌘'
      : engine.id.slice(0, 2).toUpperCase()
  return (
    <span className="engine-settings-icon" style={{ '--engine-color': color } as CSSProperties}>
      {initials}
    </span>
  )
}

interface Props {
  hidden: boolean
  refreshRevision: number
  preferredProviderProtocol: string
  focusTarget?: 'provider-create' | 'execution-engine'
  onConfigurationChanged?: () => void
  onConversationStarted?: () => void
}

export default function EngineSettingsPanel({ hidden, refreshRevision, preferredProviderProtocol, focusTarget, onConfigurationChanged, onConversationStarted }: Props) {
  const { t } = useI18n()
  const initialized = useRef(false)
  const [engines, setEngines] = useState<EngineInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [visibilitySaving, setVisibilitySaving] = useState<string | null>(null)
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
  const [inspectEngineId, setInspectEngineId] = useState<string | null>(null)
  // 引擎的安装 / 配置 / 测试状态每次变化都同步给共享可用性，聊天框和步骤引擎下拉
  // 才能立即跟随禁用状态（设置弹框是浮层，不会卸载底下的聊天页）。
  useEffect(() => {
    if (engines.length > 0) publishEngineCatalog(engines)
  }, [engines])

  // 表单内供应商草稿（未保存也实时跟随）：有草稿用草稿，否则用已保存配置。
  const [providerDrafts, setProviderDrafts] = useState<Record<string, string>>({})
  // 模型列表数据源自动跟随引擎的供应商选择：
  // 选了供应商就读该供应商缓存的模型列表，没选则走引擎原生 list_models。
  const resolveEngineProvider = (engineId: string): string => {
    const draft = providerDrafts[engineId]
    if (typeof draft === 'string') return draft
    const engine = engines.find((item) => item.id === engineId)
    const values = engine?.config?.values as Record<string, string> | undefined
    const providerId = values?.provider_id ?? ''
    return typeof providerId === 'string' ? providerId : ''
  }

  // 表单内切换供应商时只记草稿（不保存也不请求）；
  // 点模型行右侧刷新按钮才按当前供应商拉列表。
  const handleEngineValuesChange = (engineId: string, values: Record<string, string>) => {
    const next = typeof values.provider_id === 'string' ? values.provider_id : ''
    setProviderDrafts((current) => {
      if (current[engineId] === next) return current
      return { ...current, [engineId]: next }
    })
  }

  const loadEngineModels = async (engineId: string, force = false, providerId?: string) => {
    if ((models[engineId] || modelsLoading[engineId]) && !force) return
    setModelsLoading((current) => ({ ...current, [engineId]: true }))
    const effectiveProvider = providerId ?? resolveEngineProvider(engineId)
    let result
    try {
      result = await fetchEngineModels(engineId, force, effectiveProvider)
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

  const setVisibility = async (engineId: string, enabled: boolean) => {
    setVisibilitySaving(engineId)
    setError('')
    try {
      const result = await engineApi.setVisibility(engineId, enabled)
      setEngines(result.engines)
      publishEngineCatalog(result.engines)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('settings.saveFailed'))
    } finally {
      setVisibilitySaving(null)
    }
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
        ...current,
        ...Object.fromEntries(result.engines.map((engine) => [engine.id, engine.default_model || ''])),
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

  const previousRefreshRevision = useRef(refreshRevision)
  useEffect(() => {
    if (previousRefreshRevision.current === refreshRevision) return
    previousRefreshRevision.current = refreshRevision
    clearEngineModelCache('pydantic_ai')
    void loadEngines(false)
  }, [refreshRevision])

  return (
    <>
        <div className="engine-settings-page" hidden={hidden}>
          <div className="engine-settings-header">
            <div className="engine-settings-header-copy">
              <h1 className="engine-settings-title">{t('settings.enginesTitle')}</h1>
              <p className="engine-settings-intro">
                {t('settings.enginesIntro')}
              </p>
            </div>
            <CustomEngineOnboardingButton onStarted={onConversationStarted} />
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

          <ExecutionDefaultSettings engines={sortedEngines} loading={loading} onChanged={onConfigurationChanged} />
          <div className="engine-settings-section-heading">
            <span className="engine-settings-section-title">
              {t('settings.enginesConfig')}
              {!loading && <span className="engine-settings-count">({installedCount}/{sortedEngines.length})</span>}
            </span>
            <span className="engine-settings-section-hint">
              {t('settings.configFormHint')}
            </span>
          </div>

          {error && (
            <div role="alert" className="engine-settings-error">
              {t('settings.scanFailed', { error })}
            </div>
          )}

          {loading && engines.length === 0 ? (
            <div className="engine-settings-loading">
              {t('settings.readingEngines')}
            </div>
          ) : (
            <div className="engine-settings-list">
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
                    <span className="engine-settings-model-label">
                      {t('chatInput.model')}
                    </span>
                    <Select
                      id={`default-model-${engine.id}`}
                      aria-label={t('settings.defaultModelAria', { name: engineLabel(engine.id, t) })}
                      title={t('settings.defaultModelTitle')}
                      value={usesCustomModel ? '__custom__' : savedDefaultModel}
                      disabled={Boolean(modelsLoading[engine.id]) || savingModel === engine.id}
                      onChange={(event) => selectDefaultModel(engine.id, event.target.value)}
                      className="engine-settings-model-select"
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
                      <span className="engine-settings-saving">
                        {t('settings.saving')}
                      </span>
                    )}
                    {usesCustomModel && (
                      <>
                        <span className="engine-settings-model-label engine-settings-custom-label">
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
                          className="engine-settings-custom-input"
                        />
                      </>
                    )}
                    {!modelsLoading[engine.id] && (
                      <Button
                        variant="ghost"
                        className="engine-settings-small-action"
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
                  className="engine-settings-card"
                  data-engine-id={engine.id}
                  data-installed={engine.installed}
                  data-available={engine.installed || engine.runtime_manageable}
                  data-onboarding-compatible={onboardingCompatible || undefined}
                >
                  <div className="engine-settings-card-row">
                  <Button
                    variant="ghost"
                    aria-label={isExpanded ? t('settings.collapseConfig') : t('settings.expandConfig')}
                    title={isExpanded ? t('settings.collapseConfig') : t('settings.expandConfig')}
                    onClick={() => toggleConfig(engine.id)}
                    className="engine-settings-expand-button"
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
                  >
                    <div className="engine-settings-card-name-row">
                      <span className="engine-settings-card-name">{engine.name || engineLabel(engine.id, t)}</span>
                      {onboardingCompatible && (
                        <span className="engine-settings-compatible-badge">
                          {t('onboarding.compatibleEngine')}
                        </span>
                      )}
                      {engine.mode && (
                        <span className="engine-settings-mode-badge">
                          {engine.mode}
                        </span>
                      )}
                    </div>
                    <div className="engine-settings-card-description">
                      {engine.description || engineDescription(engine.id, t)}
                      {engine.version && <span> · {versionSummary(engine.version)}</span>}
                    </div>
                    {testResult && (
                      <div role="status" className="engine-settings-test-result" data-success={testResult.success}>
                        {testResult.success ? '✓' : '×'} {testResult.message}
                        {testResult.duration_ms > 0 && ` · ${testResult.duration_ms}ms`}
                      </div>
                    )}

                  </div>
                  <div className="engine-settings-card-actions">
                  {engine.custom && <CustomEngineControls engine={engine} onChanged={() => loadEngines(true)} />}
                  {engine.runtime_manageable && (
                    <EngineRuntimeControl engineId={engine.id} onChanged={() => loadEngines(true)} />
                  )}
                  {engine.installed && (
                    <Button
                      variant="ghost"
                      className="engine-settings-test-button"
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
                      className="engine-settings-test-button"
                      disabled={inspectEngineId !== null}
                      onClick={() => setInspectEngineId(engine.id)}
                    >
                      {t('settings.viewCapabilities')}
                    </Button>
                  )}


                  <div className="engine-settings-visibility" title={t('engine.visibilityHint')}>
                    <button type="button" className="settings-switch" role="switch"
                      aria-label={`${engine.name || engineLabel(engine.id, t)} · ${t(engine.enabled !== false ? 'engine.visibilityOn' : 'engine.visibilityOff')}`}
                      aria-checked={engine.enabled !== false}
                      disabled={visibilitySaving !== null}
                      onClick={() => void setVisibility(engine.id, engine.enabled === false)}>
                      <span className="settings-switch-thumb" />
                    </button>
                    <span>{t(engine.enabled !== false ? 'engine.visibilityOn' : 'engine.visibilityOff')}</span>
                    {visibilitySaving === engine.id && <Icon name="loader-circle" className="engine-settings-visibility-spinner" />}
                  </div>
                  <span className="engine-settings-status" data-state={engine.verified ? 'verified' : engine.installed ? 'needs-test' : 'not-installed'}>
                    {engine.verified ? t('settings.verified') : engine.installed ? t('engine.needsTest') : t('engine.notInstalled')}
                  </span>
                  {engine.config && (
                    <Button
                      variant="primary"
                      className="engine-settings-save-button"
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
                  <div className="engine-settings-card-details" hidden={!isExpanded}>
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
                              className="engine-settings-small-action"
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
                      onValuesChange={(values) => handleEngineValuesChange(engine.id, values)}
                      onSaved={(result) => {
                        const savedEngine = result.engine as EngineInfo | undefined
                        if (savedEngine) {
                          setEngines((current) => current.map((item) =>
                            item.id === engine.id ? savedEngine : item
                          ))
                        }
                        clearEngineModelCache(engine.id)
                        const savedValues = savedEngine?.config?.values as Record<string, string> | undefined
                        const savedProvider = typeof savedValues?.provider_id === 'string' ? savedValues.provider_id : undefined
                        setProviderDrafts((current) => {
                          if (savedProvider === undefined) return current
                          if (current[engine.id] === savedProvider) return current
                          return { ...current, [engine.id]: savedProvider }
                        })
                        void loadEngineModels(engine.id, true, savedProvider)
                        onConfigurationChanged?.()
                      }}
                    />
                  )}
                  {engine.installed && (!engine.config || modelErrors[engine.id]) && (
                    <div className="engine-settings-model-footer">
                      {!engine.config && (
                        <div className="engine-settings-model-row">
                          {modelSelectRow}
                          {engine.id !== 'pydantic_ai' && (
                            <Button
                              variant="ghost"
                              className="engine-settings-small-action"
                              onClick={() => openPathEditor(engine)}
                            >
                              {t('settings.editPath')}
                            </Button>
                          )}
                        </div>
                      )}
                      {modelErrors[engine.id] && (
                        <div className="engine-settings-model-error">
                          {t('settings.modelErrorHint2', { error: modelErrors[engine.id] })}
                        </div>
                      )}
                    </div>
                  )}
                  {!engine.installed && engine.id !== 'pydantic_ai' && (
                    <div className="engine-settings-model-footer engine-settings-footer-rounded">
                      <Button
                        variant="ghost"
                        className="engine-settings-path-button"
                        onClick={() => openPathEditor(engine)}
                      >
                        {t('settings.editPath')}
                      </Button>
                    </div>
                  )}
                  {editingEngine === engine.id && (
                    <div className="engine-settings-path-editor">
                      <div className="engine-settings-path-title">
                        {t('settings.binaryPath')}
                      </div>
                      <div className="engine-settings-path-row">
                        <Input
                          value={pathDraft}
                          onChange={(event) => setPathDraft(event.target.value)}
                          placeholder={t('settings.binaryPathPlaceholder')}
                          autoFocus
                          className="engine-settings-path-input"
                          aria-invalid={Boolean(pathError)}
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
                      <div className="engine-settings-path-hint" data-error={Boolean(pathError)}>
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
      {inspectEngineId && (
        <EngineCapabilitiesDialog engineId={inspectEngineId} onClose={() => setInspectEngineId(null)} />
      )}
    </>
  )
}

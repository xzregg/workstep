import { useEffect, useMemo, useRef, useState } from 'react'
import EngineCapabilitiesDialog from './EngineCapabilitiesDialog'
import Button from './Button'
import Input from './Input'
import Select from './Select'
import Icon from './Icon'
import EngineConfigForm, { type EngineConfigFormHandle } from './EngineConfigForm'
import ExecutionDefaultSettings from './ExecutionDefaultSettings'
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

interface Props {
  hidden: boolean
  refreshRevision: number
  preferredProviderProtocol: string
  focusTarget?: 'provider-create' | 'execution-engine'
  onConfigurationChanged?: () => void
}

export default function EngineSettingsPanel({ hidden, refreshRevision, preferredProviderProtocol, focusTarget, onConfigurationChanged }: Props) {
  const { t } = useI18n()
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
  const [inspectEngineId, setInspectEngineId] = useState<string | null>(null)
  // 引擎的安装 / 配置 / 测试状态每次变化都同步给共享可用性，聊天框和步骤引擎下拉
  // 才能立即跟随禁用状态（设置弹框是浮层，不会卸载底下的聊天页）。
  useEffect(() => {
    if (engines.length > 0) publishEngineCatalog(engines)
  }, [engines])

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

          <ExecutionDefaultSettings engines={sortedEngines} loading={loading} onChanged={onConfigurationChanged} />
          <div className="engine-settings-section-heading" style={{
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
                      disabled={inspectEngineId !== null}
                      onClick={() => setInspectEngineId(engine.id)}
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
      {inspectEngineId && (
        <EngineCapabilitiesDialog engineId={inspectEngineId} onClose={() => setInspectEngineId(null)} />
      )}
    </>
  )
}

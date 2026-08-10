import Icon from '../components/Icon'
import { useEffect, useMemo, useRef, useState } from 'react'
import Button from '../components/Button'
import Input from '../components/Input'
import Select from '../components/Select'
import {
  engineApi,
  fetchEngineModels,
  getCachedEngineModels,
  invalidateEngineModels,
  type EngineInfo,
  type EngineModel,
  type EngineTestResult,
} from '../api/client'
import EngineConfigForm from '../components/EngineConfigForm'
import EngineSelect from '../components/EngineSelect'
import TemplateSettings from './TemplateSettings'
import {
  ENGINE_COLORS,
  engineLabel,
  engineDescription,
} from '../engineMeta'
import { useI18n } from '../i18n'


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

  const loadExecutionConfig = async () => {
    setLoadingConfig(true)
    setError('')
    setNotice('')
    try {
      const config = await engineApi.executionConfig()
      setEngine(config.engine)
      setNotice(t('settings.readDefaultSuccess'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('settings.readDefaultFailed'))
    } finally {
      setLoadingConfig(false)
    }
  }

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
        <Button
          variant="ghost"
          style={{ height: 30 }}
          disabled={loadingConfig || saving}
          loading={loadingConfig}
          onClick={() => void loadExecutionConfig()}
        >
          {t('settings.readDefault')}
        </Button>
        <Button variant="primary" style={{ height: 30 }} disabled={saving || loading} loading={saving} onClick={() => void save()}>
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

function CoordinatorAgentSettings() {
  const { t } = useI18n()
  const [engines, setEngines] = useState<EngineInfo[]>([])
  const [engine, setEngine] = useState('')
  const [model, setModel] = useState('')
  const [fastModel, setFastModel] = useState('')
  const [visionModel, setVisionModel] = useState('')
  const [models, setModels] = useState<EngineModel[]>([])
  const [loading, setLoading] = useState(true)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const initialized = useRef(false)
  const engineRef = useRef('')
  const [error, setError] = useState('')
  const [modelError, setModelError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    engineApi.coordinatorDefaults()
      .then((config) => {
        setEngines(config.available_engines as EngineInfo[])
        setEngine(config.engine)
        setModel(config.model)
        setFastModel(config.fast_model)
        setVisionModel(config.vision_model)
        setError('')
      })
      .catch((reason) => setError(
        reason instanceof Error ? reason.message : t('settings.readCoordinatorFailed')
      ))
      .finally(() => setLoading(false))
  }, [])

  engineRef.current = engine

  const loadCoordinatorModels = async (engineId: string, force: boolean) => {
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
      const result = await fetchEngineModels(engineId, force)
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
    void loadCoordinatorModels(engine, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine])

  const changeEngine = (engineId: string) => {
    setEngine(engineId)
    setModel('')
    setFastModel('')
    setVisionModel('')
    setNotice('')
  }

  const save = async () => {
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const result = await engineApi.setCoordinatorDefaults(engine, model, fastModel, visionModel)
      setEngine(result.engine)
      setModel(result.model)
      setFastModel(result.fast_model)
      setVisionModel(result.vision_model)
      setNotice(t('settings.saveCoordinatorSuccess'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('settings.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 650, marginBottom: 6 }}>{t('settings.coordinatorTitle')}</h1>
        <p style={{ color: 'var(--muted)', fontSize: 13 }}>
          {t('settings.coordinatorIntro')}
        </p>
      </div>
      <div style={{ padding: 20, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <label style={{ flexShrink: 0, fontSize: 13, fontWeight: 600, width: 84 }}>
            {t('settings.coordinatorEngine')}
          </label>
          <EngineSelect
            engines={engines}
            value={engine}
            onChange={changeEngine}
            disabled={loading || saving}
            requireCoordinator
            defaultOption={{ value: '', label: t('settings.followTaskEngine') }}
            ariaLabel={t('settings.defaultCoordinatorAria')}
            style={{ flex: 1, minWidth: 0, height: 30 }}
          />
        </div>
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
              onClick={() => void loadCoordinatorModels(engine, true)}
            >
              {t('settings.refresh')}
            </Button>
          )}
        </div>
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
            {t('settings.saveCoordinator')}
          </Button>
        </div>
      </div>
    </div>
  )
}

interface SettingsPageProps {
  onClose: () => void
}

export default function SettingsPage({ onClose }: SettingsPageProps) {
  const { t, locale, setLocale } = useI18n()
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
  const [pathDraft, setPathDraft] = useState('')
  const [pathSaving, setPathSaving] = useState(false)
  const [pathError, setPathError] = useState('')
  const [activeSection, setActiveSection] = useState<'engines' | 'coordinator' | 'templates' | 'language'>('engines')

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

  // 模型列表自动加载一次并缓存：命中缓存不请求，只有「刷新」才强制调远程接口。
  useEffect(() => {
    if (loading || engines.length === 0) return
    for (const engine of engines) {
      if (engine.installed) void loadEngineModels(engine.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, engines])

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
    id === 'pydantic_ai' ? 0 : id === 'api' ? 1 : 2
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
          aria-current={activeSection === 'engines' ? 'page' : undefined}
          onClick={() => setActiveSection('engines')}
          style={{
            width: '100%', height: 38, padding: '0 11px',
            display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
            gap: 9, borderRadius: 8, background: activeSection === 'engines' ? 'var(--bg)' : 'transparent',
            color: activeSection === 'engines' ? 'var(--fg)' : 'var(--muted)', fontSize: 13, fontWeight: 600,
          }}
        >
          <Icon name="sliders-horizontal" size={16} strokeWidth={2} />
          {t('settings.enginesNav')}
        </button>
        <button
          aria-current={activeSection === 'coordinator' ? 'page' : undefined}
          onClick={() => setActiveSection('coordinator')}
          style={{
            width: '100%', height: 38, padding: '0 11px', marginTop: 5,
            display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
            gap: 9, borderRadius: 8, background: activeSection === 'coordinator' ? 'var(--bg)' : 'transparent',
            color: activeSection === 'coordinator' ? 'var(--fg)' : 'var(--muted)', fontSize: 13, fontWeight: 600,
          }}
        >
          <span aria-hidden="true" style={{ fontSize: 16 }}>✦</span>
          {t('settings.coordinatorNav')}
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
          aria-current={activeSection === 'language' ? 'page' : undefined}
          onClick={() => setActiveSection('language')}
          style={{
            width: '100%', height: 38, padding: '0 11px', marginTop: 5,
            display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
            gap: 9, borderRadius: 8, background: activeSection === 'language' ? 'var(--bg)' : 'transparent',
            color: activeSection === 'language' ? 'var(--fg)' : 'var(--muted)', fontSize: 13, fontWeight: 600,
          }}
        >
          <span aria-hidden="true" style={{ fontSize: 15 }}>文</span>
          {t('nav.language')}
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
                const isTesting = testingEngine === engine.id
                const engineModels = models[engine.id] || []
                const savedDefaultModel = defaultModels[engine.id] || ''
                const usesCustomModel = Boolean(
                  customModelMode[engine.id]
                  || (
                    savedDefaultModel
                    && !engineModels.some((model) => model.id === savedDefaultModel)
                  )
                )
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
                    alignItems: 'center', gap: 12,
                  }}>
                  <EngineIcon engine={engine} />
                  <div style={{ flex: 1, minWidth: 0 }}>
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
                  {engine.id !== 'api' && engine.id !== 'pydantic_ai' && (
                    <Button
                      variant="ghost"
                      style={{ minWidth: 54, height: 30, justifyContent: 'center' }}
                      onClick={() => openPathEditor(engine)}
                    >
                      {t('common.edit')}
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
                  </div>
                  {engine.config && (
                    <EngineConfigForm
                      engineId={engine.id}
                      config={engine.config}
                      onSaved={(result) => {
                        if (result.engine) {
                          setEngines((current) => current.map((item) =>
                            item.id === engine.id ? result.engine as EngineInfo : item
                          ))
                        }
                        clearEngineModelCache(engine.id)
                        void loadEngineModels(engine.id)
                      }}
                    />
                  )}
                  {engine.installed && (
                    <div style={{
                      padding: '9px 14px',
                      borderTop: '1px solid var(--border-soft)',
                      background: 'var(--surface)',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
                          onChange={(event) => selectDefaultModel(engine.id, event.target.value)}
                          style={{
                            flex: 1, minWidth: 0, height: 28,
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
                        {models[engine.id] && !modelsLoading[engine.id] && (
                          <Button
                            variant="ghost"
                            style={{ flexShrink: 0, height: 24, padding: '0 8px', fontSize: 11 }}
                            onClick={() => void loadEngineModels(engine.id, true)}
                          >
                            {t('settings.refresh')}
                          </Button>
                        )}
                      </div>
                      {modelErrors[engine.id] && (
                        <div style={{
                          marginTop: 4, color: 'var(--meta)', fontSize: 11,
                        }}>
                          {t('settings.modelErrorHint2', { error: modelErrors[engine.id] })}
                        </div>
                      )}
                      {usesCustomModel && (
                        <div style={{
                          marginTop: 6, display: 'flex', alignItems: 'center', gap: 8,
                        }}>
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
                              flex: 1, minWidth: 0, height: 28,
                            }}
                          />
                        </div>
                      )}
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
                )
              })}
            </div>
          )}
        </div>
        ) : activeSection === 'templates' ? (
          <TemplateSettings />
        ) : activeSection === 'language' ? (
          <div style={{ maxWidth: 640, margin: '0 auto' }}>
            <h1 style={{ fontSize: 20, fontWeight: 650, marginBottom: 6 }}>{t('nav.language')}</h1>
            <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 16 }}>
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
          <CoordinatorAgentSettings />
        )}
      </section>
      </div>
      </div>
      </div>
  )
}

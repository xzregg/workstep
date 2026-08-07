import { useEffect, useMemo, useRef, useState } from 'react'
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
  ENGINE_DESCRIPTIONS,
  engineLabel,
} from '../engineMeta'


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
      setNotice('已读取当前默认执行引擎')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取默认执行引擎失败')
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
      setNotice('已保存；新任务和新阶段将使用该默认引擎')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ padding: 14, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg)', marginBottom: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 650, marginBottom: 4 }}>默认执行引擎</div>
      <div style={{ color: 'var(--muted)', fontSize: 11, marginBottom: 10 }}>
        用于新建任务和新建阶段；已有任务与阶段配置不会被修改。
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <EngineSelect
          engines={engines}
          value={engine}
          onChange={setEngine}
          disabled={loading || saving}
          defaultOption={{ value: '', label: '系统默认（Claude Code）' }}
          ariaLabel="默认执行引擎"
          style={{ width: 300, height: 30 }}
        />
        <button
          className="btn-ghost"
          style={{ height: 30 }}
          disabled={loadingConfig || saving}
          onClick={() => void loadExecutionConfig()}
        >
          {loadingConfig ? '读取中…' : '读取默认'}
        </button>
        <button className="btn-primary" style={{ height: 30 }} disabled={saving || loading} onClick={() => void save()}>
          {saving ? '保存中…' : '保存默认值'}
        </button>
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
        reason instanceof Error ? reason.message : '读取协调 Agent 设置失败'
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
      setModelError(reason instanceof Error ? reason.message : '读取模型失败')
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
      setNotice('已保存；未单独配置的任务将从下一条协调消息开始使用')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 22, fontWeight: 650, marginBottom: 6 }}>协调 Agent</h1>
        <p style={{ color: 'var(--muted)', fontSize: 13 }}>
          配置任务协调对话的全局默认引擎、推理模型、快速模型和图片理解模型。任务详情中的单独配置优先级更高。
        </p>
      </div>
      <div style={{ padding: 20, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <label style={{ flexShrink: 0, fontSize: 12, fontWeight: 600, width: 84 }}>
            协调引擎
          </label>
          <EngineSelect
            engines={engines}
            value={engine}
            onChange={changeEngine}
            disabled={loading || saving}
            requireCoordinator
            defaultOption={{ value: '', label: '跟随任务执行引擎' }}
            ariaLabel="默认协调引擎"
            style={{ flex: 1, minWidth: 0, height: 30 }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <label style={{ flexShrink: 0, fontSize: 12, fontWeight: 600, width: 84 }}>
            推理模型
          </label>
          <select
            value={model}
            disabled={!engine || modelsLoading || saving}
            onChange={(event) => setModel(event.target.value)}
            aria-label="默认推理模型"
            style={{
              flex: 1, minWidth: 0, height: 30,
              border: '1px solid var(--border)', borderRadius: 7,
              background: 'var(--bg)', color: 'var(--fg)', padding: '0 8px', fontSize: 12,
            }}
          >
            <option value="">
              {!engine ? '请先选择协调引擎' : modelsLoading ? '模型加载中…' : '使用引擎默认模型'}
            </option>
            {model && !models.some((item) => item.id === model) && (
              <option value={model}>{model}（当前配置）</option>
            )}
            {models.map((item) => (
              <option key={item.id} value={item.id}>{item.label || item.id}</option>
            ))}
          </select>
          {engine && (
            <button
              className="btn-ghost"
              style={{ flexShrink: 0, height: 28, padding: '0 8px', fontSize: 11 }}
              disabled={modelsLoading || saving}
              onClick={() => void loadCoordinatorModels(engine, true)}
            >
              ↻ 刷新
            </button>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <label style={{ flexShrink: 0, fontSize: 12, fontWeight: 600, width: 84 }}>
            快速模型
          </label>
          <select
            value={fastModel}
            disabled={!engine || modelsLoading || saving}
            onChange={(event) => setFastModel(event.target.value)}
            aria-label="默认快速模型"
            style={{
              flex: 1, minWidth: 0, height: 30,
              border: '1px solid var(--border)', borderRadius: 7,
              background: 'var(--bg)', color: 'var(--fg)', padding: '0 8px', fontSize: 12,
            }}
          >
            <option value="">
              {!engine ? '请先选择协调引擎' : modelsLoading ? '模型加载中…' : '跟随推理模型'}
            </option>
            {fastModel && !models.some((item) => item.id === fastModel) && (
              <option value={fastModel}>{fastModel}（当前配置）</option>
            )}
            {models.map((item) => (
              <option key={item.id} value={item.id}>{item.label || item.id}</option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <label style={{ flexShrink: 0, fontSize: 12, fontWeight: 600, width: 84 }}>
            图片理解模型
          </label>
          <select
            value={visionModel}
            disabled={!engine || modelsLoading || saving}
            onChange={(event) => setVisionModel(event.target.value)}
            aria-label="默认图片理解模型"
            style={{
              flex: 1, minWidth: 0, height: 30,
              border: '1px solid var(--border)', borderRadius: 7,
              background: 'var(--bg)', color: 'var(--fg)', padding: '0 8px', fontSize: 12,
            }}
          >
            <option value="">
              {!engine ? '请先选择协调引擎' : modelsLoading ? '模型加载中…' : '跟随推理模型'}
            </option>
            {visionModel && !models.some((item) => item.id === visionModel) && (
              <option value={visionModel}>{visionModel}（当前配置）</option>
            )}
            {models.map((item) => (
              <option key={item.id} value={item.id}>{item.label || item.id}</option>
            ))}
          </select>
        </div>
        <div style={{ marginBottom: 12, fontSize: 10, color: 'var(--meta)' }}>
          推理模型负责理解、决策与回复；快速模型负责读取产物和修复结构化输出；图片理解模型在主模型不支持图片输入时，用于分析图片和截图内容。
        </div>
        {modelError && (
          <div style={{ marginTop: 7, fontSize: 11, color: 'var(--warn)' }}>
            模型列表读取失败：{modelError}。仍可保存引擎默认模型。
          </div>
        )}
        <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div style={{ fontSize: 11, color: error ? 'var(--danger)' : notice ? 'var(--success)' : 'var(--meta)' }}>
            {error || notice || '当前进行中的协调回复不会中途切换引擎。'}
          </div>
          <button className="btn-primary" disabled={loading || saving} onClick={() => void save()}>
            {saving ? '保存中…' : '保存协调设置'}
          </button>
        </div>
      </div>
    </div>
  )
}

interface SettingsPageProps {
  onClose: () => void
}

export default function SettingsPage({ onClose }: SettingsPageProps) {
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
  const [activeSection, setActiveSection] = useState<'engines' | 'coordinator' | 'templates'>('engines')

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
        error: modelError instanceof Error ? modelError.message : '读取模型失败',
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
      setError(loadError instanceof Error ? loadError.message : '读取引擎失败')
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
          message: testError instanceof Error ? testError.message : '测试失败',
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
        setPathError(result.message || '保存失败')
        return
      }
      setEngines((current) => current.map((engine) =>
        engine.id === engineId ? result.engine as EngineInfo : engine
      ))
      setEditingEngine(null)
      clearEngineModelCache(engineId)
    } catch (saveError) {
      setPathError(saveError instanceof Error ? saveError.message : '保存失败')
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
      aria-label="设置"
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
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/>
              <path d="M1 14h6M9 8h6M17 16h6"/>
            </svg>
            <span className="modal-title">设置</span>
          </div>
          <button className="btn-icon" aria-label="关闭设置" onClick={onClose}>✕</button>
        </div>

      <div className="settings-layout" style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <aside className="settings-nav" style={{
        width: 184, flexShrink: 0, padding: '18px 12px',
        background: 'var(--surface)', borderRight: '1px solid var(--border-soft)',
      }}>
        <div style={{
          padding: '0 10px 8px', color: 'var(--meta)',
          fontSize: 10, fontWeight: 600, letterSpacing: '0.4px',
        }}>
          设置
        </div>
        <button
          aria-current={activeSection === 'engines' ? 'page' : undefined}
          onClick={() => setActiveSection('engines')}
          style={{
            width: '100%', height: 38, padding: '0 11px',
            display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
            gap: 9, borderRadius: 8, background: activeSection === 'engines' ? 'var(--bg)' : 'transparent',
            color: activeSection === 'engines' ? 'var(--fg)' : 'var(--muted)', fontSize: 12, fontWeight: 600,
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/>
            <path d="M1 14h6M9 8h6M17 16h6"/>
          </svg>
          执行引擎
        </button>
        <button
          aria-current={activeSection === 'coordinator' ? 'page' : undefined}
          onClick={() => setActiveSection('coordinator')}
          style={{
            width: '100%', height: 38, padding: '0 11px', marginTop: 5,
            display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
            gap: 9, borderRadius: 8, background: activeSection === 'coordinator' ? 'var(--bg)' : 'transparent',
            color: activeSection === 'coordinator' ? 'var(--fg)' : 'var(--muted)', fontSize: 12, fontWeight: 600,
          }}
        >
          <span aria-hidden="true" style={{ fontSize: 16 }}>✦</span>
          协调 Agent
        </button>
        <button
          aria-current={activeSection === 'templates' ? 'page' : undefined}
          onClick={() => setActiveSection('templates')}
          style={{
            width: '100%', height: 38, padding: '0 11px', marginTop: 5,
            display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
            gap: 9, borderRadius: 8, background: activeSection === 'templates' ? 'var(--bg)' : 'transparent',
            color: activeSection === 'templates' ? 'var(--fg)' : 'var(--muted)', fontSize: 12, fontWeight: 600,
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="7" height="7" rx="1"/>
            <rect x="14" y="3" width="7" height="7" rx="1"/>
            <rect x="3" y="14" width="7" height="7" rx="1"/>
            <rect x="14" y="14" width="7" height="7" rx="1"/>
          </svg>
          流程模板
        </button>
      </aside>

      <section className="settings-content" style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', padding: '24px 28px 40px' }}>
        {activeSection === 'engines' ? (
        <div style={{ maxWidth: 960, margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 18 }}>
            <div style={{ flex: 1 }}>
              <h1 style={{ fontSize: 22, fontWeight: 650, marginBottom: 6 }}>执行引擎</h1>
              <p style={{ color: 'var(--muted)', fontSize: 13 }}>
                配置 WorkStep 内置引擎，并扫描本机可用的 CLI 与 ACP 执行引擎。
              </p>
            </div>
            <button
              className="btn-ghost"
              onClick={() => void loadEngines(true)}
              disabled={loading}
            >
              <span aria-hidden="true">↻</span>
              {loading ? '扫描中…' : '重新扫描'}
            </button>
          </div>

          <ExecutionDefaultSettings engines={engines} loading={loading} />          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 8,
          }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>
              执行引擎配置
              {!loading && <span style={{ marginLeft: 6, color: 'var(--meta)', fontWeight: 400 }}>({installedCount}/{sortedEngines.length})</span>}
            </span>
            <span style={{ fontSize: 11, color: 'var(--meta)' }}>
              配置表单由各引擎的后端模板驱动
            </span>
          </div>

          {error && (
            <div role="alert" style={{
              padding: '10px 12px', marginBottom: 12, borderRadius: 8,
              background: 'color-mix(in oklab, var(--danger), transparent 90%)',
              color: 'var(--danger)', fontSize: 12,
            }}>
              扫描失败：{error}
            </div>
          )}

          {loading && engines.length === 0 ? (
            <div style={{
              padding: 32, textAlign: 'center', color: 'var(--meta)',
              background: 'var(--bg)', border: '1px solid var(--border)',
              borderRadius: 12,
            }}>
              正在读取执行引擎…
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
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{engineLabel(engine.id)}</span>
                      {engine.mode && (
                        <span style={{
                          padding: '1px 6px', borderRadius: 999,
                          background: 'var(--surface)', color: 'var(--muted)',
                          fontSize: 10, textTransform: 'uppercase',
                        }}>
                          {engine.mode}
                        </span>
                      )}
                    </div>
                    <div style={{ color: 'var(--muted)', fontSize: 11, overflowWrap: 'anywhere' }}>
                      {ENGINE_DESCRIPTIONS[engine.id] || 'WorkStep 执行引擎'}
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
                    <button
                      className="btn-ghost"
                      style={{ minWidth: 62, height: 30, justifyContent: 'center' }}
                      disabled={testingEngine !== null}
                      onClick={() => void testEngine(engine.id)}
                    >
                      {isTesting ? '测试中…' : '测试'}
                    </button>
                  )}
                  {engine.id !== 'api' && engine.id !== 'pydantic_ai' && (
                    <button
                      className="btn-ghost"
                      style={{ minWidth: 54, height: 30, justifyContent: 'center' }}
                      onClick={() => openPathEditor(engine)}
                    >
                      编辑
                    </button>
                  )}
                  <span style={{
                    minWidth: 60, textAlign: 'center', padding: '3px 8px',
                    borderRadius: 999, fontSize: 10, fontWeight: 600,
                    color: engine.verified
                      ? 'var(--success)'
                      : engine.installed ? 'var(--warn)' : 'var(--meta)',
                    background: engine.verified
                      ? 'color-mix(in oklab, var(--success), transparent 88%)'
                      : engine.installed
                        ? 'color-mix(in oklab, var(--warn), transparent 88%)'
                      : 'var(--surface)',
                  }}>
                    {engine.verified ? '已验证' : engine.installed ? '待测试' : '未安装'}
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
                          模型
                        </span>
                        <select
                          id={`default-model-${engine.id}`}
                          aria-label={`${engineLabel(engine.id)} 默认模型`}
                          title="选择阶段未单独指定模型时使用的默认模型"
                          value={usesCustomModel ? '__custom__' : savedDefaultModel}
                          disabled={Boolean(modelsLoading[engine.id]) || savingModel === engine.id}
                          onChange={(event) => selectDefaultModel(engine.id, event.target.value)}
                          style={{
                            flex: 1, minWidth: 0, height: 28,
                            border: '1px solid var(--border)', borderRadius: 7,
                            background: 'var(--bg)', color: 'var(--fg)',
                            padding: '0 8px', fontSize: 12,
                          }}
                        >
                          <option value="">
                            {modelsLoading[engine.id] ? '正在读取模型…' : '跟随引擎默认'}
                          </option>
                          {engineModels.map((model) => (
                            <option key={model.id} value={model.id}>{model.label}</option>
                          ))}
                          <option value="__custom__">自定义…</option>
                        </select>
                        {savingModel === engine.id && (
                          <span style={{ flexShrink: 0, color: 'var(--meta)', fontSize: 10 }}>
                            保存中…
                          </span>
                        )}
                        {models[engine.id] && !modelsLoading[engine.id] && (
                          <button
                            className="btn-ghost"
                            style={{ flexShrink: 0, height: 24, padding: '0 8px', fontSize: 11 }}
                            onClick={() => void loadEngineModels(engine.id, true)}
                          >
                            ↻ 刷新
                          </button>
                        )}
                      </div>
                      {modelErrors[engine.id] && (
                        <div style={{
                          marginTop: 4, color: 'var(--meta)', fontSize: 10,
                        }}>
                          {modelErrors[engine.id]}，可填写自定义模型 ID。
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
                            自定义模型
                          </span>
                          <input
                            id={`custom-model-${engine.id}`}
                            value={customModelDrafts[engine.id] ?? savedDefaultModel}
                            placeholder="例如 model-id"
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
                              border: '1px solid var(--border)', borderRadius: 7,
                              background: 'var(--bg)', color: 'var(--fg)',
                              padding: '0 8px', fontSize: 12,
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
                      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 7 }}>
                        可执行文件路径
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input
                          value={pathDraft}
                          onChange={(event) => setPathDraft(event.target.value)}
                          placeholder="输入 CLI 可执行文件的绝对路径"
                          autoFocus
                          style={{
                            flex: 1, minWidth: 0, height: 30,
                            border: `1px solid ${pathError ? 'var(--danger)' : 'var(--border)'}`,
                            borderRadius: 7, background: 'var(--bg)', color: 'var(--fg)',
                            padding: '0 9px', fontSize: 12,
                          }}
                        />
                        <button
                          className="btn-ghost"
                          disabled={pathSaving}
                          onClick={() => setEditingEngine(null)}
                        >
                          取消
                        </button>
                        <button
                          className="btn-primary"
                          disabled={pathSaving}
                          onClick={() => void saveBinaryPath(engine.id)}
                        >
                          {pathSaving ? '保存中…' : '保存并扫描'}
                        </button>
                      </div>
                      <div style={{
                        marginTop: 6, fontSize: 10,
                        color: pathError ? 'var(--danger)' : 'var(--meta)',
                      }}>
                        {pathError || '清空路径并保存，可恢复为系统 PATH 自动发现。'}
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
        ) : (
          <CoordinatorAgentSettings />
        )}
      </section>
      </div>
      </div>
      </div>
  )
}

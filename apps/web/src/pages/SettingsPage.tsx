import { useEffect, useMemo, useRef, useState } from 'react'
import {
  engineApi,
  type EngineInfo,
  type EngineModel,
  type EngineTestResult,
} from '../api/client'
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
      width: 42, height: 42, borderRadius: 11, flexShrink: 0,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      background: `color-mix(in oklab, ${color}, transparent 86%)`,
      border: `1px solid color-mix(in oklab, ${color}, transparent 72%)`,
      color, fontSize: 15, fontWeight: 700,
    }}>
      {initials}
    </span>
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

  const loadModels = (installedEngines: EngineInfo[]) => {
    const installed = installedEngines.filter((engine) => engine.installed)
    setModelsLoading(Object.fromEntries(installed.map((engine) => [engine.id, true])))
    installed.forEach(async (engine) => {
      let result
      try {
        result = await engineApi.models(engine.id)
      } catch (modelError) {
        result = {
          engine_id: engine.id,
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
    })
  }

  const scan = async () => {
    setLoading(true)
    setError('')
    try {
      const result = await engineApi.refresh()
      setEngines(result.engines)
      setLoading(false)
      loadModels(result.engines)
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : '扫描失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    void scan()
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
      loadModels([
        ...engines.filter((engine) => engine.id !== engineId),
        result.engine,
      ])
    } catch (saveError) {
      setPathError(saveError instanceof Error ? saveError.message : '保存失败')
    } finally {
      setPathSaving(false)
    }
  }

  const sortedEngines = useMemo(
    () => [...engines].sort((a, b) =>
      Number(b.installed) - Number(a.installed)
    ),
    [engines],
  )
  const installedCount = engines.filter((engine) => engine.installed).length
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

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
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
          aria-current="page"
          style={{
            width: '100%', height: 38, padding: '0 11px',
            display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
            gap: 9, borderRadius: 8, background: 'var(--bg)',
            color: 'var(--fg)', fontSize: 12, fontWeight: 600,
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/>
            <path d="M1 14h6M9 8h6M17 16h6"/>
          </svg>
          执行引擎
        </button>
      </aside>

      <section className="settings-content" style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', padding: '24px 28px 40px' }}>
        <div style={{ maxWidth: 960, margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 24 }}>
            <div style={{ flex: 1 }}>
              <h1 style={{ fontSize: 22, fontWeight: 650, marginBottom: 6 }}>执行引擎</h1>
              <p style={{ color: 'var(--muted)', fontSize: 13 }}>
                扫描本机可用的 CLI、ACP 和 API 执行引擎。只有已安装的引擎可以在阶段编辑器中选择。
              </p>
            </div>
            <button className="btn-ghost" onClick={() => void scan()} disabled={loading}>
              <span aria-hidden="true">↻</span>
              {loading ? '扫描中…' : '重新扫描'}
            </button>
          </div>

          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 10,
          }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>
              本机执行引擎
              {!loading && <span style={{ marginLeft: 6, color: 'var(--meta)', fontWeight: 400 }}>({installedCount}/{engines.length})</span>}
            </span>
            <span style={{ fontSize: 11, color: 'var(--meta)' }}>
              扫描结果来自 WorkStep Daemon
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
              正在扫描本机执行引擎…
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
                    padding: '16px 18px', display: 'flex',
                    alignItems: 'center', gap: 14,
                  }}>
                  <EngineIcon engine={engine} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                      <span style={{ fontSize: 14, fontWeight: 600 }}>{engineLabel(engine.id)}</span>
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
                    <div style={{ color: 'var(--muted)', fontSize: 12, overflowWrap: 'anywhere' }}>
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
                      style={{ minWidth: 68, justifyContent: 'center' }}
                      disabled={testingEngine !== null}
                      onClick={() => void testEngine(engine.id)}
                    >
                      {isTesting ? '测试中…' : '测试'}
                    </button>
                  )}
                  {engine.id !== 'api' && (
                    <button
                      className="btn-ghost"
                      style={{ minWidth: 58, justifyContent: 'center' }}
                      onClick={() => openPathEditor(engine)}
                    >
                      编辑
                    </button>
                  )}
                  <span style={{
                    minWidth: 64, textAlign: 'center', padding: '4px 9px',
                    borderRadius: 999, fontSize: 11, fontWeight: 600,
                    color: engine.installed ? 'var(--success)' : 'var(--meta)',
                    background: engine.installed
                      ? 'color-mix(in oklab, var(--success), transparent 88%)'
                      : 'var(--surface)',
                  }}>
                    {engine.installed ? '已安装' : '未安装'}
                  </span>
                  </div>
                  {engine.installed && (
                    <div style={{
                      padding: '14px 18px 16px',
                      borderTop: '1px solid var(--border-soft)',
                      background: 'var(--surface)',
                    }}>
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        marginBottom: 8, color: 'var(--muted)', fontSize: 12,
                      }}>
                        <span style={{ fontWeight: 600 }}>模型</span>
                        <span>·</span>
                        <span>内置列表</span>
                        {savingModel === engine.id && (
                          <span style={{ marginLeft: 'auto', color: 'var(--meta)', fontSize: 10 }}>
                            保存中…
                          </span>
                        )}
                      </div>
                      <select
                        id={`default-model-${engine.id}`}
                        aria-label={`${engineLabel(engine.id)} 默认模型`}
                        value={usesCustomModel ? '__custom__' : savedDefaultModel}
                        disabled={Boolean(modelsLoading[engine.id]) || savingModel === engine.id}
                        onChange={(event) => selectDefaultModel(engine.id, event.target.value)}
                        style={{
                          width: '100%', height: 38,
                          border: '1px solid var(--border)', borderRadius: 8,
                          background: 'var(--bg)', color: 'var(--fg)',
                          padding: '0 11px', fontSize: 13,
                        }}
                      >
                        <option value="">
                          {modelsLoading[engine.id] ? '正在读取模型…' : '跟随引擎默认'}
                        </option>
                        {engineModels.map((model) => (
                          <option key={model.id} value={model.id}>{model.label}</option>
                        ))}
                        <option value="__custom__">自定义（在下方填写）…</option>
                      </select>
                      <div style={{
                        marginTop: 7, color: modelErrors[engine.id] ? 'var(--meta)' : 'var(--muted)',
                        fontSize: 11,
                      }}>
                        {modelErrors[engine.id]
                          ? `${modelErrors[engine.id]}，可填写自定义模型 ID。`
                          : '选择阶段未单独指定模型时使用的默认模型。'}
                      </div>
                      {usesCustomModel && (
                        <div style={{ marginTop: 12 }}>
                          <label
                            htmlFor={`custom-model-${engine.id}`}
                            style={{
                              display: 'block', marginBottom: 7,
                              color: 'var(--muted)', fontSize: 12, fontWeight: 600,
                            }}
                          >
                            自定义模型 ID
                          </label>
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
                              width: '100%', height: 38,
                              border: '1px solid var(--border)', borderRadius: 8,
                              background: 'var(--bg)', color: 'var(--fg)',
                              padding: '0 11px', fontSize: 13,
                            }}
                          />
                        </div>
                      )}
                    </div>
                  )}
                  {editingEngine === engine.id && (
                    <div style={{
                      padding: '14px 18px 16px', borderTop: '1px solid var(--border-soft)',
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
                            flex: 1, minWidth: 0, height: 34,
                            border: `1px solid ${pathError ? 'var(--danger)' : 'var(--border)'}`,
                            borderRadius: 7, background: 'var(--bg)', color: 'var(--fg)',
                            padding: '0 10px', fontSize: 12,
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
      </section>
      </div>
      </div>
    </div>
  )
}

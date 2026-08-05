import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  engineApi,
  type ApiEngineConfig,
  type ApiEngineProvider,
  type ClaudePermissionMode,
  type EngineInfo,
  type EngineModel,
  type EngineTestResult,
} from '../api/client'
import ConfirmDialog from '../components/ConfirmDialog'
import EngineSelect from '../components/EngineSelect'
import {
  ENGINE_COLORS,
  ENGINE_DESCRIPTIONS,
  engineLabel,
} from '../engineMeta'

const CLAUDE_PERMISSION_OPTIONS: Array<{
  value: ClaudePermissionMode
  label: string
}> = [
  { value: 'dontAsk', label: '不询问（需要确认时拒绝）' },
  { value: 'acceptEdits', label: '自动接受文件编辑' },
  { value: 'auto', label: '自动判断' },
  { value: 'manual', label: '手动确认' },
  { value: 'plan', label: '计划模式（只读）' },
  { value: 'bypassPermissions', label: '绕过全部权限检查（危险）' },
]

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

  useEffect(() => {
    engineApi.executionConfig()
      .then((config) => setEngine(config.engine))
      .catch((reason) => setError(
        reason instanceof Error ? reason.message : '读取默认执行引擎失败'
      ))
  }, [])

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
    <div style={{ padding: 18, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg)', marginBottom: 24 }}>
      <div style={{ fontSize: 14, fontWeight: 650, marginBottom: 5 }}>默认执行引擎</div>
      <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 14 }}>
        用于新建任务和新建阶段；已有任务与阶段配置不会被修改。
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <EngineSelect
          engines={engines}
          value={engine}
          onChange={setEngine}
          disabled={loading || saving}
          defaultOption={{ value: '', label: '系统默认（Claude Code）' }}
          ariaLabel="默认执行引擎"
          style={{ width: 300, height: 34 }}
        />
        <button className="btn-primary" disabled={saving || loading} onClick={() => void save()}>
          {saving ? '保存中…' : '保存默认值'}
        </button>
      </div>
      {(error || notice) && (
        <div style={{ marginTop: 9, fontSize: 11, color: error ? 'var(--danger)' : 'var(--success)' }}>
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
  const [models, setModels] = useState<EngineModel[]>([])
  const [loading, setLoading] = useState(true)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [modelError, setModelError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    engineApi.coordinatorDefaults()
      .then((config) => {
        setEngines(config.available_engines as EngineInfo[])
        setEngine(config.engine)
        setModel(config.model)
        setFastModel(config.fast_model)
        setError('')
      })
      .catch((reason) => setError(
        reason instanceof Error ? reason.message : '读取协调 Agent 设置失败'
      ))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!engine) {
      setModels([])
      setModelError('')
      return
    }
    let active = true
    setModelsLoading(true)
    setModelError('')
    engineApi.models(engine)
      .then((result) => {
        if (!active) return
        setModels(result.models || [])
        setModelError(result.error || '')
      })
      .catch((reason) => {
        if (!active) return
        setModels([])
        setModelError(reason instanceof Error ? reason.message : '读取模型失败')
      })
      .finally(() => {
        if (active) setModelsLoading(false)
      })
    return () => { active = false }
  }, [engine])

  const changeEngine = (engineId: string) => {
    setEngine(engineId)
    setModel('')
    setFastModel('')
    setNotice('')
  }

  const save = async () => {
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const result = await engineApi.setCoordinatorDefaults(engine, model, fastModel)
      setEngine(result.engine)
      setModel(result.model)
      setFastModel(result.fast_model)
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
          配置任务协调对话的全局默认引擎、推理模型和快速模型。任务详情中的单独配置优先级更高。
        </p>
      </div>
      <div style={{ padding: 20, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg)' }}>
        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
          默认协调引擎
        </label>
        <EngineSelect
          engines={engines}
          value={engine}
          onChange={changeEngine}
          disabled={loading || saving}
          requireCoordinator
          defaultOption={{ value: '', label: '跟随任务执行引擎' }}
          ariaLabel="默认协调引擎"
          style={{ width: '100%', height: 36, marginBottom: 16 }}
        />
        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
          默认推理模型
        </label>
        <select
          value={model}
          disabled={!engine || modelsLoading || saving}
          onChange={(event) => setModel(event.target.value)}
          aria-label="默认推理模型"
          style={{ width: '100%', height: 36, marginBottom: 16 }}
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
        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
          默认快速模型
        </label>
        <select
          value={fastModel}
          disabled={!engine || modelsLoading || saving}
          onChange={(event) => setFastModel(event.target.value)}
          aria-label="默认快速模型"
          style={{ width: '100%', height: 36 }}
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
        <div style={{ marginTop: 7, fontSize: 11, color: 'var(--meta)' }}>
          推理模型负责理解、决策与回复；快速模型负责读取产物和修复结构化输出。
        </div>
        {modelError && (
          <div style={{ marginTop: 7, fontSize: 11, color: 'var(--warn)' }}>
            模型列表读取失败：{modelError}。仍可保存引擎默认模型。
          </div>
        )}
        <div style={{ marginTop: 18, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
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

const DEFAULT_API_BASE_URLS: Record<ApiEngineProvider, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
}

function ProviderEngineCard({
  engine,
  kind,
  onEngineChange,
}: {
  engine: EngineInfo
  kind: 'api' | 'pydantic_ai'
  onEngineChange: (engine: EngineInfo) => void
}) {
  const fieldPrefix = kind === 'pydantic_ai' ? 'pydantic-ai' : 'api'
  const isPydanticAI = kind === 'pydantic_ai'
  const [config, setConfig] = useState<ApiEngineConfig | null>(null)
  const [provider, setProvider] = useState<ApiEngineProvider>('openai')
  const [baseUrl, setBaseUrl] = useState(DEFAULT_API_BASE_URLS.openai)
  const [model, setModel] = useState('')
  const [availableApiModels, setAvailableApiModels] = useState<EngineModel[]>([])
  const [apiModelsLoading, setApiModelsLoading] = useState(false)
  const [apiModelsError, setApiModelsError] = useState('')
  const [customApiModel, setCustomApiModel] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [apiKeyVisible, setApiKeyVisible] = useState(false)
  const [apiKeyLoading, setApiKeyLoading] = useState(false)
  const [clearApiKey, setClearApiKey] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [message, setMessage] = useState('')
  const [messageKind, setMessageKind] = useState<'error' | 'success' | ''>('')

  const loadApiModels = useCallback(async (
    selectedProvider: ApiEngineProvider,
    selectedBaseUrl: string,
    selectedApiKey: string | undefined,
    selectedModel: string,
  ) => {
    if (!selectedBaseUrl.trim()) return
    setApiModelsLoading(true)
    setApiModelsError('')
    try {
      const result = await (isPydanticAI
        ? engineApi.pydanticAIModels
        : engineApi.apiModels)({
        provider: selectedProvider,
        base_url: selectedBaseUrl.trim(),
        api_key: selectedApiKey,
      })
      setAvailableApiModels(result.models)
      setApiModelsError(result.error || '')
      setCustomApiModel(Boolean(
        selectedModel
        && !result.models.some((item) => item.id === selectedModel)
      ))
    } catch (modelsLoadError) {
      setAvailableApiModels([])
      setApiModelsError(
        modelsLoadError instanceof Error ? modelsLoadError.message : '读取模型失败'
      )
      setCustomApiModel(Boolean(selectedModel))
    } finally {
      setApiModelsLoading(false)
    }
  }, [isPydanticAI])

  const applyConfig = useCallback((value: ApiEngineConfig) => {
    setConfig(value)
    setProvider(value.provider)
    setBaseUrl(value.base_url || DEFAULT_API_BASE_URLS[value.provider])
    setModel(value.model)
    setCustomApiModel(Boolean(value.model))
    setApiKey('')
    setApiKeyVisible(false)
    setClearApiKey(false)
  }, [])

  useEffect(() => {
    let active = true
    const loadConfig = isPydanticAI
      ? engineApi.pydanticAIConfig
      : engineApi.apiConfig
    loadConfig()
      .then((value) => {
        if (!active) return
        applyConfig(value)
        if (value.configured || value.has_api_key) {
          void loadApiModels(value.provider, value.base_url, undefined, value.model)
        }
      })
      .catch((loadError) => {
        if (!active) return
        setMessage(loadError instanceof Error ? loadError.message : '读取配置失败')
        setMessageKind('error')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [applyConfig, isPydanticAI, loadApiModels])

  const changeProvider = (nextProvider: ApiEngineProvider) => {
    const currentDefault = DEFAULT_API_BASE_URLS[provider]
    setProvider(nextProvider)
    setAvailableApiModels([])
    setApiModelsError('')
    setCustomApiModel(Boolean(model))
    if (!baseUrl || baseUrl === currentDefault) {
      setBaseUrl(DEFAULT_API_BASE_URLS[nextProvider])
    }
  }

  const save = async () => {
    setSaving(true)
    setMessage('')
    setMessageKind('')
    try {
      const saveConfig = isPydanticAI
        ? engineApi.setPydanticAIConfig
        : engineApi.setApiConfig
      const result = await saveConfig({
        provider,
        base_url: baseUrl.trim(),
        model: model.trim(),
        api_key: apiKey.trim() || undefined,
        clear_api_key: clearApiKey,
      })
      if (!result.saved || !result.config || !result.engine) {
        setMessage(result.message || '保存失败')
        setMessageKind('error')
        return
      }
      applyConfig(result.config)
      void loadApiModels(
        result.config.provider,
        result.config.base_url,
        undefined,
        result.config.model,
      )
      onEngineChange(result.engine)
      setMessage('配置已保存')
      setMessageKind('success')
    } catch (saveError) {
      setMessage(saveError instanceof Error ? saveError.message : '保存失败')
      setMessageKind('error')
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    setMessage('')
    setMessageKind('')
    try {
      const result = await engineApi.test(engine.id)
      if (result.engine) onEngineChange(result.engine)
      setMessage(
        `${result.success ? '连接和对话测试通过' : result.message}`
        + (result.duration_ms > 0 ? ` · ${result.duration_ms}ms` : '')
      )
      setMessageKind(result.success ? 'success' : 'error')
    } catch (testError) {
      setMessage(testError instanceof Error ? testError.message : '测试失败')
      setMessageKind('error')
    } finally {
      setTesting(false)
    }
  }

  const toggleApiKey = async () => {
    if (apiKeyVisible) {
      setApiKeyVisible(false)
      return
    }
    if (apiKey || !config?.has_api_key) {
      setApiKeyVisible(true)
      return
    }
    setApiKeyLoading(true)
    setMessage('')
    setMessageKind('')
    try {
      const result = await (
        isPydanticAI ? engineApi.pydanticAIKey() : engineApi.apiKey()
      )
      setApiKey(result.api_key)
      setApiKeyVisible(true)
    } catch (loadError) {
      setMessage(loadError instanceof Error ? loadError.message : '读取 Key 失败')
      setMessageKind('error')
    } finally {
      setApiKeyLoading(false)
    }
  }

  const statusConfigured = config?.configured ?? engine.configured
  const statusVerified = statusConfigured && engine.verified

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 12,
      background: 'var(--bg)', overflow: 'hidden',
    }}>
      <div style={{
        padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 14,
        borderBottom: '1px solid var(--border-soft)',
      }}>
        <EngineIcon engine={engine} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>{engineLabel(engine.id)}</span>
            <span style={{
              padding: '1px 6px', borderRadius: 999,
              background: 'color-mix(in oklab, var(--accent), transparent 88%)',
              color: 'var(--accent)', fontSize: 10,
            }}>
              {isPydanticAI ? '内置' : 'API'}
            </span>
          </div>
          <div style={{ color: 'var(--muted)', fontSize: 12 }}>
            {isPydanticAI
              ? 'WorkStep 内置 Agent，由 Pydantic AI 按配置加载 Provider。'
              : '直接调用你配置的 OpenAI-compatible 或 Anthropic API。'}
          </div>
        </div>
        <span style={{
          padding: '4px 9px', borderRadius: 999, fontSize: 11, fontWeight: 600,
          color: statusVerified
            ? 'var(--success)'
            : statusConfigured ? 'var(--warn)' : 'var(--accent)',
          background: statusVerified
            ? 'color-mix(in oklab, var(--success), transparent 88%)'
            : statusConfigured
              ? 'color-mix(in oklab, var(--warn), transparent 88%)'
              : 'color-mix(in oklab, var(--accent), transparent 88%)',
        }}>
          {statusVerified ? '已验证' : statusConfigured ? '待测试' : '待配置'}
        </span>
      </div>

      <div style={{ padding: '16px 18px 18px', background: 'var(--surface)' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '180px minmax(0, 1fr)', gap: 12,
        }}>
          <div>
            <label htmlFor={`${fieldPrefix}-provider`} style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 600 }}>
              {isPydanticAI ? 'Provider 类型' : '接口类型'}
            </label>
            <select
              id={`${fieldPrefix}-provider`}
              value={provider}
              disabled={loading || saving}
              onChange={(event) => changeProvider(event.target.value as ApiEngineProvider)}
              style={{ width: '100%', height: 38 }}
            >
              <option value="openai">OpenAI-compatible</option>
              <option value="anthropic">Anthropic Messages</option>
            </select>
          </div>
          <div>
            <label htmlFor={`${fieldPrefix}-base-url`} style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 600 }}>
              {isPydanticAI ? 'Provider 地址' : 'API 地址'}
            </label>
            <input
              id={`${fieldPrefix}-base-url`}
              value={baseUrl}
              disabled={loading || saving}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={DEFAULT_API_BASE_URLS[provider]}
              style={{ width: '100%', height: 38 }}
            />
          </div>
          <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label htmlFor={`${fieldPrefix}-key`} style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 600 }}>
                API Key
              </label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  id={`${fieldPrefix}-key`}
                  type={apiKeyVisible ? 'text' : 'password'}
                  autoComplete="off"
                  value={apiKey}
                  disabled={loading || saving || clearApiKey || apiKeyLoading}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={config?.has_api_key ? '已保存，点击显示可查看' : '可选，本地无鉴权接口可留空'}
                  style={{ flex: 1, minWidth: 0, height: 38 }}
                />
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={loading || saving || clearApiKey || apiKeyLoading || (!apiKey && !config?.has_api_key)}
                  onClick={() => void toggleApiKey()}
                  style={{ minWidth: 58, justifyContent: 'center' }}
                >
                  {apiKeyLoading ? '读取中…' : apiKeyVisible ? '隐藏' : '显示'}
                </button>
              </div>
            </div>
            <div>
              <label htmlFor={`${fieldPrefix}-model`} style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 600 }}>
                默认模型
              </label>
              <div style={{ display: 'flex', gap: 6 }}>
                <select
                  id={`${fieldPrefix}-model`}
                  value={customApiModel ? '__custom__' : model}
                  disabled={loading || saving || apiModelsLoading}
                  onChange={(event) => {
                    if (event.target.value === '__custom__') {
                      setCustomApiModel(true)
                      if (availableApiModels.some((item) => item.id === model)) {
                        setModel('')
                      }
                      return
                    }
                    setCustomApiModel(false)
                    setModel(event.target.value)
                  }}
                  style={{ flex: 1, minWidth: 0, height: 38 }}
                >
                  <option value="">
                    {apiModelsLoading ? '正在读取模型…' : '请选择模型'}
                  </option>
                  {availableApiModels.map((item) => (
                    <option key={item.id} value={item.id}>{item.label || item.id}</option>
                  ))}
                  <option value="__custom__">自定义模型 ID…</option>
                </select>
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={loading || saving || apiModelsLoading || !baseUrl.trim()}
                  onClick={() => void loadApiModels(
                    provider,
                    baseUrl,
                    clearApiKey ? '' : apiKey.trim() || undefined,
                    model,
                  )}
                  style={{ minWidth: 58, justifyContent: 'center' }}
                >
                  {apiModelsLoading ? '读取中…' : '刷新'}
                </button>
              </div>
              {customApiModel && (
                <input
                  id={`${fieldPrefix}-custom-model`}
                  aria-label={`${engineLabel(engine.id)} 自定义模型 ID`}
                  value={model}
                  disabled={loading || saving}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder="例如 gpt-5.4、deepseek-chat"
                  style={{ width: '100%', height: 36, marginTop: 7 }}
                />
              )}
              {apiModelsError && (
                <div style={{ marginTop: 5, color: 'var(--danger)', fontSize: 10 }}>
                  {apiModelsError}，仍可使用自定义模型。
                </div>
              )}
            </div>
          </div>
        </div>

        <div style={{
          marginTop: 10, display: 'flex', alignItems: 'center', gap: 10,
          color: 'var(--muted)', fontSize: 11,
        }}>
          {config?.has_api_key && (
            <label style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              cursor: saving ? 'default' : 'pointer', whiteSpace: 'nowrap',
            }}>
              <input
                type="checkbox"
                checked={clearApiKey}
                disabled={saving}
                style={{
                  width: 16, height: 16, padding: 0, margin: 0,
                  flexShrink: 0, accentColor: 'var(--accent)',
                }}
                onChange={(event) => {
                  setClearApiKey(event.target.checked)
                  if (event.target.checked) {
                    setApiKey('')
                    setApiKeyVisible(false)
                  }
                }}
              />
              清除已保存的 Key
            </label>
          )}
          <span style={{ marginLeft: config?.has_api_key ? 'auto' : 0 }}>
            远程地址必须使用 HTTPS；Ollama 等本机接口可使用 localhost HTTP。
          </span>
        </div>

        <div style={{
          marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border-soft)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <div
            role="status"
            style={{
              flex: 1, minHeight: 18, fontSize: 11,
              color: messageKind === 'error'
                ? 'var(--danger)'
                : messageKind === 'success'
                  ? 'var(--success)'
                  : 'var(--muted)',
            }}
          >
            {message || 'Key 仅保存在本机 ~/.workstep/config.json，不会返回到浏览器。'}
          </div>
          <button
            className="btn-ghost"
            disabled={!statusConfigured || saving || testing}
            onClick={() => void test()}
          >
            {testing ? '测试中…' : '测试连接'}
          </button>
          <button
            className="btn-primary"
            disabled={loading || saving || !baseUrl.trim() || !model.trim()}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存配置'}
          </button>
        </div>
      </div>
    </div>
  )
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
  const [claudePermissionMode, setClaudePermissionMode] = useState<ClaudePermissionMode | ''>('')
  const [permissionLoading, setPermissionLoading] = useState(true)
  const [permissionSaving, setPermissionSaving] = useState(false)
  const [permissionError, setPermissionError] = useState('')
  const [confirmBypassPermissions, setConfirmBypassPermissions] = useState(false)
  const [activeSection, setActiveSection] = useState<'engines' | 'coordinator'>('engines')

  const loadClaudePermissionMode = async () => {
    setPermissionLoading(true)
    try {
      const result = await engineApi.claudePermissionMode()
      setClaudePermissionMode(result.mode)
      setPermissionError('')
    } catch (permissionLoadError) {
      setPermissionError(
        permissionLoadError instanceof Error
          ? permissionLoadError.message
          : '读取权限模式失败'
      )
    } finally {
      setPermissionLoading(false)
    }
  }

  const loadModels = (installedEngines: EngineInfo[]) => {
    const installed = installedEngines.filter(
      (engine) => engine.installed && !engine.built_in && engine.id !== 'api'
    )
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
    void loadClaudePermissionMode()
  }, [])

  const saveClaudePermissionMode = async (
    mode: ClaudePermissionMode,
    confirmedDangerous = false,
  ) => {
    const previous = claudePermissionMode
    setPermissionSaving(true)
    setPermissionError('')
    try {
      const result = await engineApi.setClaudePermissionMode(
        mode,
        confirmedDangerous,
      )
      if (!result.saved) {
        setPermissionError(result.message || '保存权限模式失败')
        return
      }
      setClaudePermissionMode(result.mode)
    } catch (saveError) {
      setClaudePermissionMode(previous)
      setPermissionError(saveError instanceof Error ? saveError.message : '保存失败')
    } finally {
      setPermissionSaving(false)
    }
  }

  const selectClaudePermissionMode = (mode: ClaudePermissionMode) => {
    if (mode === 'bypassPermissions') {
      setConfirmBypassPermissions(true)
      return
    }
    void saveClaudePermissionMode(mode)
  }

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
    () => engines.filter(
      (engine) => !engine.built_in && engine.id !== 'api'
    ).sort((a, b) =>
      Number(b.installed) - Number(a.installed)
    ),
    [engines],
  )
  const builtInEngine = engines.find((engine) => engine.id === 'pydantic_ai')
  const apiEngine = engines.find((engine) => engine.id === 'api')
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
      </aside>

      <section className="settings-content" style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', padding: '24px 28px 40px' }}>
        {activeSection === 'engines' ? (
        <div style={{ maxWidth: 960, margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 24 }}>
            <div style={{ flex: 1 }}>
              <h1 style={{ fontSize: 22, fontWeight: 650, marginBottom: 6 }}>执行引擎</h1>
              <p style={{ color: 'var(--muted)', fontSize: 13 }}>
                配置 WorkStep 内置引擎，并扫描本机可用的 CLI 与 ACP 执行引擎。
              </p>
            </div>
            <button className="btn-ghost" onClick={() => void scan()} disabled={loading}>
              <span aria-hidden="true">↻</span>
              {loading ? '扫描中…' : '重新扫描'}
            </button>
          </div>

          <ExecutionDefaultSettings engines={engines} loading={loading} />

          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 10,
          }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>内置引擎</span>
            <span style={{ fontSize: 11, color: 'var(--meta)' }}>
              随 WorkStep Daemon 提供，无需本机安装 CLI
            </span>
          </div>
          {builtInEngine ? (
            <ProviderEngineCard
              engine={builtInEngine}
              kind="pydantic_ai"
              onEngineChange={(updatedEngine) => setEngines((current) =>
                current.map((engine) => engine.id === updatedEngine.id ? updatedEngine : engine)
              )}
            />
          ) : (
            <div style={{
              padding: 20, border: '1px solid var(--border)', borderRadius: 12,
              color: 'var(--muted)', fontSize: 12,
            }}>
              正在读取内置引擎…
            </div>
          )}

          <div style={{ height: 28 }} />

          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 10,
          }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>API / BYOK</span>
            <span style={{ fontSize: 11, color: 'var(--meta)' }}>
              保留原有直连 API / BYOK 配置
            </span>
          </div>
          {apiEngine ? (
            <ProviderEngineCard
              engine={apiEngine}
              kind="api"
              onEngineChange={(updatedEngine) => setEngines((current) =>
                current.map((engine) => engine.id === updatedEngine.id ? updatedEngine : engine)
              )}
            />
          ) : (
            <div style={{
              padding: 20, border: '1px solid var(--border)', borderRadius: 12,
              color: 'var(--muted)', fontSize: 12,
            }}>
              正在读取 API / BYOK…
            </div>
          )}

          <div style={{ height: 28 }} />

          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 10,
          }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>
              本机执行引擎
              {!loading && <span style={{ marginLeft: 6, color: 'var(--meta)', fontWeight: 400 }}>({installedCount}/{sortedEngines.length})</span>}
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
                      {engine.id === 'claude' && (
                        <div style={{
                          marginTop: 16, paddingTop: 14,
                          borderTop: '1px solid var(--border-soft)',
                        }}>
                          <div style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            marginBottom: 8, color: 'var(--muted)', fontSize: 12,
                          }}>
                            <span style={{ fontWeight: 600 }}>权限模式</span>
                            <span style={{
                              color: claudePermissionMode ? 'var(--success)' : 'var(--danger)',
                              fontSize: 10,
                            }}>
                              {claudePermissionMode ? '已确认' : '未确认，无法运行'}
                            </span>
                            {permissionSaving && (
                              <span style={{ marginLeft: 'auto', color: 'var(--meta)', fontSize: 10 }}>
                                保存中…
                              </span>
                            )}
                          </div>
                          <select
                            aria-label="Claude Code 权限模式"
                            value={claudePermissionMode}
                            disabled={permissionLoading || permissionSaving}
                            onChange={(event) => selectClaudePermissionMode(
                              event.target.value as ClaudePermissionMode
                            )}
                            style={{
                              width: '100%', height: 38,
                              border: `1px solid ${permissionError ? 'var(--danger)' : 'var(--border)'}`,
                              borderRadius: 8, background: 'var(--bg)', color: 'var(--fg)',
                              padding: '0 11px', fontSize: 13,
                            }}
                          >
                            <option value="" disabled>
                              {permissionLoading ? '正在读取权限模式…' : '请选择并确认权限模式'}
                            </option>
                            {CLAUDE_PERMISSION_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                          <div style={{
                            marginTop: 7, fontSize: 11,
                            color: permissionError ? 'var(--danger)' : 'var(--muted)',
                          }}>
                            {permissionError || 'WorkStep 每次启动 Claude Code 都会显式传入此权限模式。'}
                          </div>
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
        ) : (
          <CoordinatorAgentSettings />
        )}
      </section>
      </div>
      </div>
      <ConfirmDialog
        open={confirmBypassPermissions}
        title="确认绕过全部权限检查？"
        message="该模式允许 Claude Code 无需询问即可执行命令和修改文件。仅应在可信项目和受控环境中使用。"
        confirmText="确认并保存"
        danger
        onCancel={() => setConfirmBypassPermissions(false)}
        onConfirm={() => {
          setConfirmBypassPermissions(false)
          void saveClaudePermissionMode('bypassPermissions', true)
        }}
      />
      </div>
  )
}

import { request, singleFlight } from './transport'
import type { CoordinatorEngineSummary, EngineQuota } from './task'

// --- Engine API ---

export interface EngineInfo {
  id: string
  default_model?: string
  installed: boolean
  configured: boolean
  verified: boolean
  built_in: boolean
  version: string | null
  mode: 'cli' | 'acp' | 'agent' | 'sdk' | null
  config: EngineConfigPayload | null
  runtime_manageable?: boolean
  installable: boolean
  install_command: string | null
  updatable: boolean
  update_command: string | null
  requires_third_party_terms_acceptance: boolean
  third_party_terms_url: string | null
  supports_resume: boolean
  supports_session_fork: boolean
  supports_coordinator: boolean
  supports_tool_disable: boolean
  supports_native_schema: boolean
  supports_live_step_message: boolean
  supports_provider: boolean
  provider_protocols: string[]
  binary_path: string | null
  configured_path: string | null
}

export interface EngineRuntimeCatalog {
  engine_id: string
  current_version: string | null
  default_version: string | null
  minimum_version: string
  rollback_version: string | null
  configured_path: string | null
  requires_terms: boolean
  terms_url: string | null
  size_scope: 'primary_package'
  versions: { version: string; size_bytes: number | null; prerelease: boolean }[]
  history: { from_version: string | null; to_version: string; action: string; at: string }[]
  error: string | null
}

export interface EngineRuntimeOperation {
  id: string
  engine_id: string
  action: 'install' | 'rollback'
  target_version: string
  previous_version: string | null
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  stage: 'preparing' | 'downloading' | 'installing' | 'verifying' | 'completed' | 'failed'
  downloaded_bytes: number
  total_bytes: number | null
  size_scope: 'primary_package'
  message: string
}

export interface EngineInstallResult {
  engine_id: string
  success: boolean
  already_installed: boolean
  message: string
  engine?: EngineInfo
}

export interface EngineTestResult {
  engine_id: string
  success: boolean
  message: string
  duration_ms: number
  engine?: EngineInfo
}

export interface ExecutionDefaultConfig {
  engine: string
  resolved_engine: string
}

export interface CoordinatorDefaultConfig {
  engine: string
  model: string
  fast_model: string
  vision_model: string
  thinking_effort: string
  available_engines: CoordinatorEngineSummary[]
}

export interface AssistantConfiguredDefaults {
  engine: string
  model: string
  fast_model: string
  vision_model: string
  thinking_effort: string
  provider_id: string
}

export interface AssistantConfigInfo {
  name: string
  channel: string
  scope: string
  engine_label: string
  fields: string[]
  configured: AssistantConfiguredDefaults
  resolved?: AssistantConfiguredDefaults
  available_engines: CoordinatorEngineSummary[]
}

export interface AssistantSaveResult {
  saved: boolean
  configured: Partial<AssistantConfiguredDefaults>
  resolved: Partial<AssistantConfiguredDefaults>
}

export interface EngineModel {
  id: string
  label: string
  description: string | null
}

export interface EngineModelsResult {
  engine_id: string
  models: EngineModel[]
  default_model: string
  fetched_at?: string | null
  error: string | null
}

export interface EngineInspectResult {
  engine_id: string
  project_root: string | null
  skills: Array<{
    name: string
    description: string
    source_dir: string
  }>
  input_items: EngineInputItem[]
  mcp_servers: Array<{
    name: string
    command: string
    args: string[]
  }>
  mcp_supported: boolean
  mcp_error: string | null
}

export interface EngineInputItem {
  kind: 'skill' | 'command'
  name: string
  description: string
  input_hint?: string
  insert_text: string
  action: 'prompt' | 'toggle_plan' | 'open_model' | 'open_reasoning' | 'show_status'
}

export interface EngineConfigOption {
  value: string
  label: string
}

export interface EngineConfigField {
  key: string
  label: string
  type: 'text' | 'password' | 'select' | 'textarea' | 'json' | 'number' | 'checkbox' | 'model_map'
  placeholder: string
  options: EngineConfigOption[] | null
  required: boolean
  help: string
  default: string | number | boolean
  sensitive: boolean
  confirm_values: string[]
  step_hidden?: boolean
}

export interface EngineConfigSchema {
  engine_id: string
  fields: EngineConfigField[]
  values: Record<string, string>
  secrets: Record<string, boolean>
  configured: boolean
  installed: boolean
  saved?: boolean
  message?: string
  engine?: EngineInfo
}

export interface EngineConfigPayload {
  fields: EngineConfigField[]
  step_fields: EngineConfigField[]
  values: Record<string, string>
  secrets: Record<string, boolean>
}

export interface EngineConfigSaveInput {
  values: Record<string, string>
  clear?: Record<string, boolean>
  confirmed?: Record<string, boolean>
}

// --- Provider (供应商) API ---

export interface ProviderInfo {
  id: string
  name: string
  type: string
  protocols: string[]
  protocol: string
  base_url: string
  protocol_base_urls?: Record<string, string>
  api_key: string
  has_key: boolean
  enabled: boolean
  verified: boolean
  created_at: string
  model_count: number
  models_fetched_at: string | null
}

export interface ProviderTypeMeta {
  id: string
  label: string
  default_base_url: string
  auth: string
  default_protocol: string
  default_protocols: string[]
  help: string
}

export interface ProviderListResult {
  providers: ProviderInfo[]
  types: ProviderTypeMeta[]
}

/**
 * 供应商（可多协议）与引擎支持协议是否有交集。
 * 兼容旧数据：无 `protocols` 时退回单值 `protocol`。
 */
export function providerProtocolsMatch(
  provider: { protocols?: string[]; protocol?: string },
  engineProtocols: string[] | undefined | null,
): boolean {
  const providerProtocols =
    provider.protocols && provider.protocols.length
      ? provider.protocols
      : provider.protocol
        ? [provider.protocol]
        : []
  return (engineProtocols || []).some((item) =>
    providerProtocols.includes(item),
  )
}

export interface ProviderSaveInput {
  id?: string
  name: string
  type: string
  protocols: string[]
  protocol?: string
  base_url: string
  protocol_base_urls?: Record<string, string>
  api_key?: string
  enabled?: boolean
  clear?: Record<string, boolean>
  confirmed?: Record<string, boolean>
}

export interface ProviderSaveResult {
  saved: boolean
  message?: string
  provider: ProviderInfo | null
}

export interface ProviderTestResult {
  provider_id: string
  success: boolean
  message: string
  duration_ms: number
}

export interface ProviderModelsResult {
  provider_id: string
  models: EngineModel[]
  fetched_at?: string | null
  error: string | null
}

export interface ProviderImportCandidate {
  id: string
  source_type: string
  name: string
  type: string
  protocol: string
  protocols: string[]
  base_url: string
  has_key: boolean
  wire_api: string
  model_ids: string[]
  category: string
  error: string | null
  already_exists: boolean
}

export interface ProviderImportSource {
  id: string
  name: string
  provider_count: number
  description: string
  providers: ProviderImportCandidate[]
}

export interface ProviderImportResult {
  source: string
  imported: ProviderInfo[]
  skipped: { id: string; name: string; message: string }[]
  errors: { id: string; name: string; message: string }[]
}

export const providerApi = {
  list: (projectId = '') => request<ProviderListResult>(
    `/provider/list${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`,
  ),
  save: (input: ProviderSaveInput) =>
    request<ProviderSaveResult>('/provider', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  remove: (providerId: string) =>
    request<{ deleted: boolean }>(`/provider/${encodeURIComponent(providerId)}`, {
      method: 'DELETE',
    }),
  test: (providerId: string, protocol = '') =>
    request<ProviderTestResult>(`/provider/${encodeURIComponent(providerId)}/test`, {
      method: 'POST',
      body: JSON.stringify({ timeout_seconds: 15, protocol }),
    }),
  models: (providerId: string, refresh = false, protocol = '') =>
    request<ProviderModelsResult>(
      `/provider/${encodeURIComponent(providerId)}/models${
        refresh || protocol
          ? `?${new URLSearchParams({
              ...(refresh ? { refresh: '1' } : {}),
              ...(protocol ? { protocol } : {}),
            }).toString()}`
          : ''
      }`,
    ),
  reveal: (providerId: string) =>
    request<{ key: string; value: string | null }>(
      `/provider/${encodeURIComponent(providerId)}/reveal`,
      { method: 'POST' },
    ),
  previewModels: (providerId: string, protocol = '') =>
    request<ProviderModelsResult>(
      `/provider/${encodeURIComponent(providerId)}/models/preview${
        protocol ? `?protocol=${encodeURIComponent(protocol)}` : ''
      }`,
    ),
  saveModelSelection: (providerId: string, protocol: string, models: EngineModel[]) =>
    request<{ provider_id: string; count: number }>(
      `/provider/${encodeURIComponent(providerId)}/models/selection`,
      {
        method: 'POST',
        body: JSON.stringify({ protocol, models }),
      },
    ),
  importSources: () =>
    request<{ sources: ProviderImportSource[] }>('/provider/import/sources'),
  importFromCcSwitch: (providerIds: string[]) =>
    request<ProviderImportResult>('/provider/import/cc-switch', {
      method: 'POST',
      body: JSON.stringify({ provider_ids: providerIds }),
    }),
}

// --- Engine model list cache ---
// Model dropdowns fetch each engine's model list once and reuse the result
// across pages. Only a manual refresh (force = true) hits the remote API
// again; invalidateEngineModels() clears the cache when the engine's config
// or binary path changes.

const engineModelsCache = new Map<string, EngineModelsResult>()

function modelsCacheKey(engineId: string, providerId: string, projectId: string): string {
  return `${engineId}::${providerId}::${projectId}`
}

export function getCachedEngineModels(
  engineId: string,
  providerId = '',
  projectId = '',
): EngineModelsResult | null {
  return engineModelsCache.get(modelsCacheKey(engineId, providerId, projectId)) ?? null
}

export async function fetchEngineModels(
  engineId: string,
  force = false,
  providerId = '',
  projectId = '',
): Promise<EngineModelsResult> {
  const cacheKey = modelsCacheKey(engineId, providerId, projectId)
  const cached = engineModelsCache.get(cacheKey)
  if (cached && !force) return cached
  const result = await engineApi.models(engineId, providerId, force, projectId)
  engineModelsCache.set(cacheKey, result)
  return result
}

export function invalidateEngineModels(engineId: string): void {
  for (const key of Array.from(engineModelsCache.keys())) {
    if (key.startsWith(`${engineId}::`)) {
      engineModelsCache.delete(key)
    }
  }
}

export const engineApi = {
  list: () => request<{ engines: EngineInfo[] }>('/engine/list'),
  refresh: () =>
    request<{ engines: EngineInfo[] }>('/engine/refresh', { method: 'POST' }),
  executionConfig: () =>
    request<ExecutionDefaultConfig>('/engine/execution/config'),
  setExecutionConfig: (engine: string) =>
    request<ExecutionDefaultConfig & { saved: boolean }>('/engine/execution/config', {
      method: 'PUT',
      body: JSON.stringify({ engine }),
    }),
  coordinatorDefaults: (projectId = '') =>
    singleFlight(`engine/coordinator/config::${projectId}`, () =>
      request<CoordinatorDefaultConfig>(
        `/engine/coordinator/config${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`,
      ),
    ),
  setCoordinatorDefaults: (engine: string, model: string, fastModel: string, visionModel: string, thinkingEffort: string) =>
    request<{ saved: boolean; engine: string; model: string; fast_model: string; vision_model: string; thinking_effort: string }>(
      '/engine/coordinator/config',
      {
        method: 'PUT',
        body: JSON.stringify({
          engine,
          model,
          fast_model: fastModel,
          vision_model: visionModel,
          thinking_effort: thinkingEffort,
        }),
      },
    ),
  test: (engineId: string, config?: EngineConfigSaveInput, model?: string) =>
    request<EngineTestResult>('/engine/test', {
      method: 'POST',
      body: JSON.stringify({
        engine_id: engineId,
        values: config?.values ?? {},
        clear: config?.clear ?? {},
        model: model ?? '',
      }),
    }),
  runtime: (engineId: string) => request<EngineRuntimeCatalog>(`/engine/${encodeURIComponent(engineId)}/runtime`),
  runtimeOperation: (engineId: string) => request<EngineRuntimeOperation | null>(`/engine/${encodeURIComponent(engineId)}/runtime/operation`),
  startRuntimeOperation: (engineId: string, input: { version?: string; rollback: boolean; accept_third_party_terms: boolean }) =>
    request<EngineRuntimeOperation>(`/engine/${encodeURIComponent(engineId)}/runtime/operation`, {
      method: 'POST', body: JSON.stringify(input),
    }),
  install: (engineId: string, acceptThirdPartyTerms = false) =>
    request<EngineInstallResult>(`/engine/${encodeURIComponent(engineId)}/install`, {
      method: 'POST',
      body: JSON.stringify({ accept_third_party_terms: acceptThirdPartyTerms }),
    }),
  update: (engineId: string) =>
    request<EngineInstallResult>(`/engine/${encodeURIComponent(engineId)}/update`, {
      method: 'POST',
    }),
  quota: (engineId: string, projectId = '') =>
    singleFlight(
      `engine/quota::${engineId}::${projectId}`,
      () => request<{ engine_id: string; supported: boolean; quota: EngineQuota | null }>(
        `/engine/${encodeURIComponent(engineId)}/quota${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`,
      ),
    ),
  models: (engineId: string, providerId = '', refresh = false, projectId = '') =>
    request<EngineModelsResult>(
      `/engine/${encodeURIComponent(engineId)}/models${
        providerId || refresh || projectId ? '?' : ''
      }${[
        providerId ? `provider_id=${encodeURIComponent(providerId)}` : '',
        refresh ? 'refresh=1' : '',
        projectId ? `project_id=${encodeURIComponent(projectId)}` : '',
      ].filter(Boolean).join('&')}`,
    ),
  setDefaultModel: (engineId: string, model: string) =>
    request<{ engine_id: string; default_model: string; saved: boolean }>(
      `/engine/${encodeURIComponent(engineId)}/default-model`,
      {
        method: 'PUT',
        body: JSON.stringify({ model }),
      },
    ),
  setBinaryPath: (engineId: string, path: string) =>
    request<{
      engine_id: string
      saved: boolean
      message?: string
      engine?: EngineInfo
    }>(`/engine/${encodeURIComponent(engineId)}/binary-path`, {
      method: 'PUT',
      body: JSON.stringify({ path }),
    }),
  config: (engineId: string) =>
    request<EngineConfigSchema>(`/engine/${encodeURIComponent(engineId)}/config`),
  saveConfig: (engineId: string, input: EngineConfigSaveInput) =>
    request<EngineConfigSchema>(`/engine/${encodeURIComponent(engineId)}/config`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  revealConfig: (engineId: string, key: string) =>
    request<{ key: string; value: string | null }>(
      `/engine/${encodeURIComponent(engineId)}/config/reveal`,
      {
        method: 'POST',
        body: JSON.stringify({ key }),
      },
    ),
  inspect: (engineId: string, projectId?: string, projectRoot?: string) => {
    const params = new URLSearchParams()
    if (projectId) params.set('project_id', projectId)
    if (projectRoot) params.set('project_root', projectRoot)
    const query = params.toString()
    return request<EngineInspectResult>(
      `/engine/${encodeURIComponent(engineId)}/inspect${query ? `?${query}` : ''}`,
    )
  },
}

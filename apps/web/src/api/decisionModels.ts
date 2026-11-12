import { request } from './transport'

export type DecisionMode = 'managed' | 'local' | 'remote'
export type DecisionResourceKind = 'runtime' | 'runtime-gguf' | 'model' | 'english' | 'typed-decisions' | 'kev-0.8b-q8' | 'kev-4b-q4' | 'kev-9b-q4' | 'd1-omni-600m-q8' | 'd1-2b-q4' | 'd1-3b-q4' | 'd1-omni-2b-q8'
export interface DecisionSettings { mode: DecisionMode; base_url: string; model: string; has_api_key: boolean; proxy_enabled?: boolean; managed_model?: string }
export interface DecisionDraft { mode: DecisionMode; base_url: string; model: string; api_key: string | null; proxy_enabled?: boolean; access_key?: string; managed_model?: string }
export interface DecisionResource { stage: string; downloaded_bytes: number; total_bytes: number | null; error: string; installed: boolean; path: string; size_bytes: number | null }
export interface DecisionModel { backend?: 'laya' | 'gguf'; runtime_kind?: 'runtime' | 'runtime-gguf'; repo_id?: string; min_memory_gib?: number; min_available_gib?: number; environment?: DecisionEnvironment; id: string; resource_kind: Exclude<DecisionResourceKind, 'runtime' | 'runtime-gguf'>; name: string; description: string; size_bytes: number }
export interface DecisionProxy { model?: string; enabled: boolean; access_key_set: boolean; local_url: string; lan_url: string; remote_url: string }
export interface DecisionEnvironment { supported: boolean; reasons: string[]; cpu_cores?: number; memory_total_bytes?: number; memory_available_bytes?: number; disk_free_bytes?: number }
export interface DecisionStatus { models?: DecisionModel[]; environment?: DecisionEnvironment; proxy?: DecisionProxy; settings: DecisionSettings; root: string; platform: string; worker: string; resources: Record<'runtime' | 'model', DecisionResource> & Partial<Record<DecisionResourceKind, DecisionResource>> }
export interface DiscoveredDecisionModel { id: string; url: string; license: string; languages: string[]; parameters: number | null; size_bytes?: number; library: string; gated: boolean; supported: boolean; managed_model: string | null }
export interface DecisionCatalogResults { models: DiscoveredDecisionModel[]; limit: number }
export interface DecisionModelSource { mode: 'local' | 'remote'; base_url: string; api_key: string | null }
export interface DecisionTestResult { success: boolean; elapsed_ms: number; mode: DecisionMode }
const options = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
export const decisionModelsApi = {
  status: () => request<DecisionStatus>('/decision-models'),
  save: (draft: DecisionDraft) => request<DecisionStatus>('/decision-models/settings', options('PUT', draft)),
  test: (draft: DecisionDraft, signal?: AbortSignal) => request<DecisionTestResult>('/decision-models/test', { ...options('POST', draft), signal }),
  searchCatalog: (query: string, signal?: AbortSignal) => request<DecisionCatalogResults>(`/decision-models/catalog/search?q=${encodeURIComponent(query)}`, { signal }),
  models: (source: DecisionModelSource, signal?: AbortSignal) => request<{ models: string[] }>('/decision-models/models', { ...options('POST', source), signal }),
  download: (kind: DecisionResourceKind) => request<DecisionStatus>(`/decision-models/resources/${kind}/download`, options('POST')),
  cancel: (kind: DecisionResourceKind) => request<DecisionStatus>(`/decision-models/resources/${kind}/cancel`, options('POST')),
  delete: (kind: DecisionResourceKind) => request<DecisionStatus>(`/decision-models/resources/${kind}`, options('DELETE')),
  release: () => request<DecisionStatus>('/decision-models/release', options('POST')),
}

export const decisionResourceBusy = (resource: DecisionResource) => ['resolving', 'downloading', 'installing', 'verifying'].includes(resource.stage)

export function validDecisionEndpoint(value: string) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash }
  catch { return false }
}

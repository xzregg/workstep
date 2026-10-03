import { browserActorHeaders } from '../utils/browserActor'
import { BASE, fileDataUrl, request } from './transport'
import type { Task } from './task'
import type { AssistantConfigInfo, AssistantSaveResult } from './engine'
export { ApiError, FULL_PAGE_LIMIT, request, shareRequest } from './transport'
export * from './share'
export * from './statistics'
export * from './schedule'
export * from './task'
export * from './engine'
export * from './project'
export * from './conversations'

export interface SystemSettings {
  git_scan_depth: number
  user_name: string
  open_mode: boolean
  default_project_directory: string
  device_id?: string
  device_name?: string
}

export type ModelType = 'chat' | 'reasoning' | 'embedding' | 'rerank' | 'image' | 'audio'

export interface ModelPrice {
  provider_id: string | null
  engine_id: string | null
  model: string
  model_type: ModelType
  supports_multimodal: boolean
  input_price: number
  output_price: number
  cache_price: number
}

export interface ModelPricingSettings {
  currency: 'USD' | 'CNY'
  usd_to_cny_rate: number
  prices: ModelPrice[]
  providers: {
    id: string
    name: string
    models: { id: string; label: string; description: string }[]
  }[]
  engines: {
    id: string
    models: { id: string; label: string; description: string }[]
  }[]
  standalone_models: string[]
}

export type ModelSetting = ModelPrice
export type ModelSettings = ModelPricingSettings

export const systemSettingsApi = {
  updateGitScanDepth: (depth: number) => request<SystemSettings>('/system-settings', {
    method: 'PUT',
    body: JSON.stringify({ git_scan_depth: depth }),
  }),
  get: () => request<SystemSettings>('/system-settings'),
  updateDefaultProjectDirectory: (directory: string) => request<SystemSettings>('/system-settings', {
    method: 'PUT',
    body: JSON.stringify({ default_project_directory: directory }),
  }),
  updateUserName: (userName: string) => request<SystemSettings>('/system-settings', {
    method: 'PUT',
    body: JSON.stringify({ user_name: userName }),
  }),
  updateOpenMode: (openMode: boolean) => request<SystemSettings>('/system-settings', {
    method: 'PUT',
    body: JSON.stringify({ open_mode: openMode }),
  }),
  modelPricing: () => request<ModelPricingSettings>('/system-settings/model-pricing'),
  saveModelPricing: (settings: Omit<ModelPricingSettings, 'providers' | 'engines' | 'standalone_models'>) =>
    request<ModelPricingSettings>('/system-settings/model-pricing', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
  modelSettings: () => request<ModelSettings>('/system-settings/model-settings'),
  saveModelSettings: (settings: Omit<ModelSettings, 'providers' | 'engines' | 'standalone_models'>) =>
    request<ModelSettings>('/system-settings/model-settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
}

// --- Template API ---

export interface TemplateInfo {
  id: string
  name: string
  description: string
  nodeCount: number
  custom?: boolean
  /** Shipped default template seeded to ~/.workstep/data/templates/ (editable in place). */
  default?: boolean
  steps?: any
}

// --- Template list cache ---
// Template consumers (settings, workflow dialog, canvas) share one cached
// list; only mutations invalidate it and a forced fetch hits the API again.

let templatesCache: { templates: TemplateInfo[] } | null = null
let templatesInflight: Promise<{ templates: TemplateInfo[] }> | null = null

export function getCachedTemplates(): { templates: TemplateInfo[] } | null {
  return templatesCache
}

export async function fetchTemplates(
  force = false,
): Promise<{ templates: TemplateInfo[] }> {
  if (!force) {
    if (templatesCache) return templatesCache
    if (templatesInflight) return templatesInflight
  }
  const promise = templateApi.list().then((result) => {
    templatesCache = result
    return result
  })
  templatesInflight = promise
  try {
    return await promise
  } finally {
    if (templatesInflight === promise) templatesInflight = null
  }
}

export function invalidateTemplates(): void {
  templatesCache = null
  templatesInflight = null
}

export const templateApi = {
  list: () => request<{ templates: TemplateInfo[] }>('/templates/list'),
  get: (id: string) => request<TemplateInfo>(`/templates/${encodeURIComponent(id)}`),
  save: (template: {
    id: string
    name: string
    description: string
    steps: any
  }) => request<{ saved: boolean; id: string }>('/templates/save', {
    method: 'POST',
    body: JSON.stringify(template),
  }),
  del: (id: string) =>
    request<{ deleted: boolean; id: string }>(`/templates/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
}

// --- Assistant API ---

export interface EnhanceConfigResult {
  provider_id: string
  model: string
  protocol: string
  providers: {
    id: string
    name: string
    type: string
    base_url: string
    protocols: string[]
    enabled: boolean
  }[]
}

export interface ConcurrencyConfig {
  max_tasks: number
  max_chats: number
  schedule_exempt: boolean
}

export interface ProjectConcurrencyResult {
  global: ConcurrencyConfig
  project: {
    max_tasks: number | null
    max_chats: number | null
    schedule_exempt: boolean | null
  }
  effective: ConcurrencyConfig
}

export interface ProjectSettingsResult {
  name: string
  path: string
  chat_system_prompt: string
  quick_buttons: unknown[]
  concurrency: {
    global: ConcurrencyConfig
    project: {
      max_tasks: number | null
      max_chats: number | null
      schedule_exempt: boolean | null
    }
    effective: ConcurrencyConfig
  }
  share?: { active_invites: number; devices: unknown[] }
}

export const assistantApi = {
  list: () => request<{ assistants: AssistantConfigInfo[] }>('/assistant/list'),
  enhanceConfig: () => request<EnhanceConfigResult>('/assistant/enhance-config'),
  setEnhanceConfig: (config: { providerId: string; model: string; protocol: string }) =>
    request<{ saved: boolean; provider_id: string; model: string; protocol: string }>(
      '/assistant/enhance-config',
      {
        method: 'PUT',
        body: JSON.stringify({
          provider_id: config.providerId,
          model: config.model,
          protocol: config.protocol,
        }),
      },
    ),
  concurrencyConfig: () =>
    request<ConcurrencyConfig & { saved: boolean }>('/assistant/concurrency'),
  setConcurrencyConfig: (config: ConcurrencyConfig) =>
    request<ConcurrencyConfig & { saved: boolean }>('/assistant/concurrency', {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
  setConfig: (
    name: string,
    config: {
      engine: string
      model?: string
      fastModel?: string
      visionModel?: string
      thinkingEffort?: string
      providerId?: string
    },
  ) =>
    request<AssistantSaveResult>(
      `/assistant/${encodeURIComponent(name)}/config`,
      {
        method: 'PUT',
        body: JSON.stringify({
          engine: config.engine,
          model: config.model ?? '',
          fast_model: config.fastModel ?? '',
          vision_model: config.visionModel ?? '',
          thinking_effort: config.thinkingEffort ?? '',
          provider_id: config.providerId ?? '',
        }),
      },
    ),
}

// --- File System API ---

export interface FilePreview {
  type: 'text' | 'image' | 'binary'
  content_type: string
  content: string
  file_size: number
  extension?: string
  relative_path?: string | null
}

export interface DirectoryOpener {
  id: string
  label: string
  available: boolean
}

export interface DirectoryEntry {
  name: string
  type: 'directory' | 'file'
  path: string
  relative_path?: string | null
}

export interface DirectoryBrowseResult {
  path: string
  name: string
  parent: string | null
  relative_path?: string | null
  parent_relative_path?: string | null
  entries: DirectoryEntry[]
}

export interface FileSearchResult {
  query: string
  truncated: boolean
  entries: DirectoryEntry[]
}

export const fsApi = {
  readMemory: (projectId: string) =>
    request<{ path: string; content: string }>(
      `/fs/memory?project_id=${encodeURIComponent(projectId)}`
    ),
  saveMemory: (projectId: string, content: string) =>
    request<{ path: string; saved: boolean }>(
      `/fs/memory?project_id=${encodeURIComponent(projectId)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ content }),
      }
    ),
  uploadImage: async (file: File, projectId: string, prefix?: string) => {
    const dataUrl = await fileDataUrl(file)
    const res = await fetch(
      `${BASE}/fs/upload/image?project_id=${encodeURIComponent(projectId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...browserActorHeaders() },
        body: JSON.stringify({ filename: file.name, data_url: dataUrl, prefix }),
      }
    )
    if (!res.ok) throw new Error('Upload failed')
    const data = await res.json()
    return data as { url: string; filename: string; size: number }
  },
  uploadFile: async (file: File, projectId: string, prefix?: string) => {
    const dataUrl = await fileDataUrl(file)
    const res = await fetch(
      `${BASE}/fs/upload/file?project_id=${encodeURIComponent(projectId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...browserActorHeaders() },
        body: JSON.stringify({ filename: file.name, data_url: dataUrl, prefix }),
      }
    )
    if (!res.ok) throw new Error('Upload failed')
    const data = await res.json()
    return data as { url: string; filename: string; size: number }
  },

  preview: (path: string, projectId?: string) => request<FilePreview>(`/fs/preview?path=${encodeURIComponent(path)}${projectId ? `&project_id=${encodeURIComponent(projectId)}` : ''}${path.startsWith('/') ? '&absolute=true' : ''}`),
  browse: (path?: string, projectId?: string, includeHidden = false) => {
    const params = new URLSearchParams()
    if (path) params.set('path', path)
    if (projectId) params.set('project_id', projectId)
    if (includeHidden) params.set('include_hidden', 'true')
    const query = params.toString()
    return request<DirectoryBrowseResult>(`/fs/browse${query ? `?${query}` : ''}`)
  },
  search: (query: string, projectId?: string, root?: string, includeHidden = false) => {
    const params = new URLSearchParams({ query })
    if (projectId) params.set('project_id', projectId)
    if (root) params.set('root', root)
    if (includeHidden) params.set('include_hidden', 'true')
    return request<FileSearchResult>(`/fs/search?${params.toString()}`)
  },
  uploadToDirectory: async (file: File, projectId: string, root: string | undefined, parent: string) =>
    request<{ path: string; name: string; size: number }>('/fs/browser-upload', {
      method: 'POST', body: JSON.stringify({ project_id: projectId, root, parent, filename: file.name, data_url: await fileDataUrl(file) }),
    }),
  createEntry: (projectId: string, root: string | undefined, parent: string, name: string, kind: 'file' | 'directory') =>
    request<{ path: string; name: string; kind: 'file' | 'directory' }>('/fs/entry', {
      method: 'POST', body: JSON.stringify({ project_id: projectId, root, parent, name, kind }),
    }),
  renameEntry: (projectId: string, root: string | undefined, path: string, name: string) =>
    request<{ path: string; name: string }>('/fs/entry', {
      method: 'PATCH', body: JSON.stringify({ project_id: projectId, root, path, name }),
    }),
  deleteEntry: (projectId: string, root: string | undefined, path: string) =>
    request<{ deleted: boolean }>('/fs/entry', {
      method: 'DELETE', body: JSON.stringify({ project_id: projectId, root, path }),
    }),
  saveContent: (projectId: string, root: string | undefined, path: string, content: string, expectedContent: string) =>
    request<{ saved: boolean }>('/fs/content', {
      method: 'PUT', body: JSON.stringify({ project_id: projectId, root, path, content, expected_content: expectedContent }),
    }),
  mkdir: (parent: string, name: string) =>
    request<{ path: string; name: string }>('/fs/mkdir', {
      method: 'POST',
      body: JSON.stringify({ parent, name }),
    }),
  fileUrl: (path: string, projectId?: string) =>
    `${BASE}/fs/raw/${path
      .replace(/^\/+/, '')
      .split('/')
      .map(encodeURIComponent)
      .join('/')}${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`,
  projectFileUrl: (path: string, projectId: string) => {
    const absolute = path.startsWith('/')
    const encodedPath = path
      .replace(/^\/+/, '')
      .split('/')
      .map(encodeURIComponent)
      .join('/')
    return `${BASE}/fs/project-raw/${encodeURIComponent(projectId)}/${encodedPath}?project_id=${encodeURIComponent(projectId)}${absolute ? '&absolute=true' : ''}`
  },
  directoryOpeners: () =>
    request<{ platform: string; openers: DirectoryOpener[] }>('/fs/directory-openers'),
  openDirectory: (path: string, opener = 'file_manager') =>
    request<{ opened: boolean; path: string }>('/fs/open-directory', {
      method: 'POST',
      body: JSON.stringify({ path, opener }),
    }),
  openSessionJournal: (projectId: string, sessionId?: string | null, messageId?: string | null) =>
    request<{ opened: boolean; path: string }>('/fs/open-session-journal', {
      method: 'POST',
      body: JSON.stringify({
        project_id: projectId,
        session_id: sessionId || null,
        message_id: messageId || null,
      }),
    }),
}

// --- Session/Search API ---

export interface Session {
  id: string
  title: string
  description: string | null
  status: string
  engine: string
  created_at: string
  updated_at: string
}

export const sessionApi = {
  list: (projectId: string | null, limit = 50, offset = 0) =>
    request<{ sessions: Session[]; limit: number; offset: number }>(
      `/sessions?${projectId ? `project_id=${encodeURIComponent(projectId)}&` : ''}limit=${limit}&offset=${offset}`
    ),
}

export interface SearchParams {
  query?: string
  status?: string
  engine?: string
  startDate?: string
  endDate?: string
  limit?: number
  offset?: number
}

export const searchApi = {
  tasks: (params: SearchParams) => {
    const url = new URL('/search/tasks', window.location.origin)
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.append(key, String(value))
      }
    })
    return request<{ tasks: Task[]; limit: number; offset: number }>(url.pathname + url.search)
  },
}

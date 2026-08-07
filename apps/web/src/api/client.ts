/** REST API client for the WorkStep daemon. */

const BASE = '/api'

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers || {}),
    },
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(detail.detail || `HTTP ${res.status}`)
  }
  return res.json()
}

// --- Project API ---

export interface WorkflowSummary {
  id: string
  name: string
  is_default: boolean
  deleted?: boolean
  running?: boolean
  nodeCount: number
}

export interface Project {
  id: string
  path: string
  name: string
  steps: any
  workflows: WorkflowSummary[]
}

export const projectApi = {
  list: () => request<{ projects: Project[] }>('/project/list'),
  init: (path: string, name?: string) =>
    request<Project>('/project/init', {
      method: 'POST',
      body: JSON.stringify({ path, name }),
    }),
  register: (path: string, name?: string) =>
    request<Project>('/project/register', {
      method: 'POST',
      body: JSON.stringify({ path, name }),
    }),
  rename: (path: string, name: string) =>
    request<Project>('/project/rename', {
      method: 'POST',
      body: JSON.stringify({ path, name }),
    }),
  saveSteps: (projectId: string, steps: any, workflowId?: string) =>
    request<{ saved: boolean }>(
      `/project/save-steps?project_id=${encodeURIComponent(projectId)}${workflowId ? `&workflow_id=${encodeURIComponent(workflowId)}` : ''}`,
      {
        method: 'POST',
        body: JSON.stringify({ steps }),
      },
    ),
}

// --- Workflow API ---

export interface WorkflowDetail {
  id: string
  name: string
  steps: any
  is_default: boolean
  created_at: string
  updated_at: string
}

export const workflowApi = {
  list: (projectId: string) =>
    request<{ workflows: WorkflowSummary[] }>(`/workflow/list?project_id=${encodeURIComponent(projectId)}`),
  get: (id: string, projectId: string) =>
    request<WorkflowDetail>(`/workflow/${encodeURIComponent(id)}?project_id=${encodeURIComponent(projectId)}`),
  create: (projectId: string, name: string, steps?: any, templateId?: string) =>
    request<WorkflowDetail>(`/workflow/create?project_id=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      body: JSON.stringify({ name, steps, template_id: templateId, is_default: false }),
    }),
  update: (id: string, projectId: string, name?: string, steps?: any) =>
    request<WorkflowDetail>(`/workflow/${encodeURIComponent(id)}?project_id=${encodeURIComponent(projectId)}`, {
      method: 'PUT',
      body: JSON.stringify({ name, steps }),
    }),
  delete: (id: string, projectId: string) =>
    request<{ deleted: boolean; soft?: boolean }>(`/workflow/${encodeURIComponent(id)}?project_id=${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
    }),
  restore: (id: string, projectId: string) =>
    request<WorkflowDetail>(`/workflow/${encodeURIComponent(id)}/restore?project_id=${encodeURIComponent(projectId)}`, {
      method: 'POST',
    }),
}

// --- Workflow generation chat API (AI-assisted flow design) ---

export interface WorkflowGenAccepted {
  session_id: string
  turn_id: string
  status: string
}

export const workflowGenApi = {
  chat: (
    projectId: string,
    content: string,
    sessionId: string | null,
    idempotencyKey: string,
    options: { engine?: string; model?: string; fastModel?: string } = {},
  ) =>
    request<WorkflowGenAccepted>(`/workflow/generate/chat`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({
        project_id: projectId,
        content,
        session_id: sessionId,
        engine: options.engine || undefined,
        model: options.model || undefined,
        fast_model: options.fastModel || undefined,
      }),
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

// --- Task API ---

export interface Task {
  id: string
  title: string
  description: string | null
  cwd: string
  status: string
  archived?: boolean
  engine: string
  model?: string | null
  coordinator_engine?: string | null
  coordinator_model?: string | null
  coordinator_fast_model?: string | null
  coordinator_session_id?: string | null
  active_workflow_run_id?: string | null
  run_round?: number
  restart_from_step_key?: string | null
  recovered_at?: string | null
  recovered_count?: number
  state_version?: number
  review_overrides?: Record<string, any> | null
  created_at: string
  updated_at: string
  steps: TaskStepState[]
}

export interface TaskStepState {
  step_key: string
  status: 'pending' | 'running' | 'reviewing' | 'awaiting_review' | 'retrying' | 'rework' | 'rework_waiting' | 'passed' | 'rejected' | 'failed' | 'cancelled' | 'skipped'
  engine: string | null
  session_id?: string | null
  started_at: string | null
  ended_at: string | null
  error: string | null
}

export interface ReviewRun {
  id: string
  workflow_run_id: string
  step_run_id: string
  step_key: string
  mode: 'auto' | 'manual'
  status: 'pending' | 'running' | 'passed' | 'rejected' | 'failed'
  engine: string | null
  model: string | null
  report: {
    passed: boolean
    score: number | null
    summary: string
    issues: Array<{
      severity: 'error' | 'warning'
      category: string
      description: string
      suggestion: string
    }>
  } | null
  decision: string | null
  decision_comment: string | null
  started_at: string | null
  ended_at: string | null
}

export interface TaskArtifact {
  step_key: string
  name: string
  logical_name: string | null
  artifact_type: string | null
  path: string
  relative_path: string
  size: number
}

export interface ActionProposal {
  id: string
  type: 'supplement_stage' | 'rerun_from_stage' | 'review_decision'
  target_step_key: string | null
  payload: Record<string, unknown>
  impact: { summary?: string; target_step_key?: string } | null
  status: 'pending' | 'executing' | 'succeeded' | 'failed' | 'cancelled' | 'expired'
  result: Record<string, unknown> | null
  error: string | null
}

export interface CoordinatorEngineSummary {
  id: string
  mode: 'cli' | 'acp' | 'api' | 'agent' | 'sdk' | null
  installed: boolean
  configured: boolean
  verified: boolean
  built_in: boolean
  supports_coordinator: boolean
}

export interface CoordinatorSelection {
  configured: {
    engine: string | null
    model: string | null
    fast_model: string | null
    vision_model: string | null
  }
  resolved: {
    engine: string
    model: string | null
    fast_model: string | null
    vision_model: string | null
  }
}

export interface CoordinatorConfig extends CoordinatorSelection {
  available_engines: CoordinatorEngineSummary[]
}

export const taskApi = {
  list: (projectId: string, workflowId?: string | null, archived?: boolean) =>
    request<{ tasks: Task[] }>(
      `/task/list?project_id=${encodeURIComponent(projectId)}${workflowId ? '&workflow_id=' + encodeURIComponent(workflowId) : ''}${archived ? '&archived=true' : ''}`
    ),
  create: (
    title: string,
    cwd: string,
    projectId: string,
    engine?: string,
    description?: string,
    startStepKey?: string | null,
    reviewOverrides?: Record<string, any> | null,
    workflowId?: string | null,
    autoStart?: boolean,
  ) =>
    request<Task>(`/task/create?project_id=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      body: JSON.stringify({
        title,
        cwd,
        engine,
        description,
        start_step_key: startStepKey,
        auto_start: autoStart,
        review_overrides: reviewOverrides,
        workflow_id: workflowId,
      }),
    }),
  get: (id: string, projectId: string) =>
    request<Task>(`/task/${id}?project_id=${encodeURIComponent(projectId)}`),
  updateDescription: (id: string, projectId: string, description: string | undefined, reviewOverrides?: Record<string, any> | null) =>
    request<Task>(`/task/${id}?project_id=${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ description, review_overrides: reviewOverrides }),
    }),
  history: (taskId: string, projectId: string, limit = 50, offset = 0) =>
    request<{ messages: any[]; limit: number; offset: number }>(
      `/task/${taskId}/history?project_id=${encodeURIComponent(projectId)}&limit=${limit}&offset=${offset}`
    ),
  chat: (taskId: string, content: string, projectId: string, idempotencyKey: string) =>
    request<{
      turn_id: string
      user_message_id: string
      assistant_message_id: string
      status: 'queued' | 'running' | 'succeeded' | 'failed'
    }>(`/task/${taskId}/chat?project_id=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ content }),
    }),
  stopCoordinator: (taskId: string, projectId: string) =>
    request<{ stopped: boolean }>(
      `/task/${taskId}/coordinator/stop?project_id=${encodeURIComponent(projectId)}`,
      { method: 'POST' },
    ),
  sendStageMessage: (taskId: string, stepKey: string, content: string, projectId: string, asGuidance = false) =>
    request<{ message_id: string; step_key: string; status: 'queued'; sequence?: number; created_at?: string }>(
      `/task/${taskId}/step/${encodeURIComponent(stepKey)}/message?project_id=${encodeURIComponent(projectId)}`,
      {
        method: 'POST',
        body: JSON.stringify({ content, as_guidance: asGuidance }),
      },
    ),
  cancelStep: (taskId: string, stepKey: string, projectId: string) =>
    request<{ cancelled: boolean }>(
      `/task/${taskId}/step/${encodeURIComponent(stepKey)}/cancel?project_id=${encodeURIComponent(projectId)}`,
      { method: 'POST' },
    ),
  coordinatorConfig: (taskId: string, projectId: string) =>
    request<CoordinatorConfig>(
      `/task/${taskId}/coordinator-config?project_id=${encodeURIComponent(projectId)}`,
    ),
  updateCoordinatorConfig: (
    taskId: string,
    projectId: string,
    engine: string | null,
    model: string | null,
    fastModel: string | null,
    visionModel: string | null,
  ) => request<CoordinatorSelection>(
    `/task/${taskId}/coordinator-config?project_id=${encodeURIComponent(projectId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ engine, model, fast_model: fastModel, vision_model: visionModel }),
    },
  ),
  confirmAction: (
    taskId: string,
    proposalId: string,
    projectId: string,
    idempotencyKey: string,
  ) => request<ActionProposal>(
    `/task/${taskId}/actions/${proposalId}/confirm?project_id=${encodeURIComponent(projectId)}`,
    { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey } },
  ),
  cancelAction: (taskId: string, proposalId: string, projectId: string) =>
    request<ActionProposal>(
      `/task/${taskId}/actions/${proposalId}/cancel?project_id=${encodeURIComponent(projectId)}`,
      { method: 'POST' },
    ),
  artifacts: (taskId: string, projectId: string) =>
    request<{ artifacts: TaskArtifact[] }>(
      `/task/${taskId}/artifacts?project_id=${encodeURIComponent(projectId)}`
    ),
  reviews: (taskId: string, projectId: string) =>
    request<{ reviews: ReviewRun[] }>(
      `/task/${taskId}/reviews?project_id=${encodeURIComponent(projectId)}`
    ),
  decideReview: (
    taskId: string,
    stepKey: string,
    reviewRunId: string,
    decision: 'approve' | 'reject' | 'force-approve',
    projectId: string,
    comment?: string,
  ) =>
    request<{ decision: string; resumed: boolean; run_id: string | null }>(
      `/task/${taskId}/steps/${stepKey}/review/${decision}?project_id=${encodeURIComponent(projectId)}`,
      {
        method: 'POST',
        body: JSON.stringify({ review_run_id: reviewRunId, comment }),
      },
    ),
  run: (taskId: string, prompt: string, projectId: string) =>
    request<{ status: string }>(`/task/run?project_id=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      body: JSON.stringify({ task_id: taskId, prompt }),
    }),
  cancel: (taskId: string) =>
    request<{ cancelled: boolean }>('/task/cancel', {
      method: 'POST',
      body: JSON.stringify({ task_id: taskId }),
    }),
  pause: (taskId: string, projectId: string) =>
    request<{ paused: boolean }>(`/task/pause?project_id=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      body: JSON.stringify({ task_id: taskId }),
    }),
  delete: (taskId: string, projectId: string) =>
    request<{ deleted: boolean }>(`/task/delete?project_id=${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
      body: JSON.stringify({ task_id: taskId }),
    }),
  archive: (taskId: string, projectId: string) =>
    request<{ archived: boolean }>(`/task/archive?project_id=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      body: JSON.stringify({ task_id: taskId }),
    }),
  unarchive: (taskId: string, projectId: string) =>
    request<{ unarchived: boolean }>(`/task/unarchive?project_id=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      body: JSON.stringify({ task_id: taskId }),
    }),
  copy: (taskId: string, projectId: string, newTitle: string) =>
    request<Task>(`/task/copy?project_id=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      body: JSON.stringify({ task_id: taskId, newTitle }),
    }),
}

// --- Engine API ---

export interface EngineInfo {
  id: string
  installed: boolean
  configured: boolean
  verified: boolean
  built_in: boolean
  version: string | null
  mode: 'cli' | 'acp' | 'api' | 'agent' | 'sdk' | null
  config: EngineConfigPayload | null
  supports_resume: boolean
  supports_coordinator: boolean
  supports_tool_disable: boolean
  supports_native_schema: boolean
  supports_live_stage_message: boolean
  binary_path: string | null
  configured_path: string | null
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
  available_engines: CoordinatorEngineSummary[]
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
  error: string | null
}

export interface EngineConfigOption {
  value: string
  label: string
}

export interface EngineConfigField {
  key: string
  label: string
  type: 'text' | 'password' | 'select' | 'textarea' | 'number' | 'checkbox'
  placeholder: string
  options: EngineConfigOption[] | null
  required: boolean
  help: string
  default: string | number | boolean
  sensitive: boolean
  confirm_values: string[]
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
  values: Record<string, string>
  secrets: Record<string, boolean>
}

export interface EngineConfigSaveInput {
  values: Record<string, string>
  clear?: Record<string, boolean>
  confirmed?: Record<string, boolean>
}

// --- Engine model list cache ---
// Model dropdowns fetch each engine's model list once and reuse the result
// across pages. Only a manual refresh (force = true) hits the remote API
// again; invalidateEngineModels() clears the cache when the engine's config
// or binary path changes.

const engineModelsCache = new Map<string, EngineModelsResult>()

export function getCachedEngineModels(engineId: string): EngineModelsResult | null {
  return engineModelsCache.get(engineId) ?? null
}

export async function fetchEngineModels(
  engineId: string,
  force = false,
): Promise<EngineModelsResult> {
  const cached = engineModelsCache.get(engineId)
  if (cached && !force) return cached
  const result = await engineApi.models(engineId)
  engineModelsCache.set(engineId, result)
  return result
}

export function invalidateEngineModels(engineId: string): void {
  engineModelsCache.delete(engineId)
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
  coordinatorDefaults: () =>
    request<CoordinatorDefaultConfig>('/engine/coordinator/config'),
  setCoordinatorDefaults: (engine: string, model: string, fastModel: string, visionModel: string) =>
    request<{ saved: boolean; engine: string; model: string; fast_model: string; vision_model: string }>(
      '/engine/coordinator/config',
      {
        method: 'PUT',
        body: JSON.stringify({ engine, model, fast_model: fastModel, vision_model: visionModel }),
      },
    ),
  test: (engineId: string) =>
    request<EngineTestResult>('/engine/test', {
      method: 'POST',
      body: JSON.stringify({ engine_id: engineId }),
    }),
  models: (engineId: string) =>
    request<EngineModelsResult>(`/engine/${encodeURIComponent(engineId)}/models`),
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
}

// --- File System API ---

export interface FilePreview {
  type: 'text' | 'image' | 'binary'
  content_type: string
  content: string
  file_size: number
  extension?: string
}

export interface DirectoryOpener {
  id: string
  label: string
  available: boolean
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
    // Convert file to base64 data URL, then upload as JSON
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
    const res = await fetch(
      `${BASE}/fs/upload/image?project_id=${encodeURIComponent(projectId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, data_url: dataUrl, prefix }),
      }
    )
    if (!res.ok) throw new Error('Upload failed')
    const data = await res.json()
    return data as { url: string; filename: string; size: number }
  },

  preview: (path: string) => request<FilePreview>(`/fs/preview?path=${encodeURIComponent(path)}`),
  directoryOpeners: () =>
    request<{ platform: string; openers: DirectoryOpener[] }>('/fs/directory-openers'),
  openDirectory: (path: string, opener = 'file_manager') =>
    request<{ opened: boolean; path: string }>('/fs/open-directory', {
      method: 'POST',
      body: JSON.stringify({ path, opener }),
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

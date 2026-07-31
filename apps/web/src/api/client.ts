/** REST API client for the WorkStep daemon. */

const BASE = '/api'

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
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
  created_at: number
  updated_at: number
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
}

// --- Template API ---

export interface TemplateInfo {
  id: string
  name: string
  description: string
  nodeCount: number
  custom?: boolean
  steps?: any
}

export const templateApi = {
  list: () => request<{ templates: TemplateInfo[] }>('/templates/list'),
  get: (id: string) => request<TemplateInfo>(`/templates/${encodeURIComponent(id)}`),
}

// --- Task API ---

export interface Task {
  id: string
  title: string
  description: string | null
  cwd: string
  status: string
  engine: string
  review_overrides?: Record<string, any> | null
  created_at: number
  updated_at: number
  steps: TaskStepState[]
}

export interface TaskStepState {
  step_key: string
  status: 'pending' | 'running' | 'reviewing' | 'awaiting_review' | 'retrying' | 'passed' | 'rejected' | 'failed' | 'skipped'
  engine: string | null
  started_at: number | null
  ended_at: number | null
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
  started_at: number | null
  ended_at: number | null
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

export const taskApi = {
  list: (projectId: string, workflowId?: string | null) =>
    request<{ tasks: Task[] }>(`/task/list?project_id=${encodeURIComponent(projectId)}${workflowId ? '&workflow_id=' + encodeURIComponent(workflowId) : ''}`),
  create: (
    title: string,
    cwd: string,
    projectId: string,
    engine = 'claude',
    description?: string,
    startStepKey?: string | null,
    reviewOverrides?: Record<string, any> | null,
    workflowId?: string | null,
  ) =>
    request<Task>(`/task/create?project_id=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      body: JSON.stringify({
        title,
        cwd,
        engine,
        description,
        start_step_key: startStepKey,
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
  version: string | null
  mode: 'cli' | 'acp' | 'api' | null
  supports_resume: boolean
  binary_path: string | null
  configured_path: string | null
}

export interface EngineTestResult {
  engine_id: string
  success: boolean
  message: string
  duration_ms: number
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

export const engineApi = {
  list: () => request<{ engines: EngineInfo[] }>('/engine/list'),
  refresh: () =>
    request<{ engines: EngineInfo[] }>('/engine/refresh', { method: 'POST' }),
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
  created_at: number
  updated_at: number
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

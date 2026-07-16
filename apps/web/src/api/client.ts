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

export interface Project {
  id: string
  path: string
  name: string
  steps: any
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
}

// --- Task API ---

export interface Task {
  id: string
  title: string
  description: string | null
  cwd: string
  status: string
  engine: string
  created_at: number
  updated_at: number
}

export const taskApi = {
  list: (projectId: string) =>
    request<{ tasks: Task[] }>(`/task/list?project_id=${encodeURIComponent(projectId)}`),
  create: (title: string, cwd: string, projectId: string, engine = 'claude') =>
    request<Task>(`/task/create?project_id=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      body: JSON.stringify({ title, cwd, engine }),
    }),
  get: (id: string, projectId: string) =>
    request<Task>(`/task/${id}?project_id=${encodeURIComponent(projectId)}`),
  history: (taskId: string, projectId: string, limit = 50, offset = 0) =>
    request<{ messages: any[]; limit: number; offset: number }>(
      `/task/${taskId}/history?project_id=${encodeURIComponent(projectId)}&limit=${limit}&offset=${offset}`
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
}

// --- Engine API ---

export interface EngineInfo {
  id: string
  installed: boolean
  version: string | null
}

export const engineApi = {
  list: () => request<{ engines: EngineInfo[] }>('/engine/list'),
}

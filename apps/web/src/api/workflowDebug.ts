import { request } from './transport'

export interface DebugOutput { name?: string; type?: string; template?: string }
export interface DebugNode { id: number; type: string; title?: string; outputs?: DebugOutput[] }
export interface DebugWorkflow {
  nodes: DebugNode[]
  connections: { from: number; to: number; fromPort?: number; kind?: string }[]
}
export interface DebugRecord { id: string; title: string; status: string; created_at: string }
export interface DebugHistory { workflow_id: string | null; workflow: DebugWorkflow | null; tasks: DebugRecord[] }

const base = (project: string, source: string, suffix = '') =>
  `/workflow-debug/${encodeURIComponent(source)}${suffix}?project_id=${encodeURIComponent(project)}`
const json = (method: 'POST' | 'PUT', body: unknown) => ({ method, body: JSON.stringify(body) })

export const workflowDebugApi = {
  history: (project: string, source: string) => request<DebugHistory>(base(project, source)),
  start: (project: string, source: string, body: {
    workflow: DebugWorkflow; title: string; description: string; step_key: string
    samples: { step_key: string; port: number; content: string }[]
  }) => request<{ id: string; workflow_id: string; start_error?: string }>(base(project, source, '/start'), json('POST', body)),
  restart: (project: string, source: string, task: string, body: {
    step_key: string; instruction: string; samples: { step_key: string; port: number; content: string }[]
  }) => request<{ started: boolean }>(base(project, source, `/tasks/${encodeURIComponent(task)}/restart`), json('POST', body)),
  save: (project: string, source: string, workflow: DebugWorkflow) =>
    request<{ workflow_id: string }>(base(project, source, '/configuration'), json('PUT', { workflow })),
  stop: (project: string, source: string, task: string) =>
    request<{ stopped: boolean }>(base(project, source, `/tasks/${encodeURIComponent(task)}/stop`), { method: 'POST' }),
  delete: (project: string, source: string, task?: string) =>
    request<{ deleted: number }>(base(project, source, task ? `/tasks/${encodeURIComponent(task)}` : ''), { method: 'DELETE' }),
}

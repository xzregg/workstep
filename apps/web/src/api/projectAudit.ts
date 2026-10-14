import { request } from './transport'

export interface ProjectAuditItem {
  id: string; action: string; result: string; task_id: string | null
  actor_id: string | null; actor_username: string | null; actor_name: string | null
  created_at: string; metadata: Record<string, string | number | boolean>
}
export interface ProjectAuditPage {
  items: ProjectAuditItem[]; next_before: string | null; retention_days: number
}
export const projectAuditApi = {
  list(projectId: string, filters: { action?: string; result?: string; before?: string; signal?: AbortSignal } = {}) {
    const query = new URLSearchParams({ project_id: projectId, remote_only: 'true', limit: '50' })
    for (const key of ['action', 'result', 'before'] as const) if (filters[key]) query.set(key, filters[key]!)
    return request<ProjectAuditPage>(`/project-audit?${query}`, { signal: filters.signal })
  },
}

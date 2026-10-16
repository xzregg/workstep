import { request } from './transport'

export interface TaskWorkflowConfiguration {
  workflow: any
  source: any
  revision: string
  editable: boolean
  has_overrides: boolean
  conflict: string | null
  overrides?: Record<string, any> | null
}

const path = (taskId: string, projectId: string, suffix = '') =>
  `/task/${encodeURIComponent(taskId)}/workflow${suffix}?project_id=${encodeURIComponent(projectId)}`

export const taskWorkflowApi = {
  get: (taskId: string, projectId: string) => request<TaskWorkflowConfiguration>(path(taskId, projectId)),
  save: (taskId: string, projectId: string, workflow: any, revision: string, contextMode = 'smart') =>
    request<TaskWorkflowConfiguration>(path(taskId, projectId), {
      method: 'PUT', body: JSON.stringify({ workflow, revision, context_mode: contextMode }),
    }),
  sync: (taskId: string, projectId: string, revision: string) =>
    request<TaskWorkflowConfiguration>(path(taskId, projectId, '/sync'), {
      method: 'POST', body: JSON.stringify({ revision }),
    }),
}

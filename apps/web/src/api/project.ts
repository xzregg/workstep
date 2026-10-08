import { request } from './transport'
import type { ProjectConcurrencyResult, ProjectSettingsResult } from './client'
import { isGatewayRemoteBrowser } from '../utils/gatewayRemote'
import { useGatewaySessionStore } from '../stores/gatewaySessionStore'

// --- Project API ---

export interface WorkflowSummary {
  id: string
  name: string
  is_default: boolean
  deleted?: boolean
  running?: boolean
  failed?: boolean
  nodeCount: number
}

export interface Project {
  id: string
  path: string
  name: string
  steps: any
  workflows: WorkflowSummary[]
  /** Backend aggregate: any running workflow task OR live chat turn. */
  follow_project?: boolean
  data_path?: string
  has_running_tasks?: boolean
  type?: 'local' | 'remote'
  connection_status?: 'local' | 'connecting' | 'connected' | 'disconnected' | 'error'
  access_status?: 'pending' | 'active' | 'expired' | 'revoked'
  access_expires_at?: number | null
  endpoint?: string
  host_project_id?: string
}

export interface ProjectPublicationStatus {
  project_id: string | null
  status: 'published' | 'unpublished'
  grants: {
    subject_type: 'user' | 'group'
    subject_id: string
    subject_name: string
    access_level: 'read' | 'edit'
  }[]
  can_manage: boolean
  can_publish: boolean
  gateway_url: string
}

export const projectApi = {
  list: async (): Promise<{ projects: Project[] }> => {
    if (isGatewayRemoteBrowser()) {
      const session = await useGatewaySessionStore.getState().load()
      if (session.host_project_id) {
        const project = await request<Project>(`/project/${encodeURIComponent(session.host_project_id)}/summary`)
        if (project.id !== session.host_project_id) throw new Error('远程项目响应与当前授权不匹配。')
        return { projects: [{ ...project, path: '' }] }
      }
    }
    return request<{ projects: Project[] }>('/project/list')
  },
  init: (path: string, name?: string, followProject = true) =>
    request<Project>('/project/init', {
      method: 'POST',
      body: JSON.stringify({ path, name, follow_project: followProject }),
    }),
  storage: (projectId: string) => request<{ follow_project: boolean; data_path: string }>(`/project/${encodeURIComponent(projectId)}/storage`),
  setStorage: (projectId: string, followProject: boolean) => request<{ follow_project: boolean; data_path: string; warning?: string }>(`/project/${encodeURIComponent(projectId)}/storage`, {
    method: 'PUT', body: JSON.stringify({ follow_project: followProject }),
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
  reorder: (orderedIds: string[]) =>
    request<{ reordered: boolean }>('/project/reorder', {
      method: 'POST',
      body: JSON.stringify({ ordered_ids: orderedIds }),
    }),
  delete: (projectId: string) =>
    request<{ deleted: boolean }>(`/project/${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
    }),
  publication: async (projectId: string): Promise<ProjectPublicationStatus> => {
    const session = useGatewaySessionStore.getState().session
    if (session?.host_project_id) {
      if (session.host_project_id !== projectId) throw new Error('项目不在当前授权范围内。')
      const result = await request<Pick<ProjectPublicationStatus, 'grants'>>('/remote/project-grants')
      return { ...result, project_id: session.project_id, status: 'published',
        can_publish: false, can_manage: !!session.can_manage_project_access,
        gateway_url: session.gateway_url.replace(/\/devices$/, '') }
    }
    return request<ProjectPublicationStatus>(`/project/${encodeURIComponent(projectId)}/publication`)
  },
  setPublication: (projectId: string, published: boolean) => request<{
    project_id: string | null; status: 'published' | 'unpublished'
  }>(`/project/${encodeURIComponent(projectId)}/publication`, {
    method: 'POST', body: JSON.stringify({ published }),
  }),
  saveSteps: (projectId: string, steps: any, workflowId?: string) =>
    request<{ saved: boolean }>(
      `/project/save-steps?project_id=${encodeURIComponent(projectId)}${workflowId ? `&workflow_id=${encodeURIComponent(workflowId)}` : ''}`,
      {
        method: 'POST',
        body: JSON.stringify({ steps }),
      },
    ),
  settings: (projectId: string, withShare = false) =>
    request<ProjectSettingsResult>(
      `/projects/${encodeURIComponent(projectId)}/settings${withShare ? '?with_share=true' : ''}`,
    ),
  concurrency: (projectId: string) =>
    request<ProjectConcurrencyResult>(
      `/projects/${encodeURIComponent(projectId)}/settings/concurrency`,
    ),
  setConcurrency: (
    projectId: string,
    config: {
      maxTasks: number | null
      maxChats: number | null
      scheduleExempt: boolean | null
    },
  ) =>
    request<{ saved: boolean; project: ProjectConcurrencyResult['project'] }>(
      `/projects/${encodeURIComponent(projectId)}/settings/concurrency`,
      {
        method: 'PUT',
        body: JSON.stringify({
          max_tasks: config.maxTasks,
          max_chats: config.maxChats,
          schedule_exempt: config.scheduleExempt,
        }),
      },
    ),
}

export type SkillSyncStatus = 'disabled' | 'synced' | 'error' | 'missing'

export interface SkillDescriptor {
  skill_id: string
  name: string
  description: string
  source: 'agents' | 'claude' | 'codex' | 'project' | string
  source_path: string
  valid: boolean
  error?: string | null
  enabled: boolean
  sync_status: SkillSyncStatus
  sync_error?: string | null
  conflict: boolean
  ui?: Record<string, unknown>
  runtime_path?: string | null
}

export interface ProjectSkillSelection {
  project_id: string
  project_name: string
  project_path: string
  skills: SkillDescriptor[]
  compatible_engines: string[]
  takes_effect: 'next_run'
}

export const skillApi = {
  list: (projectId: string) => request<ProjectSkillSelection>(
    `/skills?project_id=${encodeURIComponent(projectId)}`,
  ),
  rescan: (projectId: string) => request<ProjectSkillSelection>(
    `/skills/rescan?project_id=${encodeURIComponent(projectId)}`,
    { method: 'POST' },
  ),
  setEnabled: (projectId: string, skillId: string, enabled: boolean) =>
    request<ProjectSkillSelection>(`/skills/projects/${encodeURIComponent(projectId)}`, {
      method: 'PUT',
      body: JSON.stringify({ skill_id: skillId, enabled }),
    }),
  setEnabledBatch: (projectId: string, skillIds: string[], enabled: boolean) =>
    request<ProjectSkillSelection>(`/skills/projects/${encodeURIComponent(projectId)}/batch`, {
      method: 'PUT',
      body: JSON.stringify({ skill_ids: skillIds, enabled }),
    }),
}

export interface RemoteAccessSettings {
  enabled: boolean
  internal_base_url: string
  external_base_url: string
  host_id: string
  access_password_set?: boolean
}

export interface RemoteAccessStatus {
  required: boolean
  local: boolean
  authorized: boolean
}

export interface RemoteDevice {
  project_id: string
  device_id: string
  user_name: string
  device_name: string
  revoked: boolean
  status: 'active' | 'expired' | 'revoked'
  connected: boolean
  authorized_at: number
  expires_at: number | null
  last_seen_at: number
}

export const remoteProjectApi = {
  settings: () => request<RemoteAccessSettings>('/remote-project/settings'),
  updateSettings: (
    settings: Omit<RemoteAccessSettings, 'host_id' | 'access_password_set'> & {
      access_password?: string
    },
  ) =>
    request<RemoteAccessSettings>('/remote-project/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
  accessStatus: () => request<RemoteAccessStatus>('/remote-project/access/status'),
  unlock: (password: string) =>
    request<{ authorized: boolean }>('/remote-project/access/unlock', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  createShare: (projectId: string, access: 'internal' | 'external', accessExpiresAt: number | null = null) =>
    request<{ share_string: string; endpoint: string; expires_at: number; access_expires_at: number | null }>('/remote-project/share', {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId, access, access_expires_at: accessExpiresAt }),
    }),
  add: (shareString: string) => request<Project>('/remote-project/add', {
    method: 'POST',
    body: JSON.stringify({ share_string: shareString }),
  }),
  remove: (projectId: string) =>
    request<{ deleted: boolean }>(`/remote-project/${encodeURIComponent(projectId)}`, { method: 'DELETE' }),
  devices: (projectId?: string) =>
    request<{ devices: RemoteDevice[]; connected_count: number }>(
      `/remote-project/devices/list${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`,
    ),
  revokeDevice: (projectId: string, deviceId: string) =>
    request<{ revoked: boolean }>('/remote-project/devices/revoke', {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId, device_id: deviceId }),
    }),
  updateDeviceAccess: (projectId: string, deviceId: string, expiresAt: number | null) =>
    request<{ device: RemoteDevice }>('/remote-project/devices/access', {
      method: 'PATCH',
      body: JSON.stringify({ project_id: projectId, device_id: deviceId, expires_at: expiresAt }),
    }),
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
  updateStepPrompt: (id: string, projectId: string, stepKey: string, prompt: string) =>
    request<{ steps: Project['steps'] }>(`/workflow/${encodeURIComponent(id)}/step/${encodeURIComponent(stepKey)}/prompt?project_id=${encodeURIComponent(projectId)}`, {
      method: 'PATCH', body: JSON.stringify({ prompt }),
    }),
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
  reorder: (projectId: string, orderedIds: string[]) =>
    request<{ ok: boolean }>(`/workflow/reorder?project_id=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      body: JSON.stringify({ ordered_ids: orderedIds }),
    }),
}

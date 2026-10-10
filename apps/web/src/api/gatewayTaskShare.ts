import { request, ApiError } from './transport'
import { gatewayFetch } from '../utils/gatewayWorkspacePath'
import type { ShareInfo } from './share'

async function mutation<T>(path: string, body?: unknown): Promise<T> {
  const response = await gatewayFetch('/api' + path, { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-WorkStep-Share-Intent': 'manage' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ detail: response.statusText }))
    throw new ApiError(typeof detail.detail === 'string' ? detail.detail : detail.error?.message || `HTTP ${response.status}`, response.status)
  }
  return response.status === 204 ? undefined as T : await response.json() as T
}

type Record = { id: string; title: string; mode: ShareInfo['mode']; status: string; created_at: string; url?: string }
export function createGatewayTaskShareApi(platformProjectId: string) {
  let currentId: string | null = null
  const urls = new Map<string, string>()
  const info = (record: Record, taskId: string): ShareInfo => {
    currentId = record.id
    if (record.url) urls.set(record.id, record.url)
    return { id: record.id, task_id: taskId, token: '', url: urls.get(record.id),
      title: record.title, mode: record.mode, revoked: record.status === 'revoked',
      has_password: false, created_at: record.created_at || '', revoked_at: null }
  }
  return {
    get: async (taskId: string, _projectId: string) => {
      const params = new URLSearchParams({ project_id: platformProjectId, task_id: taskId })
      const result = await request<{ shares: Record[] }>(`/remote/task-shares?${params}`)
      const active = result.shares.find(share => share.status === 'active' || share.status === 'paused')
      return active ? info(active, taskId) : null
    },
    create: async (taskId: string, _projectId: string, password: string | null, title: string | null,
      mode: ShareInfo['mode'], expiresAt?: string | null) => {
      const result = await mutation<Record>('/remote/task-shares', { project_id: platformProjectId, task_id: taskId,
        password, title: title || '', mode, expires_at: expiresAt || null })
      return info(result, taskId)
    },
    revoke: async (_taskId: string, _projectId: string) => {
      if (!currentId) throw new Error('分享记录不可用')
      await mutation(`/remote/task-shares/${encodeURIComponent(currentId)}/revoke`)
      urls.delete(currentId)
      currentId = null
    },
  }
}

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

type Record = { access_password?: string | null; id: string; title: string; mode: ShareInfo['mode']; status: string; created_at: string; url?: string; has_password?: boolean; expires_at?: string | null }
export function createGatewayTaskShareApi(platformProjectId: string, local = false, hostProject = false) {
  const basePath = local ? '/gateway-task-shares' : '/remote/task-shares'
  const targetField = hostProject ? 'host_project_id' : 'project_id'
  let currentId: string | null = null
  const urls = new Map<string, string>()
  const protectedShares = new Map<string, boolean>()
  const info = (record: Record, taskId: string): ShareInfo => {
    currentId = record.id
    if (record.url) urls.set(record.id, record.url)
    return { id: record.id, task_id: taskId, token: '', url: urls.get(record.id),
      access_password: record.access_password, title: record.title, mode: record.mode, revoked: record.status === 'revoked',
      has_password: record.has_password ?? protectedShares.get(record.id) ?? false, expires_at: record.expires_at, created_at: record.created_at || '', revoked_at: null }
  }
  return {
    get: async (taskId: string, _projectId: string) => {
      const params = new URLSearchParams({ [targetField]: platformProjectId, task_id: taskId })
      const result = await request<{ shares: Record[] }>(`${basePath}?${params}`)
      const active = result.shares.find(share => share.status === 'active' || share.status === 'paused')
      return active ? info(active, taskId) : null
    },
    create: async (taskId: string, _projectId: string, password: string | null, title: string | null,
      mode: ShareInfo['mode'], expiresAt?: string | null) => {
      const result = await mutation<Record>(basePath, { [targetField]: platformProjectId, task_id: taskId,
        password, title: title || '', mode, expires_at: expiresAt || null })
      protectedShares.set(result.id, !!password)
      return info(result, taskId)
    },
    revoke: async (_taskId: string, _projectId: string) => {
      if (!currentId) throw new Error('分享记录不可用')
      await mutation(`${basePath}/${encodeURIComponent(currentId)}/revoke${local ? `?project_id=${encodeURIComponent(platformProjectId)}` : ''}`)
      urls.delete(currentId)
      currentId = null
    },
  }
}

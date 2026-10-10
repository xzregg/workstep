import { request } from './transport'

export interface WorkflowHook {
  id?: string
  name: string
  enabled: boolean
  token?: string
  step_key: string
  default_title: string
  default_creator: string
  execution_mode: 'manual' | 'immediate'
  rotate_token?: boolean
}
export interface HookConfiguration {
  hooks: WorkflowHook[]
  device_id: string
  addresses: { kind: 'gateway' | 'internal' | 'external'; base_url: string }[]
  steps: { key: string; name: string }[]
  gateway_online: boolean
}
const path = (projectId: string, workflowId: string) => `/workflow/${encodeURIComponent(workflowId)}/hooks?project_id=${encodeURIComponent(projectId)}`
export const workflowHooksApi = {
  get: (projectId: string, workflowId: string) => request<HookConfiguration>(path(projectId, workflowId)),
  save: (projectId: string, workflowId: string, hooks: WorkflowHook[]) => request<HookConfiguration>(path(projectId, workflowId), { method: 'PUT', body: JSON.stringify({ hooks }) }),
}
export function buildHookUrl(base: string, deviceId: string, hook: WorkflowHook, overrides?: { title: string; creator: string }) {
  if (!hook.id || !hook.token) return ''
  const url = new URL(`${base.replace(/\/$/, '')}/api/hook/${encodeURIComponent(deviceId)}/${encodeURIComponent(hook.id)}`)
  url.searchParams.set('token', hook.token)
  if (hook.step_key) url.searchParams.set('step_key', hook.step_key)
  if (overrides?.title.trim()) url.searchParams.set('title', overrides.title.trim())
  if (overrides?.creator.trim()) url.searchParams.set('creator', overrides.creator.trim())
  return url.toString()
}

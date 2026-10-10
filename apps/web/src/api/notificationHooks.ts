import { request } from './transport'
import type { HookConfiguration } from './workflowHooks'

export type NotificationEvent = 'started' | 'completed' | 'failed' | 'paused' | 'stopped' | 'step_completed' | 'step_failed' | 'waiting'
export const notificationEvents: NotificationEvent[] = ['started','completed','failed','paused','stopped','step_completed','step_failed','waiting']
export interface NotificationHook {
  id?: string
  name: string
  platform: 'dingtalk' | 'wecom' | 'generic'
  url: string
  secret: string
  enabled: boolean
  events: NotificationEvent[]
  prefix: string
  include_link: boolean
  link_base: 'gateway' | 'external' | 'internal'
}
export interface NotificationConfiguration { hooks: NotificationHook[]; addresses: HookConfiguration['addresses'] }
export interface NotificationRecord {
  id: string; event: NotificationEvent | 'test'; title: string; status: 'pending' | 'sending' | 'sent' | 'failed' | 'skipped'
  attempts: number; created_at: number; updated_at: number; result: string; next_at: number
}
export interface NotificationPreview { payload: unknown; snapshot: { task: { title: string } }; subscribed: boolean }
const root = (workflowId: string) => `/workflow/${encodeURIComponent(workflowId)}/notification-hooks`
const path = (projectId: string, workflowId: string, suffix = '') => `${root(workflowId)}${suffix}?project_id=${encodeURIComponent(projectId)}`
export const notificationHooksApi = {
  get: (p: string, w: string) => request<NotificationConfiguration>(path(p,w)),
  save: (p: string, w: string, hooks: NotificationHook[]) => request<NotificationConfiguration>(path(p,w),{method:'PUT',body:JSON.stringify({hooks})}),
  preview: (p: string,w: string,hook: NotificationHook,event: NotificationEvent,title: string,step: string) => request<NotificationPreview>(path(p,w,'/preview'),{method:'POST',body:JSON.stringify({hook,event,title,step})}),
  test: (p: string,w: string,id: string) => request<{delivery_id:string}>(path(p,w,`/${encodeURIComponent(id)}/test`),{method:'POST'}),
  records: (p: string,w: string,id: string,offset = 0) => request<{deliveries:NotificationRecord[]}>(`${path(p,w,`/${encodeURIComponent(id)}/deliveries`)}&offset=${offset}`),
  retry: (p: string,w: string,id: string,deliveryId: string) => request<{delivery_id:string}>(path(p,w,`/${encodeURIComponent(id)}/deliveries/${encodeURIComponent(deliveryId)}/retry`),{method:'POST'}),
}

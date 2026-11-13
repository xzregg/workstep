import { request } from './transport'
export interface DigitalPersonProfile {
  enabled: boolean; name: string; role: string; personality: string; duties: string
  tone?: string
  role_binding?: {kind:'role'|'team';id:string} | null
  avatar: 'robot' | 'spark'; greeting: string
  conversation_rules?: string
  proactive_interval_minutes?: number
  proactive_enabled?: boolean; proactive_instruction?: string; quiet_start?: number; quiet_end?: number
  onboarding_completed?: boolean; show_panel?: boolean; floating?: boolean; auto_speak?: boolean
  voice_name?: string; voice_rate?: number; expression?: 'neutral' | 'happy' | 'concern'
}
export const digitalPersonApi = {
  mainSession: () => request<import('./conversations').ChatSessionDetail>('/digital-person/main-session', { method: 'POST' }),
  get: () => request<DigitalPersonProfile>('/digital-person'),
  save: (profile: DigitalPersonProfile) => request<DigitalPersonProfile>('/digital-person', { method: 'PUT', body: JSON.stringify(profile) }),
}

export interface VoiceWakeDraft { keyword: string; sensitivity: 'low' | 'balanced' | 'high' }
export interface VoiceWakeStatus extends VoiceWakeDraft { available: boolean; listening: boolean }
export const voiceWakeApi = {
  get: () => request<VoiceWakeStatus>('/digital-person/voice-wake'),
  save: (draft: VoiceWakeDraft) => request<VoiceWakeStatus>('/digital-person/voice-wake', { method: 'PUT', body: JSON.stringify(draft) }),
}

export interface DigitalPeer { id: string; conversation_type: 'single' | 'group'; conversation_id: string; bot_id: string; bot_name: string; title: string; platform: string; notify?: boolean }
export interface DigitalActivity {
  session_count?: number; reply_count?: number; task_count?: number; completed_task_count?: number
  skills?: Array<{id: string; name: string}>
  feedback: Record<string,number>; suggestions: Array<{id:string;label:string;prompt:string;count:number}>
  experience: number; level: number; next_level_experience: number; checking: boolean
  runs: Array<{ id: string; status: string; summary?: string; error?: string; created_at: string; sources: unknown; deliveries: unknown }>
  delegations: Array<{ id: string; project_id: string; session_id: string; instruction: string; status: string }>
  answers: Array<{ id: string; content: string; feedback: number }>
}
const json = (body: unknown, method = 'POST') => ({ method, body: JSON.stringify(body) })
export const digitalRuntimeApi = {
  retryDelivery: (id: string) => request(`/digital-person/runs/${encodeURIComponent(id)}/retry`,{method:'POST'}),
  stopDelegation: (id: string) => request(`/digital-person/delegations/${encodeURIComponent(id)}/stop`,{method:'POST'}),
  activity: () => request<DigitalActivity>('/digital-person/activity'),
  check: () => request('/digital-person/check', {method:'POST'}),
  stop: () => request('/digital-person/check/stop', {method:'POST'}),
  feedback: (message_id: string, value: number) => request<DigitalActivity>('/digital-person/feedback', json({message_id,value}, 'PUT')),
  delegate: (project_id: string, instruction: string, request_id: string) => request('/digital-person/delegate', json({project_id,instruction,request_id})),
  channels: () => request<{available: DigitalPeer[];bindings: DigitalPeer[]}>('/digital-person/channels'),
  bind: (peer: DigitalPeer, notify: boolean) => request('/digital-person/channels',json({bot_id:peer.bot_id,conversation_type:peer.conversation_type,conversation_id:peer.conversation_id,notify}, 'PUT')),
  unbind: (id: string) => request(`/digital-person/channels/${encodeURIComponent(id)}`,{method:'DELETE'}),
  test: (id: string) => request(`/digital-person/channels/${encodeURIComponent(id)}/test`,{method:'POST'}),
}

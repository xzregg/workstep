import { request } from './transport'
export interface DigitalPersonProfile {
  enabled: boolean; name: string; role: string; personality: string; duties: string
  relationship_style?: 'balanced' | 'warm' | 'reserved' | 'tsundere'
  relationship_preferences?: string
  tone?: string
  persona_markdown?: string | null
  role_binding?: {kind:'role'|'team';id:string} | null
  avatar: 'robot' | 'spark'; greeting: string
  conversation_rules?: string
  memory_batch_size?: number
  proactive_contact_interval_minutes?: number
  proactive_interval_minutes?: number
  delegation_interval_seconds?: number
  proactive_shared_context?: boolean
  proactive_enabled?: boolean; reflection_enabled?: boolean; proactive_instruction?: string; quiet_start?: number; quiet_end?: number
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
export interface DigitalActivityRecords {
  checking: boolean
  run_total: number
  delegation_total: number
  delegation_pending?: boolean
  delegations: Array<DigitalActivity['delegations'][number] & {notification_state?: string; notification_run_id?: string | null}>
  runs: Array<Pick<DigitalActivity['runs'][number], 'id' | 'status' | 'summary' | 'created_at'>>
}
export type DigitalRunDetail = Pick<DigitalActivity['runs'][number], 'id' | 'status' | 'summary' | 'error' | 'created_at'>
const json = (body: unknown, method = 'POST') => ({ method, body: JSON.stringify(body) })
export const digitalRuntimeApi = {
  records: (runOffset = 0, delegationOffset = 0) => request<DigitalActivityRecords>(`/digital-person/activity/records?run_offset=${runOffset}&delegation_offset=${delegationOffset}`),
  runDetail: (id: string) => request<DigitalRunDetail>(`/digital-person/runs/${encodeURIComponent(id)}`),
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

export interface DigitalAffectEvent {
  id:number; project_id:string; session_id:string; source_ids:string[]; kind:string
  delta:number; before_value:number; after_value:number; emotion:string; reason:string; at:string
}
export interface DigitalAffectState {
  person_id:string; name:string; affinity:number; emotion:string; valence:number; arousal:number
  updated_at:string|null; history:DigitalAffectEvent[]
}
export const digitalAffectApi = {
  read: (options:{project_id?:string;session_id?:string;person_id?:string}={}) => request<{state:DigitalAffectState|null}>(`/digital-person/affect?${new URLSearchParams(options)}`),
  people: () => request<{items:Array<Pick<DigitalAffectState,'person_id'|'name'|'affinity'|'emotion'|'updated_at'>>}>('/digital-person/affect/people'),
}

export type MemoryKind = 'event' | 'preference' | 'experience' | 'fact'
export interface MemorySource {
  id:string; project_id:string; project_name:string; source_time:string
  source_kind:'chat'|'task'; role:string
}
export interface MemoryViewItem {
  id:string; summary:string; kind:MemoryKind; outcome:string; state:string
  interpretation:boolean; time:string; time_is_source:boolean
  entities:Array<{kind:'person'|'event'|'object'|'place'|'time';name:string;aliases:string[]}>
  relations:Array<{from:string;to:string;relation:string}>
  sources:MemorySource[]
}
export interface MemoryLibraryStats {
  knowledge_count:number; indexed_count:number; processed_count:number; pending_count:number
  today_count:number; latest_knowledge_at:string|null; by_kind:Record<MemoryKind,number>
}
export interface MemoryBrowseResult {
  items:MemoryViewItem[]; bounded:boolean; stats?:MemoryLibraryStats
}
export interface MemorySourcePage {
  id:string; content:string; source_hash:string; offset:number; next_offset:number|null
  has_more:boolean; total_chars:number; created_at:string; project_id:string
}
export const digitalMemoryApi = {
  browse: (query='') => request<MemoryBrowseResult>(`/digital-person/memory/view?${new URLSearchParams({query})}`),
  read: (id:string,offset=0) => request<MemorySourcePage>(`/digital-person/memory/source/${encodeURIComponent(id)}?offset=${offset}`),
}

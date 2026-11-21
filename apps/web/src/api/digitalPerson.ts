import { ApiError, request } from './transport'
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

export interface VoiceWakeDraft {
  keyword: string; sensitivity: 'low' | 'balanced' | 'high'; sound_enabled?: boolean; greeting?: string
}
export interface VoiceWakeStatus extends VoiceWakeDraft { available: boolean; listening: boolean }
export const VOICE_WAKE_CHANGED = 'workstep:voice-wake-settings-changed'
export const voiceWakeApi = {
  get: () => request<VoiceWakeStatus>('/digital-person/voice-wake'),
  save: (draft: VoiceWakeDraft) => request<VoiceWakeStatus>('/digital-person/voice-wake', { method: 'PUT', body: JSON.stringify(draft) }),
  audio: (signal: AbortSignal) => request<{
    status: 'none' | 'system' | 'pending' | 'ready' | 'failed'; text: string;
    mode?: import('./speechOutput').OutputSettings['mode']; rate?: number; volume?: number;
    chunks?: { audio: string; format: 'pcm' | 'wav'; sampleRate: number }[]
  }>('/digital-person/voice-wake/audio', { signal }),
}

export interface DigitalPeer { id: string; conversation_type: 'single' | 'group'; conversation_id: string; bot_id: string; bot_name: string; title: string; platform: string; notify?: boolean }
export interface DigitalActivity {
  main_session_id?: string
  session_count?: number; reply_count?: number; task_count?: number; completed_task_count?: number
  skills?: Array<{id: string; name: string}>
  feedback: Record<string,number>; suggestions: Array<{id:string;label:string;prompt:string;count:number}>
  experience: number; level: number; next_level_experience: number; checking: boolean
  runs: Array<{ id: string; status: string; summary?: string; error?: string; created_at: string; sources: unknown; deliveries: unknown }>
  delegations: Array<{ id: string; project_id: string; session_id: string; title?: string | null; instruction: string; status: string; created_at?:string; message_id?:string|null }>
  answers: Array<{ id: string; content: string; feedback: number }>
}
export interface DigitalRunOutcome {delivery_failure_reasons?:string[];sent:number;failed:number;affinity_increased:number;affinity_decreased:number}
export interface DigitalRunProcessing {messages:number;sessions:number;memories:number}
export interface DigitalActivityRecords {
  checking: boolean
  reflection_count?:number
  reflection_count_lower_bound?:boolean
  run_total: number
  delegation_total: number
  delegation_pending?: boolean
  delegations: Array<DigitalActivity['delegations'][number] & {notification_state?: string; notification_run_id?: string | null; result_viewed?: boolean | null}>
  runs: Array<Pick<DigitalActivity['runs'][number], 'id' | 'status' | 'summary' | 'created_at'> & {outcome?:DigitalRunOutcome|null;processing?:DigitalRunProcessing}>
}
export type DigitalRunDetail = DigitalActivityRecords['runs'][number] & {error?:string;draft_summary?:string|null;failure_reason?:string|null;notification_message?:string|null}
export interface DigitalRunKnowledge {
  status: 'available' | 'legacy' | 'empty'
  items: Array<{id:string;summary:string}>
  unavailable: number
}

function normalizeLegacyRunSummary<Run extends {status:string;summary?:string;processing?:DigitalRunProcessing;notification_message?:string|null}>(run:Run, detail=false):Run {
  const {summary, status, processing} = run
  if (!summary || processing) return run
  const legacy = summary.match(/^整理 (\d+) 条消息（(\d+) 个会话），新增 (\d+) 条记忆(?:[；;][ \t]*好感度[^\r\n]*)?(?:\r?\n|$)/)
  const notification = ['notify', 'notifying', 'notified', 'delivery_failed', 'deferred'].includes(status)
  const text = legacy ? summary.slice(legacy[0].length) : summary
  return {
    ...run,
    summary:notification ? '' : text,
    ...(legacy ? {processing:{messages:Number(legacy[1]),sessions:Number(legacy[2]),memories:Number(legacy[3])}} : {}),
    ...(detail && notification && text && !run.notification_message ? {notification_message:text} : {}),
  }
}

const json = (body: unknown, method = 'POST') => ({ method, body: JSON.stringify(body) })
export const digitalRuntimeApi = {
  records: (runOffset = 0, delegationOffset = 0, limit = 5) => request<DigitalActivityRecords>(`/digital-person/activity/records?run_offset=${runOffset}&delegation_offset=${delegationOffset}&limit=${limit}`).then(records=>({...records,runs:records.runs.map(run=>normalizeLegacyRunSummary(run))})),
  runDetail: (id: string) => request<DigitalRunDetail>(`/digital-person/runs/${encodeURIComponent(id)}`).then(run=>normalizeLegacyRunSummary(run,true)),
  runKnowledge: (id: string, signal: AbortSignal) => request<DigitalRunKnowledge>(`/digital-person/runs/${encodeURIComponent(id)}/knowledge`, {signal}),
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
export interface AtlasStar {
  id:string; time:string; importance:number; kind?:MemoryKind; legacy?:true
}
export interface AtlasLink {
  from:string; to:string
}
export const atlasStarLimit=500
export const atlasRecallLimit=48
export type AtlasDetail = Pick<MemoryViewItem,'summary'|'sources'> & {links?:AtlasLink[]}
type AtlasMarkerResponse = {
  id:string; time?:string; event_time?:string|null; importance:number; kind?:MemoryKind; sources?:MemorySource[]
}
export const digitalMemoryApi = {
  atlas: async (signal:AbortSignal, ids:string[]=[]) => {
    const query=new URLSearchParams({limit:String(ids.length?atlasRecallLimit:atlasStarLimit)})
    for(const id of ids)query.append('ids',id.slice('knowledge:'.length))
    const load=()=>request<{items:AtlasMarkerResponse[];links?:AtlasLink[]}>(`/digital-person/memory/atlas?${query}`,{signal})
    const {items,links}=await load().catch(error=>{
      if(ids.length||signal.aborted||!(error instanceof ApiError)||error.status!==422)throw error
      query.set('limit',String(atlasRecallLimit))
      return load()
    })
    if(!Array.isArray(items))throw new Error('Invalid atlas markers')
    const requested=new Set(ids)
    const markers:AtlasStar[]=[]
    for(const item of items){
      if(!item||typeof item.id!=='string'||!/^knowledge:[1-9]\d*$/.test(item.id)
        ||(requested.size&&!requested.has(item.id)))continue
      const legacy=typeof item.time!=='string'
      const time=[item.time,item.event_time,item.sources?.[0]?.source_time].find(value=>typeof value==='string')??''
      markers.push({id:item.id,time,importance:Number.isFinite(item.importance)?item.importance:0,kind:item.kind,...(legacy?{legacy:true}:{})})
    }
    const visible=new Set(markers.map(marker=>marker.id))
    const edges=Array.isArray(links)?links.filter(link=>link&&link.from!==link.to&&visible.has(link.from)&&visible.has(link.to)):[]
    return {items:markers,links:edges}
  },
  atlasDetail: async (star:AtlasStar,signal:AbortSignal):Promise<AtlasDetail> => {
    const id=star.id.slice('knowledge:'.length)
    let detail:AtlasDetail|undefined
    if(star.legacy){
      // Older daemons expose cursor pagination only. Ask for the single row below id + 1.
      const cursor=BigInt(id)+1n
      const {items}=await request<{items:(AtlasDetail&{id:string})[]}>(`/digital-person/memory/atlas?cursor=${cursor}&limit=1`,{signal})
      detail=items?.find(item=>item.id===star.id)
    }else{
      detail=await request<AtlasDetail>(`/digital-person/memory/atlas/${encodeURIComponent(id)}`,{signal})
    }
    if(typeof detail?.summary!=='string'||!Array.isArray(detail.sources))throw new Error('Invalid atlas preview')
    const links=Array.isArray(detail.links)?detail.links.filter(link=>link&&
      (link.from===star.id&&/^knowledge:[1-9]\d*$/.test(link.to)||link.to===star.id&&/^knowledge:[1-9]\d*$/.test(link.from))&&link.from!==link.to):undefined
    return {summary:detail.summary,links,sources:detail.sources.map(source=>({...source,project_name:source.project_name??source.project_id}))}
  },
  browse: (query='') => request<MemoryBrowseResult>(`/digital-person/memory/view?${new URLSearchParams({query})}`),
  read: (id:string,offset=0) => request<MemorySourcePage>(`/digital-person/memory/source/${encodeURIComponent(id)}?offset=${offset}`),
}

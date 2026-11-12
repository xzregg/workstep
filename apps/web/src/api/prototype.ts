import { request } from './transport'
import type { AssistantChatMessage } from '../stores/assistantStore'

export interface PrototypeState {
  id: string
  path?: string
  root: string
  status: string
  documents: { id: string; path: string }[]
  files: string[]
  history: { id: string; label: string; changes: Record<string, { before: string; after: string }> }[]
  error: string
  pending: boolean
  bytes: number
}
export interface PrototypeSelection {
  node_id: string | null
  version: string
  tag: string
  text: string
  classes?: string
  rect: { x: number; y: number; width: number; height: number }
  styles: Record<string, string>
  ancestors: { node_id: string | null; tag: string }[]
}
export interface PrototypeDocument {
  version: string
  nodes: Record<string, { editable: boolean; text_editable: boolean; text_value?: string; source?: string; line: number }>
  html_preview: { token: string; entry: string }
}
export function prototypeApi(projectId: string, workspaceId = '') {
  const url = (suffix = '', extra: Record<string,string> = {}) => `/prototype/${workspaceId}${suffix}?${new URLSearchParams({project_id: projectId, ...extra})}`
  const post = <T>(path: string, body = {}) => request<T>(path, {method:'POST', body:JSON.stringify(body)})
  return {
    open: (path: string) => post<PrototypeState>(`/prototype/open?project_id=${encodeURIComponent(projectId)}`,  {project_id:projectId, path}),
    diff: (revision = 'pending') => request<{diff:string}>(url('/diff',{revision})),
    state: () => request<PrototypeState>(url()),
    document: (path: string, editing = true) => request<PrototypeDocument>(url('/document',{path,editing:String(editing)})),
    history: (path: string) => request<{session_id:string; engine?:string; model?:string; messages:AssistantChatMessage[]}>(url('/history',{path})),
    edit: (path: string, node: string, operation: string, values: Record<string,string>, version: string) => post<PrototypeState>(url('/edit'), {path,node_id:node,operation,values,version}),
    action: (action: string) => post<PrototypeState>(url(`/action/${action}`)),
    stop: (path: string) => post(url('/stop',{path})),
    chat: (body: Record<string,unknown>, key: string) => request<{session_id:string;turn_id:string;assistant_message_id:string;status:string}>(url('/chat'), {method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify(body)}),
  }
}

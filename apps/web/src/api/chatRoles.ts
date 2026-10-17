import { request } from './transport'

export interface ChatRoleReference { kind: 'role' | 'team'; id: string }
export interface ChatRoleState { binding: ChatRoleReference | null; name: string; missing: boolean; supported?: boolean }
const route = (sid: string) => `/chat-sessions/${encodeURIComponent(sid)}/role-binding`
export const chatRoleApi = {
  get: (sid: string, projectId: string) => request<ChatRoleState>(`${route(sid)}?project_id=${encodeURIComponent(projectId)}`),
  set: (sid: string, projectId: string, binding: ChatRoleReference | null) => request<ChatRoleState>(route(sid), {
    method: 'PUT', body: JSON.stringify({ project_id: projectId, binding }),
  }),
}

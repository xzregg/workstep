import { request } from './transport'
export interface ChatGroup { id: string; name: string; source: 'chat' | 'channel'; session_ids: string[] }
export interface GroupMutation { action: 'create' | 'move' | 'archive' | 'delete' | 'dissolve' | 'reorder'; target_group_id?: string; before?: boolean; name?: string; source?: 'chat' | 'channel'; group_id?: string | null; session_id?: string; delete_sessions?: boolean }
const route = (projectId: string) => `/chat-sessions/groups?project_id=${encodeURIComponent(projectId)}`
export const chatGroupApi = {
  list: (projectId: string) => request<{ groups: ChatGroup[] }>(route(projectId)),
  mutate: (projectId: string, mutation: GroupMutation) => request<{ groups: ChatGroup[]; removed: string[]; skipped: string[] }>(route(projectId), {
    method: 'POST', body: JSON.stringify(mutation),
  }),
}

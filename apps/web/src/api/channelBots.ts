import { request } from './transport'

export type BotPlatform = 'wecom' | 'dingtalk'
export type BotTargetType = '' | 'project' | 'task'

export interface BotTaskBinding extends DiscussionGroup {
  task_title: string
  project_name: string
}

export interface ChannelBot {
  id: string
  platform: BotPlatform
  name: string
  app_id: string
  enabled: boolean
  card_template_id?: string
  task_bindings?: BotTaskBinding[]
  has_secret: boolean
  status: string
  error: string
  default_target_type: BotTargetType
  default_project_id: string
  default_task_id: string
}

export interface BotDraft {
  card_template_id?: string
  platform: BotPlatform
  name: string
  app_id: string
  secret: string
  enabled: boolean
  default_target_type: BotTargetType
  default_project_id: string
  default_task_id: string
}

export interface PrivateWhitelistUser { sender_id: string; sender_name: string }
export interface PrivateWhitelist { enabled: boolean; users: PrivateWhitelistUser[]; candidates: PrivateWhitelistUser[] }

export interface DiscussionGroup {
  bot_id: string
  group_id: string
  group_name?: string
  project_id: string
  task_id: string
}

const json = (body: unknown, method: string) => ({ method, body: JSON.stringify(body) })
const taskPath = (taskId: string) => `/task/${encodeURIComponent(taskId)}/discussion-groups`

export const channelBotApi = {
  groupWhitelist: async (id: string): Promise<PrivateWhitelist> => {
    const value = await request<{ enabled: boolean; groups: { group_id: string; group_name: string }[]; candidates: { group_id: string; group_name: string }[] }>(`/channel-bots/${encodeURIComponent(id)}/group-whitelist`)
    const map = (row: { group_id: string; group_name: string }) => ({ sender_id: row.group_id, sender_name: row.group_name })
    return { enabled: value.enabled, users: value.groups.map(map), candidates: value.candidates.map(map) }
  },
  saveGroupWhitelist: async (id: string, value: Pick<PrivateWhitelist, 'enabled' | 'users'>) => {
    await request(`/channel-bots/${encodeURIComponent(id)}/group-whitelist`, json({ enabled: value.enabled, groups: value.users.map(row => ({ group_id: row.sender_id, group_name: row.sender_name })) }, 'PUT'))
    return { ...value, candidates: value.users }
  },
  privateWhitelist: (id: string) => request<PrivateWhitelist>(`/channel-bots/${encodeURIComponent(id)}/private-whitelist`),
  savePrivateWhitelist: (id: string, value: Pick<PrivateWhitelist, 'enabled' | 'users'>) => request<PrivateWhitelist>(`/channel-bots/${encodeURIComponent(id)}/private-whitelist`, json(value, 'PUT')),
  list: () => request<ChannelBot[]>('/channel-bots'),
  create: (draft: BotDraft) => request<ChannelBot>('/channel-bots', json(draft, 'POST')),
  update: (id: string, draft: Partial<BotDraft>) => request<ChannelBot>(`/channel-bots/${encodeURIComponent(id)}`, json(draft, 'PATCH')),
  remove: (id: string) => request<{ deleted: boolean }>(`/channel-bots/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  recentGroups: (id: string) => request<Array<{ bot_id: string; group_id: string; group_name?: string; conversation_title?: string; sender_id?: string; sender_name?: string }>>(`/channel-bots/${encodeURIComponent(id)}/recent-groups`),
  taskGroups: (taskId: string, projectId: string) => request<DiscussionGroup[]>(`${taskPath(taskId)}?project_id=${encodeURIComponent(projectId)}`),
  bindGroup: (taskId: string, projectId: string, botId: string, groupId: string, groupName?: string) => request<DiscussionGroup>(taskPath(taskId), json({ project_id: projectId, bot_id: botId, group_id: groupId, group_name: groupName }, 'POST')),
  unbindGroup: (taskId: string, projectId: string, botId: string, groupId: string) => request<{ deleted: boolean }>(`${taskPath(taskId)}/${encodeURIComponent(botId)}/${encodeURIComponent(groupId)}?project_id=${encodeURIComponent(projectId)}`, { method: 'DELETE' }),
}

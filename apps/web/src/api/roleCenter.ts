import { request } from './transport'

export interface RoleSource { repository: string; path: string; commit: string; license: string }
export interface RoleDocument {
  id: string; name: string; category: string; description: string; prompt: string
  builtin: boolean; source: RoleSource | null; revision: string; updated_at: string
}
export interface TeamMember { role_id: string; duty: string }
export interface TeamDocument {
  id: string; name: string; description: string; prompt: string; members: TeamMember[]
  revision: string; updated_at: string
}
export type RoleSummary = Omit<RoleDocument, 'prompt'>
export type TeamSummary = Omit<TeamDocument, 'prompt'>
export interface RoleCategory { id: string; name: string }
export interface RoleCatalog {
  roles: RoleSummary[]; teams: TeamSummary[]; categories: RoleCategory[]; warnings: string[]
}
export interface RoleWrite { name: string; category: string; description: string; prompt: string; expected_revision?: string }
export interface TeamWrite { name: string; description: string; prompt: string; members: TeamMember[]; expected_revision?: string }
const base = '/role-center'
export const roleCenterApi = {
  catalog: () => request<RoleCatalog>(base),
  getRole: (id: string) => request<RoleDocument>(`${base}/roles/${encodeURIComponent(id)}`),
  getTeam: (id: string) => request<TeamDocument>(`${base}/teams/${encodeURIComponent(id)}`),
  saveRole: (data: RoleWrite, id?: string) => request<RoleDocument>(`${base}/roles${id ? '/' + encodeURIComponent(id) : ''}`, {
    method: id ? 'PUT' : 'POST', body: JSON.stringify(data),
  }),
  saveTeam: (data: TeamWrite, id?: string) => request<TeamDocument>(`${base}/teams${id ? '/' + encodeURIComponent(id) : ''}`, {
    method: id ? 'PUT' : 'POST', body: JSON.stringify(data),
  }),
}

/** UI visibility only. The Gateway/daemon continue enforcing their existing authorization. */
export interface ProjectPermissionSession {
  host_project_id: string | null
  access_level: 'read' | 'edit' | null
  task_create: boolean
  share_create: boolean
  permissions?: string[] | null
}
export function resolveProjectPermissions(remote: boolean, session: ProjectPermissionSession | null, projectId?: string) {
  const bound = remote && (!session || !!session.host_project_id)
  const matches = !!session && session.host_project_id === projectId
  const can = (permission: string) => {
    if (!bound) return true
    if (!matches || !session) return false
    if (!permission.endsWith('.read') && session.access_level !== 'edit') return false
    if (permission === 'task.create' || permission === 'task.copy' || permission === 'task.ai_create' || permission === 'task.start_on_create') {
      if (session.access_level !== 'edit' || !session.task_create) return false
    }
    if (permission.startsWith('share.') && !session.share_create) return false
    if (Array.isArray(session.permissions)) return session.permissions.includes(permission)
    return permission.endsWith('.read') || session.access_level === 'edit'
  }
  return { bound, can, canEdit: can('task.edit'), canCreateTask: can('task.create') }
}

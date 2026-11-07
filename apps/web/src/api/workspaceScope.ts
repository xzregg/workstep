import { useGatewaySessionStore } from '../stores/gatewaySessionStore'
import { isGatewayRemoteBrowser } from '../utils/gatewayRemote'

/** Every request names one project from the authenticated workspace directory. */
export async function workspaceCatalogPath(path: string, projectId = ''): Promise<string> {
  const params = new URLSearchParams(path.split('?')[1] ?? '')
  if (isGatewayRemoteBrowser()) {
    const session = await useGatewaySessionStore.getState().load()
    if (session.host_project_id) {
      projectId = projectId || params.get('project_id') || session.host_project_id
      const allowed = session.projects?.some(project => project.host_project_id === projectId)
        ?? (projectId === session.host_project_id)
      if (!allowed) throw new Error('项目范围不匹配')
      params.delete('refresh')
      params.delete('with_share')
    }
  }
  if (projectId) params.set('project_id', projectId)
  const query = params.toString()
  return `${path.split('?')[0]}${query ? `?${query}` : ''}`
}

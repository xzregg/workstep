import { useGatewaySessionStore } from '../stores/gatewaySessionStore'
import { isGatewayRemoteBrowser } from '../utils/gatewayRemote'

/** Keep catalog reads in the same signed project as the workspace. */
export async function workspaceCatalogPath(path: string, projectId = ''): Promise<string> {
  const params = new URLSearchParams(path.split('?')[1] ?? '')
  if (isGatewayRemoteBrowser()) {
    const session = await useGatewaySessionStore.getState().load()
    if (session.host_project_id) {
      if (projectId && projectId !== session.host_project_id) throw new Error('项目范围不匹配')
      projectId = session.host_project_id
      params.delete('refresh')
    }
  }
  if (projectId) params.set('project_id', projectId)
  const query = params.toString()
  return `${path.split('?')[0]}${query ? `?${query}` : ''}`
}

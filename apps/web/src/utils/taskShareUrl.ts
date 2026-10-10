import type { Project } from '../api/project'

export function canUseLocalTaskShare(managed: boolean | null, projectType: Project['type']): boolean {
  return managed !== true || projectType === 'remote'
}

export function taskShareUrl(token: string, project: Pick<Project, 'id' | 'type' | 'endpoint'> | undefined, origin: string): string {
  let base = origin
  if (project?.type === 'remote' && project.endpoint) {
    const endpoint = new URL(project.endpoint)
    endpoint.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:'
    endpoint.pathname = endpoint.pathname.replace(/\/ws\/remote-project\/?$/, '')
    endpoint.search = ''
    endpoint.hash = ''
    base = endpoint.toString().replace(/\/$/, '')
  }
  return `${base}/share/${encodeURIComponent(token)}`
}

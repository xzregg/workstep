import { create } from 'zustand'
import { ApiError, request } from '../api/transport'
import { gatewayWorkspacePath } from '../utils/gatewayWorkspacePath'

export interface GatewayProjectScope {
  project_id: string
  host_project_id: string
  name: string
  access_level: 'read' | 'edit'
  task_create: boolean
  share_create: boolean
  permissions?: string[] | null
}

export interface GatewayRemoteSession {
  user_id?: string
  device_id: string
  device_name: string
  username: string
  gateway_url: string
  project_id: string | null
  host_project_id: string | null
  access_level: 'read' | 'edit' | null
  task_create: boolean
  share_create: boolean
  can_manage_project_access: boolean
  permissions?: string[] | null
  projects?: GatewayProjectScope[]
}

interface GatewaySessionState {
  session: GatewayRemoteSession | null
  error: string
  errorStatus: number | null
  loading: boolean
  load: (force?: boolean) => Promise<GatewayRemoteSession>
  selectProject: (projectId: string) => boolean
}

let pending: Promise<GatewayRemoteSession> | null = null

// Only navigation scope is stored; credentials stay in HttpOnly cookies.
function rememberScope(session: GatewayRemoteSession) {
  const path = gatewayWorkspacePath()
  if (!path) return
  try { sessionStorage.setItem('workstep-remote-scope:' + path, JSON.stringify({ device_id: session.device_id, project_id: session.project_id })) }
  catch { /* Optional tab storage. */ }
}

async function recoverSession(previous: GatewayRemoteSession | null, signal: AbortSignal) {
  const path = gatewayWorkspacePath()
  if (!path) return false
  let scope = previous
  if (!scope) {
    try { scope = JSON.parse(sessionStorage.getItem('workstep-remote-scope:' + path) ?? 'null') }
    catch { /* A missing scope requires entering through the portal again. */ }
  }
  if (!scope || path !== '/workspace/' + scope.device_id ||
      (scope.project_id !== null && typeof scope.project_id !== 'string')) return false
  // Use the platform cookie, never the expired remote cookie. Keep project-only
  // sessions project-scoped and let the platform check current permissions.
  const endpoint = `/api/${scope.project_id ? 'projects' : 'devices'}/${encodeURIComponent(scope.project_id ?? scope.device_id)}/access`
  const accessResponse = await fetch(endpoint, { credentials: 'same-origin', signal })
  if (!accessResponse.ok) throw new ApiError('远程访问授权恢复失败。', accessResponse.status)
  const access = await accessResponse.json()
  const target = new URL(access.url, window.location.origin)
  if (target.origin !== window.location.origin || target.pathname !== path + '/' || !access.ticket) {
    throw new Error('远程访问授权无效。')
  }
  const redeemed = await fetch(new URL('api/remote/redeem', target).href, {
    method: 'POST', credentials: 'same-origin', signal, redirect: 'manual',
    body: new URLSearchParams({ ticket: access.ticket }),
  })
  // Browsers hide manual redirect responses but still accept their Set-Cookie.
  // Do not navigate or follow the redirect: keep the current page and drafts.
  if (redeemed.type !== 'opaqueredirect' && redeemed.status !== 303) {
    throw new ApiError('远程访问授权恢复失败。', redeemed.status)
  }
  return true
}

export const useGatewaySessionStore = create<GatewaySessionState>((set, get) => ({
  session: null, error: '', errorStatus: null, loading: false,
  selectProject: projectId => {
    const session = get().session
    if (!session?.host_project_id) return true
    if (!session.projects) return session.host_project_id === projectId
    const scope = session.projects.find(project => project.host_project_id === projectId)
    if (!scope) return false
    const selected = { ...session, ...scope }
    rememberScope(selected)
    set({ session: selected })
    return true
  },
  load: (force = false) => {
    if (pending) return pending
    if (!force && get().session) return Promise.resolve(get().session!)
    set({ loading: true })
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 10000)
    const previous = get().session
    const sessionPath = previous?.projects && previous.host_project_id
      ? '/remote/session?project_id=' + encodeURIComponent(previous.host_project_id) : '/remote/session'
    pending = request<GatewayRemoteSession>(sessionPath, {signal: controller.signal}).catch(async reason => {
      if (reason instanceof ApiError && reason.status === 403 && sessionPath !== '/remote/session') {
        return request<GatewayRemoteSession>('/remote/session', {signal: controller.signal})
      }
      if (!(reason instanceof ApiError) || reason.status !== 401) throw reason
      const previous = get().session
      set({ session: null })
      if (!await recoverSession(previous, controller.signal)) throw reason
      // One attempt only. A revoked platform login or scope never loops.
      return request<GatewayRemoteSession>('/remote/session', {signal: controller.signal})
    }).then(session => {
      if (!session || !session.device_id || !session.gateway_url ||
          (!!session.project_id !== !!session.host_project_id) ||
          (session.project_id && !['read', 'edit'].includes(session.access_level ?? '')) ||
          (session.permissions != null && (!Array.isArray(session.permissions) || session.permissions.some((key: unknown) => typeof key !== 'string')))) {
        throw new Error('远程项目会话无效，请从平台重新打开。')
      }
      if (session.projects && (!Array.isArray(session.projects) || session.projects.some(project =>
        !project.project_id || !project.host_project_id || !['read', 'edit'].includes(project.access_level)))) {
        throw new Error('远程项目目录无效。')
      }
      const current = get().session
      if (session.projects && current?.device_id === session.device_id && current.user_id === session.user_id) {
        const selected = session.projects.find(project => project.host_project_id === current.host_project_id)
        if (selected) session = { ...session, ...selected }
      }
      rememberScope(session)
      set({ session, error: '', errorStatus: null })
      return session
    }).catch(reason => {
      const temporary = reason instanceof ApiError
        ? reason.status >= 500 || reason.status === 408 || reason.status === 429
        : reason instanceof TypeError || (reason instanceof Error && reason.name === 'AbortError')
      set({ session: temporary ? get().session : null, error: reason instanceof Error ? reason.message : '远程会话已失效。',
        errorStatus: reason instanceof ApiError ? reason.status : null })
      throw reason
    }).finally(() => { window.clearTimeout(timeout); pending = null; set({ loading: false }) })
    return pending
  },
}))

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'

type Access = { roles: string[]; must_change_password: boolean; password_confirmation_required?: boolean }
type State = { path: string; status: 'checking' | 'ready' | 'anonymous' | 'error'; access: Access | null }

export function useAdminAccess(): State {
  const location = useLocation()
  const [state, setState] = useState<State>({ path: location.pathname, status: 'checking', access: null })
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const refresh = () => setRevision(value => value + 1)
    window.addEventListener('gateway-auth-changed', refresh)
    return () => window.removeEventListener('gateway-auth-changed', refresh)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setState({ path: location.pathname, status: 'checking', access: null })
    void fetch('/api/auth/admin-access', { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        if (controller.signal.aborted) return
        if (response.status === 401) {
          setState({ path: location.pathname, status: 'anonymous', access: null }); return
        }
        if (!response.ok) throw new Error('管理权限检查失败')
        const access = await response.json() as Access
        if (!controller.signal.aborted) setState({ path: location.pathname, status: 'ready', access })
      }).catch(reason => {
        if (!controller.signal.aborted && reason?.name !== 'AbortError') {
          setState({ path: location.pathname, status: 'error', access: null })
        }
      })
    return () => controller.abort()
  }, [location.pathname, revision])

  return state.path === location.pathname ? state : { path: location.pathname, status: 'checking', access: null }
}

export function AdminAccessGate({ state, allow, children }: {
  state: State; allow?: string[]; children: ReactNode
}) {
  const location = useLocation()
  if (state.status === 'checking') return <section className="gateway-admin-page"><p role="status">正在检查管理权限…</p></section>
  if (state.status === 'error') return <section className="gateway-admin-page"><p role="alert">
    管理权限检查失败。<button type="button"
      onClick={() => window.dispatchEvent(new Event('gateway-auth-changed'))}>重试</button></p></section>
  if (state.status === 'anonymous') return <Navigate to={`/auth?next=${encodeURIComponent(location.pathname)}`} replace />
  const roles = state.access?.roles ?? []
  if (roles.length === 0 || (allow && !allow.some(role => roles.includes(role)))) {
    return <Navigate to="/" replace state={{ adminDenied: true }} />
  }
  return children
}

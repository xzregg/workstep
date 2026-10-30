import { AdminListStatus } from './AdminListStatus'

export function AdminSessionStatus({ loading, error, onRetry }: {
  loading: boolean; error: string; onRetry: () => void
}) {
  return <>
    <AdminListStatus loading={loading} label="正在检查登录状态…" />
    {error && <p className="gateway-auth-error" role="alert">{error} <button type="button" onClick={onRetry}>重试</button></p>}
    {error.includes('已失效') && <a href={`/auth?next=${encodeURIComponent(window.location.pathname + window.location.search)}`}>重新登录</a>}
  </>
}

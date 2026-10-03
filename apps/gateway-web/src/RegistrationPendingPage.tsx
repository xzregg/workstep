import { Link, useSearchParams } from 'react-router-dom'
import { safeNextPath } from './portalAccount'

export function RegistrationPendingPage() {
  const [params] = useSearchParams()
  const next = safeNextPath(params.get('next'))
  return <section className="gateway-auth-card">
    <h2>账号等待审核</h2>
    <p>管理员批准后，请重新登录。</p>
    <Link to={`/auth?next=${encodeURIComponent(next)}`}>返回登录</Link>
  </section>
}

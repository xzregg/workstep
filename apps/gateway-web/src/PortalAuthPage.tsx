import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { GatewayLoginForm } from './GatewayLoginForm'
import { scanFailureMessage } from './scanFailure'
import { GatewayRegistrationForm } from './GatewayRegistrationForm'
import { safeNextPath } from './portalAccount'
import type { RegistrationMode } from './portalAccount'
export { safeNextPath, validPortalAccount } from './portalAccount'

type IdentitySource = { id: string; provider: 'dingtalk' | 'wecom'; tenant_id: string }

export function PortalAuthPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = safeNextPath(params.get('next'))
  const [stage, setStage] = useState<'checking' | 'setup' | 'login' | 'register'>('checking')
  const [mode, setMode] = useState<RegistrationMode>('closed')
  const [sources, setSources] = useState<IdentitySource[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [scanNotice, setScanNotice] = useState(scanFailureMessage(params.get('scan_error')))
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    async function check() {
      try {
        const status = await fetch('/api/platform/status', { signal: controller.signal })
        if (!status.ok) throw new Error('无法检查平台状态，请刷新重试。')
        if (!(await status.json()).initialized) { setMode('open'); setStage('setup'); return }
        const session = await fetch('/api/auth/session', { credentials: 'same-origin', signal: controller.signal })
        if (session.ok) { navigate(next, { replace: true }); return }
        if (session.status !== 401) throw new Error('无法检查登录状态，请稍后重试。')
        // Optional enterprise sign-in must not delay or block local accounts.
        void fetch('/api/auth/identity-sources', { signal: controller.signal })
          .then(async response => {
            if (!response.ok) return
            const result = await response.json()
            if (!controller.signal.aborted) setSources(result.sources ?? [])
          }).catch(() => {})
        const policy = await fetch('/api/auth/registration-policy', { signal: controller.signal })
        if (!policy.ok) throw new Error('无法读取注册策略，请刷新重试。')
        if (!controller.signal.aborted) {
          setMode((await policy.json()).mode)
          setStage('login')
        }
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '无法加载登录页面。')
      }
    }
    void check()
    return () => controller.abort()
  }, [navigate, next, retry])

  async function post(url: string, body: object) {
    const response = await fetch(url, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!response.ok) {
      if (response.status === 409 && url === '/api/platform/setup') throw new Error('平台已完成初始化，请刷新页面登录。')
      if (response.status === 429) throw new Error('尝试次数过多，请稍后再试。')
      throw new Error(url === '/api/auth/login' ? '登录失败，请检查账号状态和密码。' : '提交失败，请检查填写内容后重试。')
    }
    return response
  }

  async function signIn(username: string, password: string) {
    setBusy(true); setError(''); setScanNotice('')
    try { await post('/api/auth/login', { username, password }); navigate(next, { replace: true }) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '登录失败。') }
    finally { setBusy(false) }
  }

  async function scan(sourceId: string) {
    setBusy(true); setError(''); setScanNotice('')
    try {
      const response = await post(`/api/auth/external/${encodeURIComponent(sourceId)}/start`,
        { return_to: `/auth?next=${encodeURIComponent(next)}` })
      const result = await response.json()
      if (typeof result.authorization_url !== 'string' || !result.authorization_url.startsWith('https://'))
        throw new Error('身份源返回了无效的登录地址。')
      window.location.assign(result.authorization_url)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '扫码登录失败。'); setBusy(false) }
  }

  return <section className="gateway-auth-card">
    <span className="gateway-auth-eyebrow">WORKSTEP 平台</span>
    <h2>{stage === 'setup' ? '设置超级管理员' : stage === 'register' ? '注册账号' : '登录工作台'}</h2>
    {stage === 'checking' && <p role="status">正在检查平台状态…</p>}
    {stage === 'checking' && error && <button type="button" onClick={() => { setError(''); setRetry(value => value + 1) }}>重试</button>}
    {stage === 'login' && <>
      <p className="gateway-auth-description">登录后查看你的电脑和项目。</p>
      {scanNotice && <p className="gateway-auth-error" role="alert">{scanNotice}</p>}
      <GatewayLoginForm busy={busy} onSubmit={signIn} />
      {mode !== 'closed' && <p><button className="gateway-auth-text-button" type="button" disabled={busy}
        onClick={() => { setError(''); setStage('register') }}>注册账号</button></p>}
      {sources.length > 0 && <div className="gateway-auth-external"><p>或使用企业身份登录</p>
        {sources.map(source => <button key={source.id} type="button" disabled={busy} onClick={() => void scan(source.id)}>
          {source.provider === 'dingtalk' ? '钉钉' : '企业微信'} · {source.tenant_id}
        </button>)}
      </div>}
    </>}
    {stage === 'register' && <GatewayRegistrationForm mode={mode} onClosed={() => setMode('closed')}
      onRegistered={pending => navigate(pending ? `/auth/pending?next=${encodeURIComponent(next)}` : next, { replace: true })}
      onBack={() => { setError(''); setStage('login') }} />}
    {stage === 'setup' && <>
      <p className="gateway-auth-description">首位注册用户将成为超级管理员。</p>
      <GatewayRegistrationForm mode="open" onClosed={() => setMode('closed')}
        onRegistered={() => { window.dispatchEvent(new Event('gateway-auth-changed')); navigate('/admin', { replace: true }) }}
        onBack={() => { setError(''); setRetry(value => value + 1) }} />
    </>}
    {error && <p className="gateway-auth-error" role="alert">{error}</p>}
    {stage !== 'checking' && <p className="gateway-auth-return"><Link to="/">返回工作台</Link></p>}
  </section>
}

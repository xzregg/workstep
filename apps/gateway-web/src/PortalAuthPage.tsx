import { localizeGatewayError } from './gatewayErrorText'
import { loadPlatformStatus } from './platformBranding'
import { CompanySubtitle } from './CompanySubtitle'
import type { EnterpriseProvider } from './enterpriseProviders'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { GatewayLoginForm } from './GatewayLoginForm'
import { EnterpriseLoginChoices } from './EnterpriseLoginChoices'
import { scanFailureMessage } from './scanFailure'
import { GatewayRegistrationForm } from './GatewayRegistrationForm'
import { safeNextPath } from './portalAccount'
import type { RegistrationMode } from './portalAccount'
export { safeNextPath, validPortalAccount } from './portalAccount'

type IdentitySource = { id: string; provider: EnterpriseProvider }

export function PortalAuthPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = safeNextPath(params.get('next'))
  const [stage, setStage] = useState<'checking' | 'setup' | 'login' | 'register'>('checking')
  const [mode, setMode] = useState<RegistrationMode>('closed')
  const [companyName, setCompanyName] = useState('')
  const [sources, setSources] = useState<IdentitySource[]>([])
  const [passwordEnabled, setPasswordEnabled] = useState(true)
  const [scanLoading, setScanLoading] = useState(true)
  const [scanError, setScanError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [scanNotice, setScanNotice] = useState(scanFailureMessage(params.get('scan_error')))
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    async function check() {
      try {
        const platform = await loadPlatformStatus()
        if (controller.signal.aborted) return
        setCompanyName(platform.company_display_name ?? '')
        if (!platform.initialized) { setMode('open'); setStage('setup'); return }
        const session = await fetch('/api/auth/session', { credentials: 'same-origin', signal: controller.signal })
        if (session.ok) { navigate(next, { replace: true }); return }
        if (session.status !== 401) throw new Error('Unable to check login status, please try again later.')
        // Optional enterprise sign-in must not delay or block local accounts.
        setScanLoading(true); setScanError(false)
        void fetch('/api/auth/identity-sources', { signal: controller.signal })
          .then(async response => {
            if (!response.ok) throw new Error('Scan options unavailable')
            const result = await response.json()
            if (!controller.signal.aborted) setSources(result.sources ?? [])
          }).catch(() => {if (!controller.signal.aborted) setScanError(true)})
          .finally(() => {if (!controller.signal.aborted) setScanLoading(false)})
        const policy = await fetch('/api/auth/registration-policy', { signal: controller.signal })
        if (!policy.ok) throw new Error('Failed to read registration policy. Please refresh and try again.')
        if (!controller.signal.aborted) {
          const data = await policy.json()
          setMode(data.mode)
          setPasswordEnabled(data.password_login_enabled ?? true)
          setStage('login')
        }
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Failed to load the login page.')
      }
    }
    void check()
    return () => controller.abort()
  }, [navigate, next, retry])

  async function post(url: string, body: object) {
    const response = await fetch(url, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!response.ok) {
      if (response.status === 409 && url === '/api/platform/setup') throw new Error('Platform initialization complete. Please refresh the page to log in.')
      if (response.status === 429) throw new Error('Too many attempts, please try again later.')
      if (response.status === 429) throw new Error('Too many login attempts, please try again later.')
      throw new Error(url === '/api/auth/login' ? 'Login failed. Please check the account status and password.' : 'Submission failed. Please check the entered content and try again.')
    }
    return response
  }

  async function signIn(username: string, password: string) {
    setBusy(true); setError(''); setScanNotice('')
    try {
      const result = await post('/api/auth/login', { username, password })
      navigate(result.status === 202 ? `/auth/pending?next=${encodeURIComponent(next)}` : next, { replace: true })
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Login failed.') }
    finally { setBusy(false) }
  }

  async function scan(sourceId: string) {
    setBusy(true); setError(''); setScanNotice('')
    try {
      const response = await post(`/api/auth/external/${encodeURIComponent(sourceId)}/start`,
        { return_to: `/auth?next=${encodeURIComponent(next)}` })
      const result = await response.json()
      if (typeof result.authorization_url !== 'string' || !result.authorization_url.startsWith('https://'))
        throw new Error('The identity source returned an invalid login address.')
      window.location.assign(result.authorization_url)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'QR code login failed.') }
    finally { setBusy(false) }
  }

  return <section className="gateway-auth-card">
    <span className="gateway-auth-eyebrow">WORKSTEP 平台</span>
    <h2>{stage === 'setup' ? '设置超级管理员' : stage === 'register' ? '注册账号' : '登录工作台'}</h2>
    <CompanySubtitle name={companyName} />
    {stage === 'checking' && <p role="status">正在检查平台状态…</p>}
    {stage === 'checking' && error && <button type="button" onClick={() => { setError(''); setRetry(value => value + 1) }}>重试</button>}
    {stage === 'login' && <>
      <p className="gateway-auth-description">登录后查看你的电脑和项目。</p>
      {scanNotice && <p className="gateway-auth-error" role="alert">{scanNotice}</p>}
      {passwordEnabled && <GatewayLoginForm busy={busy} onSubmit={signIn} />}
      {passwordEnabled && mode !== 'closed' && <p><button className="gateway-auth-text-button" type="button" disabled={busy}
        onClick={() => { setError(''); setStage('register') }}>注册账号</button></p>}
      {!passwordEnabled && scanLoading && <p role="status"><span className="gateway-spinner"/> 正在加载扫码登录…</p>}
      {!passwordEnabled && !scanLoading && (scanError || !sources.length) && <p role="alert">{scanError ? '扫码登录入口加载失败，请重试。' : '暂无可用的扫码登录入口，请联系管理员。'}<button type="button" onClick={()=>setRetry(value=>value+1)}>重试</button></p>}
      <EnterpriseLoginChoices sources={sources} passwordEnabled={passwordEnabled} busy={busy} onSelect={id=>void scan(id)}/>
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
    {error && <p className="gateway-auth-error" role="alert">{localizeGatewayError(error)}</p>}
    {stage !== 'checking' && <p className="gateway-auth-return"><Link className="gateway-action-link" to="/">返回工作台</Link></p>}
  </section>
}

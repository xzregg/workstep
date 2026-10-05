import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { GatewayLoginForm } from './GatewayLoginForm'
import { scanFailureMessage } from './scanFailure'

type DesktopRequest = {
  redirect_uri?: string
  gateway_id: string
  app_instance_id: string
  state: string
  nonce: string
  code_challenge: string
}

type IdentitySource = { id: string; provider: 'dingtalk' | 'wecom'; tenant_id: string }

export function parseDesktopRequest(search: string): DesktopRequest | null {
  const params = new URLSearchParams(search)
  if (params.has('scan_error')) {
    if (params.getAll('scan_error').length !== 1 || !scanFailureMessage(params.get('scan_error'))) return null
    params.delete('scan_error')
  }
  const keys = ['gateway_id', 'app_instance_id', 'state', 'nonce', 'code_challenge'] as const
  const redirect = params.get('redirect_uri')
  if (redirect) {
    if (params.getAll('redirect_uri').length !== 1 || !/^[\x21-\x7e]+$/.test(redirect) || redirect.includes('\\')) return null
    try { const uri = new URL(redirect); if (!['http:', 'https:'].includes(uri.protocol) || !uri.hostname || uri.port === '0' || uri.pathname !== '/api/gateway-platform/callback' || uri.username || uri.password || uri.search || uri.hash || uri.href !== redirect) return null } catch { return null }
    params.delete('redirect_uri')
  }
  if ([...params].length !== keys.length) return null
  if (keys.some((key) => params.get(key) === null)) return null
  const values = Object.fromEntries(keys.map((key) => [key, params.get(key)])) as DesktopRequest
  if (!values.gateway_id || !values.app_instance_id
      || values.state.length < 32 || values.nonce.length < 32
      || !/^[A-Za-z0-9_-]{43}$/.test(values.code_challenge)) return null
  return redirect ? { ...values, redirect_uri: redirect } : values
}

export function DesktopLoginPage() {
  const [searchParams] = useSearchParams()
  const request = parseDesktopRequest(searchParams.toString())
  const [status, setStatus] = useState<'checking' | 'login' | 'ready' | 'submitting'>('checking')
  const [csrf, setCsrf] = useState<string | null>(null)
  const [error, setError] = useState(scanFailureMessage(searchParams.get('scan_error')))
  const [sources, setSources] = useState<IdentitySource[]>([])

  useEffect(() => {
    if (!request) return
    const controller = new AbortController()
    void fetch('/api/auth/session', { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          setStatus('login')
          return
        }
        const result = await response.json()
        setCsrf(result.csrf_token)
        setStatus('ready')
      })
      .catch((reason) => {
        if (reason?.name !== 'AbortError') setStatus('login')
      })
    void fetch('/api/auth/identity-sources', { signal: controller.signal })
      .then(async (response) => {
        if (response.ok) setSources((await response.json()).sources ?? [])
      })
      .catch(() => {})
    return () => controller.abort()
  }, [request?.state])

  async function authorize(token: string) {
    if (!request) return
    setStatus('submitting')
    setError('')
    try {
      const response = await fetch('/api/desktop/authorize', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify(request),
      })
      if (!response.ok) throw new Error('桌面端授权失败，请重新登录后再试。')
      const result = await response.json()
      if (typeof result.callback_url !== 'string'
          || !result.callback_url.startsWith(`${request.redirect_uri ?? 'workstep://auth/callback'}?`)) {
        throw new Error('授权回调无效。')
      }
      window.location.assign(result.callback_url)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '授权失败，请重试。')
      setStatus('ready')
    }
  }

  async function signIn(username: string, password: string) {
    setStatus('submitting')
    setError('')
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!response.ok) throw new Error('用户名或密码不正确，或账号尚未获准登录。')
      const result = await response.json()
      setCsrf(result.csrf_token)
      window.dispatchEvent(new Event('gateway-auth-changed'))
      await authorize(result.csrf_token)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '登录失败，请重试。')
      setStatus('login')
    }
  }

  async function startExternalLogin(sourceId: string) {
    setStatus('submitting')
    setError('')
    try {
      const response = await fetch(`/api/auth/external/${encodeURIComponent(sourceId)}/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ return_to: `/desktop/login?${new URLSearchParams(request!).toString()}` }),
      })
      if (!response.ok) throw new Error('扫码登录暂时不可用，请重试或使用用户名密码。')
      const result = await response.json()
      if (typeof result.authorization_url !== 'string'
          || !result.authorization_url.startsWith('https://')) {
        throw new Error('身份源返回了无效的登录地址。')
      }
      window.location.assign(result.authorization_url)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '扫码登录失败，请重试。')
      setStatus('login')
    }
  }

  if (!request) return (
    <section className="gateway-auth-card">
      <h2>登录请求无效</h2>
      <p>请从 WorkStep 设置重新发起认证。</p>
      <Link to="/">返回工作台</Link>
    </section>
  )

  return (
    <section className="gateway-auth-card">
      <span className="gateway-auth-eyebrow">WORKSTEP 平台</span>
      <h2>WorkStep 平台认证</h2>
      <p className="gateway-auth-description">登录后授权当前电脑访问所属工作空间。</p>
      {status === 'checking' && <p role="status">正在检查登录状态…</p>}
      {status === 'login' && (
        <>
          <GatewayLoginForm onSubmit={signIn} submitLabel="登录并继续" />
          {sources.length > 0 && <div className="gateway-auth-external">
            <p>或使用企业身份登录</p>
            {sources.map((source) => <button key={source.id} type="button"
              onClick={() => void startExternalLogin(source.id)}>
              {source.provider === 'dingtalk' ? '钉钉' : '企业微信'} · {source.tenant_id}
            </button>)}
          </div>}
        </>
      )}
      {status === 'ready' && <button type="button" onClick={() => csrf && void authorize(csrf)}>
        在此电脑上继续
      </button>}
      {status === 'submitting' && <p role="status">正在完成授权…</p>}
      {error && <p className="gateway-auth-error" role="alert">{error}</p>}
    </section>
  )
}

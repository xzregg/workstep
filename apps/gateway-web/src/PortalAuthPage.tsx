import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { GatewayLoginForm } from './GatewayLoginForm'
import { scanFailureMessage } from './scanFailure'

type RegistrationMode = 'open' | 'open_with_approval' | 'closed'
type IdentitySource = { id: string; provider: 'dingtalk' | 'wecom'; tenant_id: string }
type Account = { username: string; display_name: string; password: string }

export function validPortalAccount(username: string, displayName: string, password: string): boolean {
  return /^[a-z][a-z0-9_-]{2,63}$/.test(username) && !!displayName.trim()
    && displayName.length <= 256 && password.length >= 12 && password.length <= 128
}

export function safeNextPath(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//')
    && !/[\\\r\n]/.test(value) && !/^\/auth(?:$|[?#])/.test(value) ? value : '/'
}

export function PortalAuthPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = safeNextPath(params.get('next'))
  const [stage, setStage] = useState<'checking' | 'setup' | 'login' | 'register'>('checking')
  const [mode, setMode] = useState<RegistrationMode>('closed')
  const [sources, setSources] = useState<IdentitySource[]>([])
  const [account, setAccount] = useState<Account>({ username: '', display_name: '', password: '' })
  const [confirmation, setConfirmation] = useState('')
  const [recovery, setRecovery] = useState({ username: '', password: '' })
  const [registrationMode, setRegistrationMode] = useState<RegistrationMode>('closed')
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
        if (!(await status.json()).initialized) { setStage('setup'); return }
        const session = await fetch('/api/auth/session', { credentials: 'same-origin', signal: controller.signal })
        if (session.ok) { navigate(next, { replace: true }); return }
        const [policy, identitySources] = await Promise.all([
          fetch('/api/auth/registration-policy', { signal: controller.signal }),
          fetch('/api/auth/identity-sources', { signal: controller.signal }),
        ])
        if (!policy.ok) throw new Error('无法读取注册策略，请刷新重试。')
        if (!controller.signal.aborted) {
          setMode((await policy.json()).mode)
          if (identitySources.ok) setSources((await identitySources.json()).sources ?? [])
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

  async function submitAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      if (stage === 'setup') {
        await post('/api/platform/setup', { ...account, recovery_username: recovery.username,
          recovery_password: recovery.password, registration_mode: registrationMode })
        navigate(next, { replace: true })
      } else {
        const response = await post('/api/auth/register', account)
        if (response.status === 202) navigate('/auth/pending', { replace: true })
        else navigate(next, { replace: true })
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : '提交失败。') }
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

  const creating = stage === 'setup' || stage === 'register'
  const valid = validPortalAccount(account.username, account.display_name, account.password)
    && confirmation === account.password
    && (stage !== 'setup' || (validPortalAccount(recovery.username, '恢复管理员', recovery.password)
      && recovery.username !== account.username && recovery.password !== account.password))

  return <section className="gateway-auth-card">
    <span className="gateway-auth-eyebrow">WORKSTEP GATEWAY</span>
    <h2>{stage === 'setup' ? '初始化平台' : stage === 'register' ? '注册账号' : '登录工作台'}</h2>
    {stage === 'checking' && <p role="status">正在检查平台状态…</p>}
    {stage === 'checking' && error && <button type="button" onClick={() => { setError(''); setRetry(value => value + 1) }}>重试</button>}
    {stage === 'login' && <>
      <p className="gateway-auth-description">登录后查看你的电脑和项目。</p>
      {scanNotice && <p className="gateway-auth-error" role="alert">{scanNotice}</p>}
      <GatewayLoginForm busy={busy} onSubmit={signIn} />
      {mode !== 'closed' && <p><button className="gateway-auth-text-button" type="button" onClick={() => setStage('register')}>注册账号</button></p>}
      {sources.length > 0 && <div className="gateway-auth-external"><p>或使用企业身份登录</p>
        {sources.map(source => <button key={source.id} type="button" disabled={busy} onClick={() => void scan(source.id)}>
          {source.provider === 'dingtalk' ? '钉钉' : '企业微信'} · {source.tenant_id}
        </button>)}
      </div>}
    </>}
    {creating && <form className="gateway-auth-form" onSubmit={event => void submitAccount(event)}>
      {stage === 'setup' && <p className="gateway-auth-description">创建主管理员及独立恢复账号。恢复账号请单独保存。</p>}
      <label htmlFor="portal-username">用户名</label>
      <input id="portal-username" autoComplete="username" required value={account.username}
        onChange={event => setAccount({ ...account, username: event.target.value })} />
      <label htmlFor="portal-display-name">显示名称</label>
      <input id="portal-display-name" required value={account.display_name}
        onChange={event => setAccount({ ...account, display_name: event.target.value })} />
      <label htmlFor="portal-password">密码（至少 12 位）</label>
      <input id="portal-password" type="password" autoComplete="new-password" required minLength={12} value={account.password}
        onChange={event => setAccount({ ...account, password: event.target.value })} />
      <label htmlFor="portal-password-confirmation">确认密码</label>
      <input id="portal-password-confirmation" type="password" autoComplete="new-password" required value={confirmation}
        onChange={event => setConfirmation(event.target.value)} />
      {stage === 'setup' && <>
        <label htmlFor="portal-recovery-username">恢复账号用户名</label>
        <input id="portal-recovery-username" required value={recovery.username}
          onChange={event => setRecovery({ ...recovery, username: event.target.value })} />
        <label htmlFor="portal-recovery-password">恢复账号密码（至少 12 位）</label>
        <input id="portal-recovery-password" type="password" required minLength={12} value={recovery.password}
          onChange={event => setRecovery({ ...recovery, password: event.target.value })} />
        <label htmlFor="portal-registration-mode">注册策略</label>
        <select id="portal-registration-mode" value={registrationMode}
          onChange={event => setRegistrationMode(event.target.value as RegistrationMode)}>
          <option value="closed">关闭自助注册</option><option value="open_with_approval">注册后需审核</option>
          <option value="open">开放注册</option>
        </select>
      </>}
      {stage === 'register' && mode === 'open_with_approval' && <p>提交后需等待管理员审核。</p>}
      <button type="submit" disabled={busy || !valid}>{busy ? '正在提交…' : stage === 'setup' ? '完成初始化' : '注册'}</button>
      {stage === 'register' && <button className="gateway-auth-text-button" type="button" onClick={() => setStage('login')}>返回登录</button>}
    </form>}
    {error && <p className="gateway-auth-error" role="alert">{error}</p>}
    {stage !== 'checking' && <p className="gateway-auth-return"><Link to="/">返回工作台</Link></p>}
  </section>
}

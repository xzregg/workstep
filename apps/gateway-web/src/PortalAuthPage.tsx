import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { GatewayLoginForm } from './GatewayLoginForm'
import { scanFailureMessage } from './scanFailure'
import { GatewayRegistrationForm } from './GatewayRegistrationForm'
import { safeNextPath, validPortalAccount } from './portalAccount'
import type { RegistrationMode } from './portalAccount'
export { safeNextPath, validPortalAccount } from './portalAccount'

type IdentitySource = { id: string; provider: 'dingtalk' | 'wecom'; tenant_id: string }
type Account = { username: string; display_name: string; password: string }

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

  async function submitAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!valid || busy) return
    setBusy(true); setError('')
    try {
      if (stage === 'setup') {
        await post('/api/platform/setup', { ...account, recovery_username: recovery.username,
          recovery_password: recovery.password, registration_mode: registrationMode })
        navigate(next, { replace: true })
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
    {stage === 'setup' && <form className="gateway-auth-form" onSubmit={event => void submitAccount(event)}>
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
      <button type="submit" disabled={busy || !valid}>{busy ? '正在提交…' : stage === 'setup' ? '完成初始化' : '注册'}</button>
    </form>}
    {error && <p className="gateway-auth-error" role="alert">{error}</p>}
    {stage !== 'checking' && <p className="gateway-auth-return"><Link to="/">返回工作台</Link></p>}
  </section>
}

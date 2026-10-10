import { passwordRequirements, validPortalPassword } from './portalAccount'
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'

type User = { username: string; display_name: string; must_change_password: boolean }

export function validPasswordChange(current: string, next: string, confirmation: string, passwordRequired = true, username = ''): boolean {
  return (!passwordRequired || !!current) && validPortalPassword(username, next) && next !== current && next === confirmation
}

export function AccountPage() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<'checking' | 'ready' | 'expired'>('checking')
  const [user, setUser] = useState<User | null>(null)
  const [csrf, setCsrf] = useState('')
  const [passwordRequired, setPasswordRequired] = useState(true)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/auth/session', { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        if (!response.ok) { setStatus('expired'); return }
        const session = await response.json()
        if (!controller.signal.aborted) {
          setUser(session.user)
          setPasswordRequired(session.password_confirmation_required !== false)
          setCsrf(session.csrf_token)
          setStatus('ready')
        }
      })
      .catch(reason => { if (reason?.name !== 'AbortError') setError('无法检查登录状态，请刷新重试。') })
    return () => controller.abort()
  }, [])

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!validPasswordChange(current, next, confirmation, passwordRequired, user?.username ?? '')) return
    setBusy(true); setError(''); setNotice('')
    try {
      const response = await fetch('/api/auth/password', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ current_password: current, new_password: next }),
      })
      if (response.status === 401) { setStatus('expired'); return }
      if (!response.ok) throw new Error(response.status === 403 ? '当前密码不正确。' : '修改密码失败，请重试。')
      setCurrent(''); setNext(''); setConfirmation('')
      setNotice('密码已更新，其他登录会话已失效。')
      setUser(previous => previous ? { ...previous, must_change_password: false } : previous)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '修改密码失败。') }
    finally { setBusy(false) }
  }

  async function logout() {
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf },
      })
      if (!response.ok && response.status !== 401) throw new Error('退出登录失败，请重试。')
      navigate('/auth', { replace: true })
    } catch (reason) { setError(reason instanceof Error ? reason.message : '退出登录失败。') }
    finally { setBusy(false) }
  }

  return <section className="gateway-admin-page gateway-account-page">
    <span className="gateway-auth-eyebrow">WORKSTEP 平台</span>
    <h2>个人账户</h2>
    {status === 'checking' && <p role="status">正在检查登录状态…</p>}
    {status === 'expired' && <p>登录已失效。<Link to="/auth?next=%2Faccount">重新登录</Link></p>}
    {status === 'ready' && user && <>
      <dl className="gateway-account-summary">
        <div><dt>显示名称</dt><dd>{user.display_name}</dd></div>
        <div><dt>用户名</dt><dd>{user.username}</dd></div>
      </dl>
      <form className="gateway-auth-form gateway-account-form" onSubmit={event => void changePassword(event)}>
        <h3>修改密码</h3>
        {passwordRequired && <><label htmlFor="account-current-password">当前密码</label>
        <input id="account-current-password" type="password" autoComplete="current-password" value={current}
          onChange={event => setCurrent(event.target.value)} required /></>}
        <p>{passwordRequirements}</p>
        <label htmlFor="account-new-password">新密码（至少 8 位）</label>
        <input id="account-new-password" type="password" autoComplete="new-password" value={next}
          onChange={event => setNext(event.target.value)} required minLength={8} />
        <label htmlFor="account-confirm-password">确认新密码</label>
        <input id="account-confirm-password" type="password" autoComplete="new-password" value={confirmation}
          onChange={event => setConfirmation(event.target.value)} required />
        <button type="submit" disabled={busy || !validPasswordChange(current, next, confirmation, passwordRequired, user?.username ?? '')}>
          {busy ? '正在保存…' : '保存新密码'}
        </button>
      </form>
      <button className="gateway-account-logout" type="button" disabled={busy} onClick={() => void logout()}>退出登录</button>
    </>}
    {notice && <p role="status">{notice}</p>}
    {error && <p className="gateway-auth-error" role="alert">{error}</p>}
  </section>
}

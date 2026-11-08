import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { passwordRequirements, validPortalAccount } from './portalAccount'
import { AdminListStatus } from './AdminListStatus'

export function UserInvitationPage() {
  const { hash } = useLocation()
  const token = hash.slice(1)
  const [displayName, setDisplayName] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')
  const [signedIn, setSignedIn] = useState(false)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setDisplayName(''); setDone(''); setError(''); setLoading(true)
    void fetch('/api/auth/invitation/inspect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }), signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error([410, 422].includes(response.status) ? '邀请链接已失效，请联系管理员重新获取。' : '邀请链接加载失败，请重试。')
      const result = await response.json()
      if (!controller.signal.aborted) { setDisplayName(result.display_name); setUsername(result.username ?? '') }
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '邀请链接加载失败。')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [token, revision])

  const canSubmit = validPortalAccount(username, displayName, password) && password === confirmation
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!canSubmit || busy) return
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/auth/invitation/accept', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, username, password }),
      })
      if (!response.ok) throw new Error(response.status === 409 ? '登录名已被使用，请换一个。'
        : response.status === 410 ? '邀请链接已失效，请联系管理员重新获取。'
        : response.status === 422 ? '请检查登录名和密码是否符合要求。' : '设置失败，请稍后重试。')
      const result = await response.json()
      setDone(result.status); setSignedIn(result.signed_in === true); setPassword(''); setConfirmation('')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '设置失败，请重试。') }
    finally { setBusy(false) }
  }

  return <section className="gateway-auth-card">
    <h2>设置登录账号</h2>
    <AdminListStatus loading={loading} label="正在检查邀请链接…" />
    {error && <p className="gateway-auth-error" role="alert">{error}</p>}
    {!loading && !displayName && <button type="button" onClick={() => setRevision(value => value + 1)}>重试</button>}
    {done ? <><p role="status">{done === 'pending' ? '账号设置成功，请等待管理员审核。' : signedIn ? '账号设置成功并已登录，邀请链接已失效。' : '账号设置成功，邀请链接已失效。'}</p>
      <a href={signedIn ? '/' : '/auth'} className="gateway-action-link">{signedIn ? '进入工作台' : '前往登录'}</a></> : !loading && displayName && <>
      <p>你好，{displayName}。你可以设置或修改登录名和密码。</p>
      <form className="gateway-auth-form" onSubmit={event => void submit(event)}>
        <label htmlFor="invite-username">登录名</label>
        <input id="invite-username" autoComplete="username" value={username} required maxLength={64}
          onChange={event => setUsername(event.target.value)} disabled={busy} />
        <p>3–64 位，以小写字母开头，可包含小写字母、数字、下划线和连字符。</p>
        <label htmlFor="invite-password">密码</label>
        <input id="invite-password" type="password" autoComplete="new-password" required value={password}
          onChange={event => setPassword(event.target.value)} disabled={busy} />
        <p>{passwordRequirements}</p>
        <label htmlFor="invite-confirmation">确认密码</label>
        <input id="invite-confirmation" type="password" autoComplete="new-password" required value={confirmation}
          onChange={event => setConfirmation(event.target.value)} disabled={busy} />
        {confirmation && confirmation !== password && <p role="alert">两次输入的密码不一致。</p>}
        <button type="submit" disabled={!canSubmit || busy}>{busy && <span className="gateway-spinner" aria-hidden="true" />}{busy ? '正在保存…' : '完成设置'}</button>
      </form>
    </>}
  </section>
}

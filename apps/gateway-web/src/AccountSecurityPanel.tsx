import { useState, type FormEvent } from 'react'
import { passwordRequirements, validPortalPassword } from './portalAccount'

export function validPasswordChange(current: string, next: string, confirmation: string, passwordRequired = true, username = ''): boolean {
  return (!passwordRequired || !!current) && validPortalPassword(username, next) && next !== current && next === confirmation
}


export function AccountSecurityPanel({user, csrf, passwordRequired, onExpired}: {
 user: {username:string}; csrf:string; passwordRequired:boolean; onExpired:()=>void
}) {
 const [current,setCurrent]=useState('')
 const [next,setNext]=useState('')
 const [confirmation,setConfirmation]=useState('')
 const [busy,setBusy]=useState(false)
 const [error,setError]=useState('')
 const [notice,setNotice]=useState('')
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
      if (response.status === 401) { onExpired(); return }
      if (!response.ok) throw new Error(response.status === 403 ? '当前密码不正确。' : '修改密码失败，请重试。')
      setCurrent(''); setNext(''); setConfirmation('')
      setNotice('密码已更新，其他登录会话已失效。')
      window.dispatchEvent(new Event('gateway-auth-changed'))
    } catch (reason) { setError(reason instanceof Error ? reason.message : '修改密码失败。') }
    finally { setBusy(false) }
  }

 return <section className="gateway-center-panel gateway-security-panel" aria-labelledby="account-security-title">
  <div><h3 id="account-security-title">修改登录密码</h3><p className="gateway-center-muted">更新密码后，其他设备上的登录会话将失效。</p></div>
  <form className="gateway-center-form" onSubmit={event=>void changePassword(event)}>
   {passwordRequired && <label>当前密码<input type="password" autoComplete="current-password" value={current} disabled={busy} onChange={event=>setCurrent(event.target.value)} required maxLength={128}/></label>}
   <label>新密码（至少 8 位）<input type="password" autoComplete="new-password" value={next} disabled={busy} onChange={event=>setNext(event.target.value)} required minLength={8} maxLength={128}/></label>
   <p className="gateway-center-muted">{passwordRequirements}</p>
   <label>确认新密码<input type="password" autoComplete="new-password" value={confirmation} disabled={busy} onChange={event=>setConfirmation(event.target.value)} required maxLength={128}/></label>
   {confirmation && confirmation!==next && <p role="alert" className="gateway-auth-error">两次输入的密码不一致。</p>}
   <div><button className="gateway-admin-primary" type="submit" disabled={busy || !validPasswordChange(current,next,confirmation,passwordRequired,user.username)}>{busy ? <><span className="gateway-spinner"/> 正在保存…</> : '保存新密码'}</button></div>
   {notice && <p className="gateway-center-success" role="status">{notice}</p>}
   {error && <p className="gateway-auth-error" role="alert">{error}</p>}
  </form>
 </section>
}

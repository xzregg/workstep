import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { NotificationCenter } from './NotificationCenter'

export function PortalHeader({ hasAdminAccess, signedIn = false, checking = false }: { hasAdminAccess: boolean; signedIn?: boolean; checking?: boolean }) {
 const navigate = useNavigate()
 const {pathname}=useLocation()
 const navigation=useRef<HTMLElement>(null)
 useEffect(()=>{
  navigation.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({block:'nearest',inline:'nearest'})
 },[pathname])
 const [busy, setBusy] = useState(false)
 const [error, setError] = useState('')
 const pending = useRef(false)
 async function logout() {
  if (pending.current) return
  pending.current = true; setBusy(true); setError('')
  try {
   const session = await fetch('/api/auth/session', { credentials: 'same-origin' })
   if (session.status !== 401) {
    if (!session.ok) throw Error('登出失败，请重试。')
    const data = await session.json()
    const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': data.csrf_token } })
    if (!response.ok && response.status !== 401) throw Error('登出失败，请重试。')
   }
   window.dispatchEvent(new Event('gateway-auth-changed'))
   navigate('/auth', { replace: true })
  } catch { setError('登出失败，请重试。') }
  finally { pending.current = false; setBusy(false) }
 }
 return <header className="gateway-portal-header">
  <h1>WORKSTEP <span>平台</span></h1>
  <nav ref={navigation} className="gateway-portal-navigation" aria-label="工作台导航">
   <NavLink to="/" end>我的 WorkStep</NavLink>
   <NavLink to="/project-invitations">项目分享与添加</NavLink>
   <NavLink className="gateway-portal-account" to="/account">用户中心</NavLink>
   {hasAdminAccess && <NavLink to="/admin">管理后台</NavLink>}
  </nav>
  {signedIn && <NotificationCenter/>}
  {checking ? <span role="status">正在检查登录状态…</span> : signedIn
   ? <button className="gateway-portal-sign-in gateway-portal-sign-out" type="button" disabled={busy} onClick={() => void logout()}>{busy ? <><span className="gateway-spinner" /> 正在登出…</> : '登出'}</button>
   : <Link className="gateway-action-link gateway-portal-sign-in gateway-action-link--primary" to="/auth">登录 / 注册</Link>}
  {error && <p role="alert" className="gateway-auth-error">{error}</p>}
 </header>
}

import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { AdminTabs } from './AdminTabs'
import { loginUsername } from './AdminSelection'
import { AccountSecurityPanel } from './AccountSecurityPanel'
import { AccountUsagePanel } from './AccountUsagePanel'
export { validPasswordChange } from './AccountSecurityPanel'

type User = {id?:string; username:string; display_name:string; must_change_password?:boolean}
export function AccountPage() {
 const navigate=useNavigate()
 const [params,setParams]=useSearchParams()
 const tab=params.get('view')==='security'?'security':'overview'
 const [status,setStatus]=useState<'checking'|'ready'|'expired'|'error'>('checking')
 const [session,setSession]=useState<{user:User;csrf_token:string;password_confirmation_required?:boolean}|null>(null)
 const [revision,setRevision]=useState(0)
 const [busy,setBusy]=useState(false)
 const [error,setError]=useState('')
 const expire=useCallback(()=>setStatus('expired'),[])
 useEffect(()=>{
  const controller=new AbortController()
  setStatus('checking')
  void fetch('/api/auth/session',{credentials:'same-origin',signal:controller.signal}).then(async response=>{
   if(response.status===401){if(!controller.signal.aborted)setStatus('expired');return}
   if(!response.ok)throw Error('session')
   const data=await response.json()
   if(!controller.signal.aborted){setSession(data);setStatus('ready')}
  }).catch(()=>{if(!controller.signal.aborted)setStatus('error')})
  return ()=>controller.abort()
 },[revision])
 async function logout(){
  if(busy || !session)return
  setBusy(true);setError('')
  try{
   const response=await fetch('/api/auth/logout',{method:'POST',credentials:'same-origin',headers:{'X-CSRF-Token':session.csrf_token}})
   if(!response.ok && response.status!==401)throw Error('退出登录失败，请重试。')
   window.dispatchEvent(new Event('gateway-auth-changed'))
   navigate('/auth',{replace:true})
  }catch(reason){setError(reason instanceof Error?reason.message:'退出登录失败。')}
  finally{setBusy(false)}
 }
 return <section className="gateway-admin-page gateway-account-center">
  <div className="gateway-center-page-heading"><div><span className="gateway-center-eyebrow">WORKSTEP</span><h2>用户中心</h2><p>查看你的使用情况，管理账号安全。</p></div><Link className="gateway-action-link gateway-center-back" to="/">进入工作台 <span aria-hidden="true">↗</span></Link></div>
  {status==='checking' && <p className="gateway-center-state" role="status"><span className="gateway-spinner"/> 正在检查登录状态…</p>}
  {status==='expired' && <p className="gateway-center-state">登录已失效。<Link className="gateway-action-link" to="/auth?next=%2Faccount">重新登录</Link></p>}
  {status==='error' && <p className="gateway-center-state" role="alert">无法检查登录状态。<button onClick={()=>setRevision(value=>value+1)}>重试</button></p>}
  {status==='ready' && session && <>
   <div className="gateway-center-profile"><div className="gateway-center-avatar" aria-hidden="true">{Array.from(session.user.display_name || session.user.username)[0]}</div><div className="gateway-center-profile-name"><h3>{session.user.display_name || session.user.username}</h3><p>{loginUsername(session.user) ? `登录用户名：${loginUsername(session.user)}` : '企业账号'}</p></div><span className="gateway-center-account-state">已登录</span><button type="button" className="gateway-center-logout" disabled={busy} onClick={()=>void logout()}>{busy?<><span className="gateway-spinner"/> 正在退出…</>:'退出登录'}</button></div>
   {error && <p className="gateway-auth-error" role="alert">{error}</p>}
   <AdminTabs label="用户中心" value={tab} onChange={value=>setParams(value==='security'?{view:'security'}:{})} items={[
    {id:'overview',label:'用量概览',content:<AccountUsagePanel onExpired={expire}/>},
    {id:'security',label:'安全设置',content:<AccountSecurityPanel user={session.user} csrf={session.csrf_token} passwordRequired={session.password_confirmation_required!==false} onExpired={expire}/>},
   ]}/>
  </>}
 </section>
}

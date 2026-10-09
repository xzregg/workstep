import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { GatewayModal } from './GatewayModal'

type Notice = {source_id: string; at: string; error?: string; result?: Record<string, number>}
export function OrganizationSyncNotice() {
 const [notices,setNotices]=useState<Notice[]>([])
 const [available,setAvailable]=useState(false)
 const [open,setOpen]=useState(false)
 const [error,setError]=useState('')
 const [reading,setReading]=useState<string[]>([])
 const pending=useRef(new Set<string>())
 useEffect(()=>{
  const controller=new AbortController(); let timer: ReturnType<typeof setTimeout>
  async function poll() {
   try {
    const response=await fetch('/api/admin/directory-notices',{credentials:'same-origin',signal:controller.signal})
    if (response.status===403 || response.status===401) return
    if (response.ok) {setAvailable(true);const data=await response.json(); if(!controller.signal.aborted) setNotices(data.notices ?? [])}
   } catch { /* Retry on the next poll. */ }
   if (!controller.signal.aborted) timer=setTimeout(()=>void poll(),60000)
  }
  void poll()
  return ()=>{controller.abort();clearTimeout(timer)}
 },[])
 async function read(notice: Notice) {
  if(pending.current.has(notice.source_id)) return
  pending.current.add(notice.source_id);setReading([...pending.current]);setError('')
  try {
   const session=await fetch('/api/auth/session',{credentials:'same-origin'})
   if (!session.ok) throw Error()
   const auth=await session.json()
   const response=await fetch('/api/admin/directory-notices/read',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':auth.csrf_token},body:JSON.stringify({source_id:notice.source_id,at:notice.at})})
   if (!response.ok) throw Error()
   setNotices(current=>current.filter(item=>item.source_id!==notice.source_id || item.at!==notice.at))
  } catch {setError('标记已读失败，请重试。')}
  finally {pending.current.delete(notice.source_id);setReading([...pending.current])}
 }
 if(!available) return null
 return <><button type="button" onClick={()=>setOpen(true)}>组织同步{notices.length ? ` (${notices.length})` : ''}</button>
  {open && <GatewayModal title="组织同步提示" onClose={()=>setOpen(false)} footer={<button type="button" onClick={()=>setOpen(false)}>关闭</button>}>
   {!notices.length && <p>没有未读的组织同步提示。</p>}
   {notices.map(notice=><article key={notice.source_id}><p>{new Date(notice.at).toLocaleString()} · {notice.error ? '同步失败，请检查应用权限和密钥；已配置的自动同步会按策略重试。' : `新增 ${notice.result?.people_added ?? 0} 人 · 资料更新 ${notice.result?.people_updated ?? 0} 人 · 调部门 ${notice.result?.people_transferred ?? 0} 人 · 停用 ${notice.result?.people_departed ?? 0} 人 · 待核实 ${notice.result?.people_unverified ?? 0} 人 · 组织变更 ${(notice.result?.departments_added ?? 0)+(notice.result?.departments_updated ?? 0)+(notice.result?.departments_moved ?? 0)+(notice.result?.departments_deleted ?? 0)} 项`}</p><button type="button" disabled={reading.includes(notice.source_id)} onClick={()=>void read(notice)}>{reading.includes(notice.source_id) && <span className="gateway-spinner"/>}标记已读</button></article>)}
   <Link to="/admin/settings" onClick={()=>setOpen(false)}>查看应用配置及同步记录</Link>
   {error && <p role="alert">{error}</p>}
  </GatewayModal>}
 </>
}

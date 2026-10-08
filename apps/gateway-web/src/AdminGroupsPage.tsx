import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AdminGroupLifecyclePanel } from './AdminGroupLifecyclePanel'
import { AdminGroupCreateDialog } from './AdminGroupCreateDialog'
import { GroupMembersManager } from './GroupMembersManager'
import { GroupProjectsManager } from './GroupProjectsManager'

export function AdminGroupsPage() {
 const [csrf,setCsrf]=useState('')
 const [groupId,setGroupId]=useState('')
 const [revision,setRevision]=useState(0)
 const [createOpen,setCreateOpen]=useState(false)
 const [error,setError]=useState('')
 useEffect(()=>{
  const controller=new AbortController()
  void fetch('/api/auth/session',{credentials:'same-origin',signal:controller.signal}).then(async response=>{
   if(!response.ok)throw Error('登录状态加载失败，请刷新重试。')
   const data=await response.json();if(!controller.signal.aborted)setCsrf(data.csrf_token)
  }).catch(reason=>{if(!controller.signal.aborted)setError(reason.message)})
  return()=>controller.abort()
 },[])
 return <section className="gateway-admin-page">
  <span className="gateway-auth-eyebrow">WORKSTEP 平台 · ADMIN</span>
  <div className="gateway-admin-toolbar"><h2>用户组管理</h2><Link to="/admin">返回管理概览</Link></div>
  {error && <p role="alert" className="gateway-auth-error">{error}</p>}
  <div className="gateway-users-workspace"><div className="gateway-users-tree-panel">
   <AdminGroupLifecyclePanel csrf={csrf} selected={groupId} revision={revision} onSelect={setGroupId} onChanged={()=>setRevision(value=>value+1)}/>
   <button type="button" disabled={!csrf} onClick={()=>setCreateOpen(true)}>创建用户组</button>
  </div><div className="gateway-users-table-panel">
   {groupId ? <>
    <GroupMembersManager key={'members-'+groupId} groupId={groupId} csrf={csrf} onChanged={()=>setRevision(value=>value+1)}/>
    <GroupProjectsManager key={'projects-'+groupId} groupId={groupId} csrf={csrf}/>
   </> : <p>选择左侧用户组，管理成员与项目关联。</p>}
  </div></div>
  {createOpen && <AdminGroupCreateDialog csrf={csrf} onClose={()=>setCreateOpen(false)} onDone={id=>{
   setCreateOpen(false);setGroupId(id);setRevision(value=>value+1)
  }}/>}
 </section>
}

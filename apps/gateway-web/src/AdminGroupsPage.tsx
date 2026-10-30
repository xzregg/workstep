import { useAdminSession } from './useAdminSession'
import { AdminSessionStatus } from './AdminSessionStatus'
import { useState } from 'react'
import { AdminGroupLifecyclePanel } from './AdminGroupLifecyclePanel'
import { AdminGroupCreateDialog } from './AdminGroupCreateDialog'
import { GroupMembersManager } from './GroupMembersManager'
import { GroupProjectsManager } from './GroupProjectsManager'

export function AdminGroupsPage() {
 const session = useAdminSession()
  const csrf = session.csrf
 const [groupId,setGroupId]=useState('')
 const [revision,setRevision]=useState(0)
 const [createOpen,setCreateOpen]=useState(false)
 return <section className="gateway-admin-page">
  <AdminSessionStatus loading={session.loading} error={session.error} onRetry={session.retry} />
    <span className="gateway-auth-eyebrow">WORKSTEP 平台 · ADMIN</span>
  <div className="gateway-admin-toolbar"><h2>用户组管理</h2></div>

  <div className="gateway-admin-toolbar"><button type="button" className="gateway-admin-primary" disabled={!csrf} onClick={()=>setCreateOpen(true)}>创建用户组</button></div>
  <div className="gateway-users-workspace"><div className="gateway-users-tree-panel">
   <AdminGroupLifecyclePanel csrf={csrf} selected={groupId} revision={revision} onSelect={setGroupId} onChanged={()=>setRevision(value=>value+1)}/>
  </div><div className="gateway-users-table-panel">
   {groupId ? <>
    <GroupMembersManager key={'members-'+groupId} groupId={groupId} csrf={csrf} onChanged={()=>setRevision(value=>value+1)}/>
    <GroupProjectsManager key={'projects-'+groupId} groupId={groupId} csrf={csrf}/>
   </> : <p>选择左侧用户组，管理成员与项目关联。</p>}
  </div></div>
  {createOpen && <AdminGroupCreateDialog csrf={csrf} defaultParentId={groupId} onClose={()=>setCreateOpen(false)} onDone={id=>{
   setCreateOpen(false);setGroupId(id);setRevision(value=>value+1)
  }}/>}
 </section>
}

import { useState } from 'react'
import { AdminRecordTable } from './AdminRecordTable'
import { AdminSelectAll, loginUsername, useAdminSelection } from './AdminSelection'
import { AdminBulkActionDialog } from './AdminBulkActionDialog'
import type { BulkAction } from './AdminBulkActionDialog'
import { AdminUserActionDialog } from './AdminUserActionDialog'
import type { AdminUser } from './AdminUsersPage'

const sources: Record<string,string> = {local:'自主注册',admin_created:'管理员创建',directory_sync:'组织同步',dingtalk:'钉钉',wecom:'企业微信'}
export function AdminUserTable({users, csrf, loading, resetKey, onRefresh}: {
 users: AdminUser[]; csrf: string; loading: boolean; resetKey: unknown; onRefresh: () => void
}) {
 const selectable = users.filter(user=>!user.is_recovery).map(user=>user.id)
 const {selected, setSelected, toggle} = useAdminSelection(selectable, resetKey)
 const [bulk, setBulk] = useState<BulkAction|null>(null)
 const [single, setSingle] = useState<{user:AdminUser; kind:'approve'|'disable'}|null>(null)
 const [notice, setNotice] = useState('')
 const chosen = users.filter(user=>selected.includes(user.id))
 function action(kind:'approve'|'enable'|'disable'|'delete'|'restore'|'purge', ids = selected) {
  const verb = {approve:'批准',enable:'启用',disable:'停用',delete:'删除',restore:'恢复',purge:'彻底删除'}[kind]
  setBulk({title:`批量${verb}用户`,label:`确认${verb}`,url:'/api/admin/users/bulk',
   body:{action:kind,user_ids:ids},password:['disable','delete','restore','purge'].includes(kind),
   message:`确认${verb}所选 ${ids.length} 位用户？${kind==='disable'?'这些用户的登录会话将立即失效。':kind==='delete'?'登录和现有会话将失效，历史记录保留，可在“已删除”列表恢复。':kind==='purge'?'账号及访问授权将永久删除，无法恢复。历史审计保留；同步不会重新创建该企业用户。':kind==='restore'?'恢复后为停用状态，请核对权限后再启用。':''}`})
 }
 return <>
  <div className="gateway-bulk-toolbar" aria-label="用户批量操作"><span>已选 {selected.length} 位用户</span>
   <button type="button" disabled={loading || !chosen.length || chosen.some(user=>user.status!=='pending')} onClick={()=>action('approve')}>批量批准</button>
   <button type="button" disabled={loading || !chosen.length || chosen.some(user=>user.status!=='disabled')} onClick={()=>action('enable')}>批量启用</button>
   <button type="button" disabled={loading || !chosen.length || chosen.some(user=>['disabled','deleted'].includes(user.status))} onClick={()=>action('disable')}>批量停用</button>
   <button type="button" disabled={loading || !chosen.length || chosen.some(user=>user.status==='deleted') || chosen.length>100} onClick={()=>action('delete')}>批量删除</button>
   {users.some(user=>user.status==='deleted') && <button type="button" disabled={loading || !chosen.length || chosen.some(user=>user.status!=='deleted') || chosen.length>100} onClick={()=>action('restore')}>批量恢复</button>}
   {users.some(user=>user.status==='deleted') && <button type="button" disabled={loading || !chosen.length || chosen.some(user=>user.status!=='deleted') || chosen.length>100} onClick={()=>action('purge')}>批量彻底删除</button>}
   {!!selected.length && <button type="button" onClick={()=>setSelected([])}>取消选择</button>}
  </div>
  {notice && <p role="status">{notice}</p>}
  <AdminRecordTable columns={[<AdminSelectAll ids={selectable} selected={selected} onChange={setSelected} disabled={loading}/>, '显示名', '登录用户名', '状态', '注册来源', '操作']}>
   {users.map(user=><tr key={user.id}>
    <td><input type="checkbox" className="gateway-table-checkbox" aria-label={`选择${user.display_name}`} checked={selected.includes(user.id)} disabled={loading || user.is_recovery} onChange={event=>toggle(user.id,event.target.checked)}/></td>
    <td><strong>{user.display_name}</strong>{user.must_change_password && <small className="gateway-person-note">首次登录需修改密码</small>}</td>
    <td><span className="gateway-login-name" title={loginUsername(user) ?? '使用企业身份登录'}>{loginUsername(user) ?? '扫码登录'}</span></td>
    <td>{user.status==='pending'?'待审核':user.status==='disabled'?'已停用':user.status==='deleted'?'已删除':'已启用'}</td>
    <td>{sources[user.registration_source] ?? user.registration_source}</td>
    <td><div className="gateway-row-actions">
     {user.status==='pending' && <button type="button" disabled={loading || user.is_recovery} onClick={()=>setSingle({user,kind:'approve'})}>批准</button>}
     {user.status==='deleted' ? <button type="button" disabled={loading || user.is_recovery} onClick={()=>action('restore',[user.id])}>恢复</button> : user.status==='disabled' ? <button type="button" disabled={loading || user.is_recovery} onClick={()=>action('enable',[user.id])}>启用</button>
      : <button type="button" disabled={loading || user.is_recovery} onClick={()=>setSingle({user,kind:'disable'})}>停用</button>}
     {user.status!=='deleted' && <button type="button" disabled={loading || user.is_recovery} onClick={()=>action('delete',[user.id])}>删除</button>}
     {user.status==='deleted' && <button type="button" disabled={loading || user.is_recovery} onClick={()=>action('purge',[user.id])}>彻底删除</button>}
     {user.is_recovery && <span className="gateway-person-note">受保护账号</span>}
    </div></td>
   </tr>)}
  </AdminRecordTable>
  {bulk && <AdminBulkActionDialog action={bulk} csrf={csrf} onClose={()=>setBulk(null)} onDone={()=>{
   setNotice('所选用户操作成功。');setBulk(null);setSelected([]);onRefresh()
  }}/>}
  {single && <AdminUserActionDialog user={single.user} action={single.kind} csrf={csrf} onClose={()=>setSingle(null)} onComplete={()=>{setSingle(null);setSelected([]);onRefresh()}}/>}
 </>
}

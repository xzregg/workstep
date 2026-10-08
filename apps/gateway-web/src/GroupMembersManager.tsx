import { useEffect, useRef, useState } from 'react'
import { AdminRecordTable } from './AdminRecordTable'
import { AdminPersonName, AdminSelectAll, useAdminSelection } from './AdminSelection'
import { AdminBulkActionDialog } from './AdminBulkActionDialog'
import type { BulkAction } from './AdminBulkActionDialog'

type Person = {id: string; username: string; display_name: string; login_username?: string | null}
type Member = Omit<Person,'id'> & {user_id: string; role: string; source: string}
export function GroupMembersManager({groupId, csrf, onChanged}: {
 groupId: string; csrf: string; onChanged: () => void
}) {
 const [members, setMembers] = useState<Member[]>([])
 const [matches, setMatches] = useState<Person[]>([])
 const [query, setQuery] = useState('')
 const [role, setRole] = useState<'member'|'leader'>('member')
 const [loading, setLoading] = useState(true)
 const [searching, setSearching] = useState(false)
 const [searched, setSearched] = useState(false)
 const [error, setError] = useState('')
 const [revision, setRevision] = useState(0)
 const [action, setAction] = useState<BulkAction|null>(null)
 const [notice, setNotice] = useState('')
 const searchController = useRef<AbortController|null>(null)
 const base = `/api/groups/${encodeURIComponent(groupId)}/members`
 const selection = useAdminSelection(members.filter(member=>member.source==='manual').map(member=>member.user_id), revision)
 const additions = useAdminSelection(matches.filter(user=>!members.some(member=>member.user_id===user.id)).map(user=>user.id), query)
 useEffect(()=>{
  const controller = new AbortController(); setLoading(true);setError('')
  void fetch(base,{credentials:'same-origin',signal:controller.signal}).then(async response=>{
   if(!response.ok)throw Error('成员加载失败，请检查管理权限后重试。')
   const result=await response.json(); if(!controller.signal.aborted)setMembers(result.members ?? [])
  }).catch(reason=>{if(!controller.signal.aborted)setError(reason.message)})
   .finally(()=>{if(!controller.signal.aborted)setLoading(false)})
  return()=>controller.abort()
 },[base,revision])
 useEffect(()=>()=>searchController.current?.abort(),[])
 async function search() {
  searchController.current?.abort(); const controller=new AbortController();searchController.current=controller
  setSearching(true);setError('');additions.setSelected([])
  try {
   const response=await fetch(`/api/admin/users?${new URLSearchParams({q:query.trim(),status:'active',page_size:'100'})}`,{credentials:'same-origin',signal:controller.signal})
   if(!response.ok)throw Error('用户搜索失败，请重试。')
   const result=await response.json();if(!controller.signal.aborted){setMatches(result.users ?? []);setSearched(true)}
  }catch(reason){if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'搜索失败。')}
  finally{if(!controller.signal.aborted)setSearching(false)}
 }
 function change(kind:'add'|'remove'|'set_role', ids:string[], targetRole=role) {
  if(!ids.length)return
  const verb={add:'添加',remove:'移除',set_role:'调整角色'}[kind]
  setAction({title:kind==='set_role'?'调整成员角色':`${verb}成员`,label:`确认${verb}`,url:base+'/bulk',
   body:{action:kind,user_ids:ids,...(kind==='remove'?{}:{role:targetRole})},
   message:kind==='remove'?`确认从本组移除所选 ${ids.length} 位成员？用户账号会保留。`
    :`确认将所选 ${ids.length} 位用户${kind==='add'?'添加到本组并设为':'设为'}${targetRole==='leader'?'组长':'普通成员'}？`})
 }
 const ids=members.filter(member=>member.source==='manual').map(member=>member.user_id)
 const available=matches.filter(user=>!members.some(member=>member.user_id===user.id)).map(user=>user.id)
 return <section className="gateway-group-section" aria-label="成员管理">
  <div className="gateway-admin-toolbar"><h3>成员与组长</h3><span>{members.length} 位成员</span></div>
  <form className="gateway-admin-search" onSubmit={event=>{event.preventDefault();void search()}}>
   <label>搜索用户<input placeholder="显示名或登录用户名" value={query} onChange={event=>setQuery(event.target.value)}/></label>
   <button type="submit" disabled={searching}>{searching && <span className="gateway-spinner"/>}查找用户</button>
  </form>
  <div className="gateway-bulk-toolbar"><label>成员角色<select value={role} onChange={event=>setRole(event.target.value as 'member'|'leader')}>
   <option value="member">普通成员</option><option value="leader">组长</option></select></label>
   <span>选中 {additions.selected.length} 位待添加用户</span>
   <button type="button" disabled={!csrf || !additions.selected.length || loading || searching} onClick={()=>change('add',additions.selected)}>批量添加成员</button>
  </div>
  {searched && <AdminRecordTable columns={[<AdminSelectAll ids={available} selected={additions.selected} onChange={additions.setSelected} disabled={searching}/>, '待添加用户', '操作']}>
   {matches.map(user=>{const exists=!available.includes(user.id);return <tr key={user.id}>
    <td><input className="gateway-table-checkbox" type="checkbox" aria-label={`选择待添加用户${user.display_name}`} disabled={exists || searching} checked={additions.selected.includes(user.id)} onChange={event=>additions.toggle(user.id,event.target.checked)}/></td>
    <td><AdminPersonName user={user}/></td><td><button type="button" disabled={exists || !csrf || loading} aria-label={`添加 ${user.display_name} 为${role==='leader'?'组长':'成员'}`} onClick={()=>change('add',[user.id])}>{exists?'已加入':'添加'}</button></td>
   </tr>})}
  </AdminRecordTable>}
  {searched && !matches.length && <p>没有匹配的用户。</p>}
  {error && <p role="alert" className="gateway-auth-error">{error}<button type="button" onClick={()=>setRevision(value=>value+1)}>重试</button></p>}
  {loading && <p role="status"><span className="gateway-spinner"/>正在加载成员…</p>}
  {notice && <p role="status">{notice}</p>}
  <div className="gateway-bulk-toolbar" aria-label="成员批量操作"><span>已选 {selection.selected.length} 位成员</span>
   <button type="button" disabled={loading || !csrf || !selection.selected.length || selection.selected.length>100} onClick={()=>change('set_role',selection.selected)}>批量调整角色</button>
   <button type="button" disabled={loading || !csrf || !selection.selected.length || selection.selected.length>100} onClick={()=>change('remove',selection.selected)}>批量移除成员</button>
   {!!selection.selected.length && <button type="button" onClick={()=>selection.setSelected([])}>取消选择</button>}
  </div>
  {selection.selected.length>100 && <p role="status">每批最多操作 100 位成员，请减少勾选后分批处理。</p>}
  <AdminRecordTable columns={[<AdminSelectAll ids={ids} selected={selection.selected} onChange={selection.setSelected} disabled={loading}/>, '显示名 / 登录账号', '角色', '成员来源', '操作']}>
   {members.map(member=><tr key={member.user_id}>
    <td><input className="gateway-table-checkbox" type="checkbox" aria-label={`选择${member.display_name}`} disabled={loading || member.source!=='manual'} checked={selection.selected.includes(member.user_id)} onChange={event=>selection.toggle(member.user_id,event.target.checked)}/></td>
    <td><AdminPersonName user={member}/></td><td>{member.role==='leader'?'组长':'普通成员'}</td>
    <td>{member.source==='manual'?'手工添加':'组织同步'}</td>
    <td>{member.source==='manual'?<div className="gateway-row-actions">
     <button type="button" disabled={loading || !csrf} aria-label={`调整${member.display_name}的角色`} onClick={()=>change('set_role',[member.user_id],member.role==='leader'?'member':'leader')}>{member.role==='leader'?'设为成员':'设为组长'}</button>
     <button type="button" disabled={loading || !csrf} aria-label={`移除 ${member.display_name}`} onClick={()=>change('remove',[member.user_id])}>移除</button>
    </div>:<span className="gateway-person-note" title="请在钉钉或企业微信中调整，再同步组织">由组织同步管理</span>}</td>
   </tr>)}
  </AdminRecordTable>
  {!loading && !members.length && <p>尚无成员。</p>}
  {action && <AdminBulkActionDialog action={action} csrf={csrf} onClose={()=>setAction(null)} onDone={()=>{
   setAction(null);selection.setSelected([]);additions.setSelected([]);setNotice('成员操作成功。');setRevision(value=>value+1);onChanged()
  }}/>}
 </section>
}

import { useEffect, useRef, useState } from 'react'
import { AdminRecordTable } from './AdminRecordTable'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

type Project={id:string;name:string;device_name?:string;access_mode?:string}
export function GroupProjectsManager({groupId,csrf}: {groupId:string;csrf:string}) {
 const [projects,setProjects]=useState<Project[]>([])
 const [matches,setMatches]=useState<Project[]>([])
 const [query,setQuery]=useState('')
 const [revision,setRevision]=useState(0)
 const [error,setError]=useState('')
 const [busy,setBusy]=useState(false)
 const [loading,setLoading]=useState(true)
 const [searching,setSearching]=useState(false)
 const [remove,setRemove]=useState<Project|null>(null)
 const writing=useRef(false)
 const searchController=useRef<AbortController|null>(null)
 const base=`/api/groups/${encodeURIComponent(groupId)}/projects`
 useEffect(()=>{
  const controller=new AbortController();setLoading(true);setError('')
  void fetch(base,{credentials:'same-origin',signal:controller.signal}).then(async response=>{
   if(!response.ok)throw Error('关联项目加载失败。')
   const data=await response.json();if(!controller.signal.aborted)setProjects(data.projects ?? [])
  }).catch(reason=>{if(!controller.signal.aborted)setError(reason.message)})
   .finally(()=>{if(!controller.signal.aborted)setLoading(false)})
  return()=>controller.abort()
 },[base,revision])
 useEffect(()=>()=>searchController.current?.abort(),[])
 async function search() {
  searchController.current?.abort();const controller=new AbortController();searchController.current=controller;setSearching(true);setError('')
  try{
   const response=await fetch(`/api/groups/linkable-projects?${new URLSearchParams({q:query.trim(),page_size:'25'})}`,{credentials:'same-origin',signal:controller.signal})
   if(!response.ok)throw Error('项目搜索失败。')
   const data=await response.json();if(!controller.signal.aborted)setMatches(data.projects ?? [])
  }catch(reason){if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'项目搜索失败。')}
  finally{if(!controller.signal.aborted)setSearching(false)}
 }
 async function write(project:Project, unlink=false) {
  if(writing.current || !csrf)return
  writing.current=true;setBusy(true);setError('')
  try{
   const response=await fetch(unlink?base+'/'+encodeURIComponent(project.id):base,{method:unlink?'DELETE':'POST',credentials:'same-origin',
    headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:unlink?undefined:JSON.stringify({project_id:project.id})})
   if(!response.ok)throw Error('项目关联操作失败，请检查权限后重试。')
   setRemove(null);setRevision(value=>value+1)
  }catch(reason){setError(reason instanceof Error?reason.message:'操作失败。')}
  finally{writing.current=false;setBusy(false)}
 }
 return <section className="gateway-group-section" aria-label="项目关联管理"><h3>关联项目</h3>
  <p>关联仅用于 Skill 策略，不授予项目内容读取或整台电脑访问权。</p>
  <form className="gateway-admin-search" onSubmit={event=>{event.preventDefault();void search()}}><label>搜索项目<input value={query} onChange={event=>setQuery(event.target.value)}/></label>
   <button type="submit" disabled={searching}>{searching && <span className="gateway-spinner"/>}查找项目</button></form>
  {matches.length>0 && <AdminRecordTable columns={['项目','设备','状态','操作']}>{matches.map(project=><tr key={project.id}>
   <td>{project.name}</td><td>{project.device_name ?? '—'}</td><td>{project.access_mode==='policy_only'?'仅 Skill 策略':'已发布'}</td>
   <td><button type="button" disabled={busy || loading || !csrf || projects.some(item=>item.id===project.id)} aria-label={`关联${project.name}`} onClick={()=>void write(project)}>关联</button></td>
  </tr>)}</AdminRecordTable>}
  {error && <p role="alert" className="gateway-auth-error">{error}<button type="button" onClick={()=>setRevision(value=>value+1)}>重试</button></p>}
  {(busy || loading) && <p role="status"><span className="gateway-spinner"/>正在{busy?'更新':'加载'}项目关联…</p>}
  <AdminRecordTable columns={['已关联项目','操作']}>{projects.map(project=><tr key={project.id}>
   <td>{project.name}</td><td><button type="button" disabled={busy || loading || !csrf} aria-label={`取消关联${project.name}`} onClick={()=>setRemove(project)}>取消关联</button></td>
  </tr>)}</AdminRecordTable>
  {!loading && !projects.length && <p>尚无关联项目。</p>}
  {remove && <GatewayConfirmDialog title="取消项目关联" message="关联取消后，本组来源的项目 Skill 分配会撤销。" confirmLabel="确认取消关联" busy={busy} onCancel={()=>setRemove(null)} onConfirm={()=>void write(remove,true)}/>}
 </section>
}

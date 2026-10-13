import { OrganizationSyncUsers, type SyncUser } from './OrganizationSyncUsers'
import { OrganizationSyncResult, type SyncResult } from './OrganizationSyncResult'
import { useEffect, useRef, useState } from 'react'
import { GatewayModal } from './GatewayModal'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

import { DepartmentSelectionTree } from './DepartmentSelectionTree'
import type { Department } from './DepartmentSelectionTree'
import { subtreeIds } from './TreeSelection'
import {departmentRoots,departmentScope,policySubjects,selectionSignature,userDepartmentScope,summarizeSelection,type MaintenanceMode,type MaintenancePolicy} from './OrganizationSyncSelection'
type Job = { id?: string; status: 'idle' | 'queued' | 'fetching' | 'applying' | 'completed' | 'preview' | 'failed';
 cache_expires_at?: string;
 department_ids?: string[]; selection_department_ids?: string[];
 departments?: Department[]; preview_requested?: boolean;
 completed?: number; total?: number; current_department?: string | null; error_code?: string;
 result?: SyncResult & {user_candidates?: SyncUser[]} }
const active = (job: Job | null) => !!job && ['queued', 'fetching', 'applying'].includes(job.status)
const names = { wecom: '企业微信', dingtalk: '钉钉' }

export function OrganizationSyncPanel({ sourceId, provider, csrf, onClose, onCompleted }: {
 sourceId: string; provider: 'wecom' | 'dingtalk'; csrf: string; onClose: () => void; onCompleted: () => void
}) {
 const [departments, setDepartments] = useState<Department[]>([])
 const [selected, setSelected] = useState<string[]>([])
 const [job, setJob] = useState<Job | null>(null)
 const [loading, setLoading] = useState(true); const [starting, setStarting] = useState(false)
 const [error, setError] = useState(''); const [revision, setRevision] = useState(0)
 const [selectedUsers, setSelectedUsers] = useState<string[]>([])
 const [mode,setMode]=useState<MaintenanceMode>('departments')
 const [changesOnly,setChangesOnly]=useState(true)
 const [groupsOnly,setGroupsOnly]=useState(false)
 const priorUserSelection=useRef<string[]>([])
 const maintainedSubjects=useRef<string[]>([])
 const maintainedExclusions=useRef<string[]>([])
 const savedSignature=useRef('')
 const [focusedDepartment, setFocusedDepartment] = useState('')
 const userPreview = useRef('')
 const previewExclusions = useRef<string[]>([])
 const previewRestorations = useRef<string[]>([])
 const [search, setSearch] = useState('')
 const submitting = useRef(false)
 const [discard, setDiscard] = useState(false)
 const completed = useRef(onCompleted); completed.current = onCompleted
 const base = '/api/admin/identity-sources/' + encodeURIComponent(sourceId)
 useEffect(() => {
  const controller = new AbortController(); setLoading(true); setError('')
  void Promise.all([
   fetch(base + '/directory-preview', {credentials:'same-origin',signal:controller.signal}),
   fetch(base + '/sync-jobs/latest', {credentials:'same-origin',signal:controller.signal}),
  ]).then(async ([directory, latest]) => {
   if (!directory.ok || !latest.ok) throw Error('组织列表加载失败，请检查应用密钥和通讯录权限后重试。')
   const [data, progress] = await Promise.all([directory.json(), latest.json()])
   if (controller.signal.aborted) return
   setDepartments(data.departments); setJob(progress)
   const choices = (active(progress) || progress.status === 'preview') ? progress.selection_department_ids ?? progress.department_ids : data.selected_department_ids
   const policy=data.maintenance_policy as MaintenancePolicy|null
   const nextMode=policy?.mode ?? ('is_initialized' in data?'all':'departments')
   setMode(nextMode);maintainedSubjects.current=policy?.subjects??[];maintainedExclusions.current=policy?.excluded_subjects??[]
   const restored = nextMode==='all' ? data.departments.map((item:Department)=>item.external_id) : policy?.mode==='departments' ? departmentScope(data.departments,policy.department_ids) : (choices ?? []).filter((id: string) => data.departments.some((item: Department) => item.external_id === id))
   setSelected(restored)
   savedSignature.current=selectionSignature(nextMode,data.departments,restored,policy?.subjects??[])
  }).catch(reason => {if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '组织列表加载失败。')})
   .finally(() => {if (!controller.signal.aborted) setLoading(false)})
  return () => controller.abort()
 }, [base, revision])
 const candidates = job?.status === 'preview' ? job.result?.user_candidates ?? [] : []
 useEffect(()=>{
  if(job?.status === 'preview' && job.id !== userPreview.current){
   userPreview.current = job.id ?? ''
   const nodes=job.departments ?? departments
   if(job.departments)setDepartments(nodes)
   const nextSelected=mode==='all' ? nodes.map(item=>item.external_id) : mode==='departments' ? departmentScope(nodes,departmentRoots(departments,selected)) : selected
   const users=job.result?.user_candidates??[]
   const policy:MaintenancePolicy={mode,department_ids:nextSelected,subjects:maintainedSubjects.current,
    excluded_subjects:[...users.filter(user=>user.excluded).map(user=>user.subject),...previewExclusions.current]}
   const values=groupsOnly?[]:[...new Set([...policySubjects(policy,users,nodes),...previewRestorations.current.filter(id=>users.some(user=>user.subject===id))])]
   setSelected(mode==='users'?userDepartmentScope(nodes,users,values):nextSelected)
   previewExclusions.current = []
   previewRestorations.current = []
   setSelectedUsers(values)
  }
 },[job])
 const running = active(job)
 useEffect(() => {
  if (!running || error) return
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>
  async function poll() {
   try {
    const response = await fetch(base + '/sync-jobs/latest', {credentials:'same-origin',signal:controller.signal})
    if (!response.ok) throw Error('进度读取失败，任务仍在后台执行，请点击重试。')
    const progress = await response.json() as Job
    if (controller.signal.aborted) return
    setJob(progress)
    if (active(progress)) timer = setTimeout(() => void poll(), 1000)
    else if (progress.status === 'completed') completed.current()
   } catch (reason) {if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '进度读取失败，请重试。')}
  }
  timer = setTimeout(() => void poll(), 500)
  return () => {controller.abort(); clearTimeout(timer)}
 }, [base, running, error])
 async function start(refresh = false) {
  const departmentIds = departments.filter(item=>!item.local_only).map(item=>item.external_id)
  if (submitting.current || running || !departmentIds.length || !csrf) return
  submitting.current = true; setStarting(true); setError('')
  try {
   const response = await fetch(base + '/sync-jobs', {method:'POST',credentials:'same-origin',
    headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({department_ids:departmentIds, selection_department_ids:selected, preview:true, full_directory:true, ...(refresh ? {refresh:true} : {})})})
   if (!response.ok) {
    if (response.status === 409) {
     const latest = await fetch(base + '/sync-jobs/latest', {credentials:'same-origin'})
     if (latest.ok) {setJob(await latest.json()); return}
    }
    throw Error('同步启动失败，请检查应用配置和权限后重试。')
   }
   setJob(await response.json())
  } catch (reason) {setError(reason instanceof Error ? reason.message : '同步启动失败。')}
  finally {submitting.current = false; setStarting(false)}
 }
 async function confirm() {
  if (submitting.current || !job?.id) return
  submitting.current=true; setStarting(true); setError('')
  try {
   const policy:MaintenancePolicy={mode,department_ids:mode==='departments'?departmentRoots(departments,selected):[],subjects:mode==='users'?selectedUsers:[],excluded_subjects:groupsOnly?maintainedExclusions.current:[]}
   const response=await fetch(base+'/sync-jobs/confirm',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({job_id:job.id, department_ids:selected, ...(job.result?.user_candidates ? {selected_subjects:selectedUsers,maintenance_policy:policy,...(groupsOnly?{groups_only:true}:{})} : {})})})
   if (!response.ok) throw Error('预览已失效或确认失败，请重新读取变更。')
   setJob(await response.json())
  } catch(reason) {setError(reason instanceof Error ? reason.message : '确认失败。')}
  finally {submitting.current=false;setStarting(false)}
 }
 const locked = loading || starting || running
 const visible = departments.filter(item => item.display_name.toLowerCase().includes(search.toLowerCase()))
 const byId = new Map(departments.map(item => [item.external_id, item]))
 const treeNodes = departments.map(item => ({id:item.external_id,parent_id:item.parent_external_id}))
 const selectedPreview=summarizeSelection(candidates,job?.result?.department_candidates??[],selectedUsers,selected)
 function viewUsers(id: string) {
  if (locked || !csrf) return
  setFocusedDepartment(id)
  setChangesOnly(false)
  if (job?.status !== 'preview' || (job.cache_expires_at && Date.parse(job.cache_expires_at) <= Date.now()) || (job.department_ids && departments.some(item=>!job.department_ids?.includes(item.external_id)))) {
   previewExclusions.current = candidates.filter(user=>!selectedUsers.includes(user.subject)).map(user=>user.subject)
   previewRestorations.current = candidates.filter(user=>user.skipped && selectedUsers.includes(user.subject)).map(user=>user.subject)
   void start()
  }
 }
 function refresh() {
  previewExclusions.current=candidates.filter(user=>!selectedUsers.includes(user.subject)).map(user=>user.subject)
  previewRestorations.current=candidates.filter(user=>user.skipped && selectedUsers.includes(user.subject)).map(user=>user.subject)
  setChangesOnly(true);setFocusedDepartment('');void start(true)
 }
 function chooseMode(value:MaintenanceMode) {
  setMode(value)
  if(value==='all'){
   setSelected(departments.map(item=>item.external_id))
   if(!groupsOnly)setSelectedUsers(candidates.filter(user=>!user.skipped).map(user=>user.subject))
  }else if(value==='users')maintainedSubjects.current=selectedUsers
 }
 function close() {
  if (starting) return
  if (!running && savedSignature.current && (groupsOnly || selectionSignature(mode,departments,selected,selectedUsers)!==savedSignature.current)) setDiscard(true)
  else onClose()
 }
 return <GatewayModal explicitCloseOnly className="gateway-organization-sync-dialog" title={names[provider] + ' · 选择同步组织与用户'} onClose={close} footer={<>
  <span>已选 {selected.length} / {departments.length} 个组织</span>
  <button type="button" className="gateway-dialog-cancel" disabled={starting} onClick={close}>{running ? '后台运行并关闭' : '取消'}</button>
  <button type="button" disabled={locked || !csrf || !selected.length || (mode==='users' && job?.status==='preview' && !selectedUsers.length)} onClick={() => void (job?.status === 'preview' ? confirm() : start())}>{starting && <span className="gateway-spinner" />}{starting ? '正在提交…' : job?.status === 'preview' ? `同步 ${selectedUsers.length} 位用户 · 应用组织变更` : '读取通讯录'}</button>
 </>}>
  <details className="gateway-sync-instructions"><summary>同步说明与注意事项</summary><p>勾选上级会自动包含全部下级组织及用户；取消上级会一起取消下级。搜索或折叠隐藏的下级也包含在选择中。同步新增组织和用户，并更新姓名、部门及企业状态；明确离职或禁用会撤销访问，读取范围不完整的缺失记录标记为待核实；本地手动停用不会自动恢复。确认同步会恢复或重新创建所选组织对应的用户组，并保留部门层级；已删除用户仅作提示，主动勾选后可恢复或重新创建并覆盖同步资料。未勾选的已有组织和成员保留；后续自动同步沿用最近一次成功的选择。</p></details>
  {loading && <p role="status"><span className="gateway-spinner" /> 正在读取组织列表…</p>}
  {error && <p role="alert" className="gateway-auth-error">{error}<button type="button" onClick={() => departments.length ? setError('') : setRevision(value => value + 1)}>重试</button></p>}
  {!loading && <>
   <div className="gateway-sync-maintenance-toolbar">
    <label>维护范围<select value={mode} disabled={locked} onChange={event=>chooseMode(event.target.value as MaintenanceMode)}>
     <option value="all">全量通讯录</option><option value="departments">指定部门（含下级及新成员）</option><option value="users" disabled={groupsOnly}>指定用户（不自动新增）</option>
    </select></label>
    <button type="button" disabled={locked || !csrf} onClick={refresh}>检查变更</button>
    <button type="button" disabled={locked || !csrf} onClick={()=>{setFocusedDepartment('');setChangesOnly(false);if(job?.status!=='preview')void start()}}>查看全部</button>
    <label title="全量或部门范围可单独更新组织结构；指定用户时会自动补齐所属组"><input type="checkbox" checked={groupsOnly} disabled={locked || mode==='users'} onChange={event=>{
     const checked=event.target.checked;setGroupsOnly(checked)
     if(checked){priorUserSelection.current=selectedUsers;setSelectedUsers([])}
     else setSelectedUsers(priorUserSelection.current.filter(id=>candidates.some(user=>user.subject===id)))
    }}/>本次只同步组织结构</label>
   </div>
   <div className="gateway-sync-selection-toolbar"><label>搜索组织<input value={search} onChange={event => setSearch(event.target.value)} /></label>
    <button type="button" disabled={locked || !visible.length} onClick={() => {setMode('departments');const scope=visible.flatMap(item=>subtreeIds(treeNodes,item.external_id));setSelected(previous => [...new Set([...previous,...scope])]);if(!groupsOnly)setSelectedUsers(previous=>[...new Set([...previous,...candidates.filter(user=>!user.skipped && user.department_ids.some(id=>scope.includes(id))).map(user=>user.subject)])])}}>勾选搜索结果</button>
    <button type="button" disabled={locked || !selected.length} onClick={() => {setMode('departments');setSelected([]);setSelectedUsers([])}}>清空勾选</button><span>已选 {selected.length} / {departments.length} 个组织</span></div>
   {job?.status === 'preview' && <div className="gateway-sync-cache-toolbar"><span>全部组织和用户缓存 5 分钟；检查变更会重新读取，切换和勾选使用缓存。</span></div>}
   <div className="gateway-sync-selection-layout"><section className="gateway-sync-organizations"><h3>同步组织</h3>
   <DepartmentSelectionTree departments={departments} selected={selected} search={search} disabled={locked || !csrf} onSelect={viewUsers} focusedId={focusedDepartment}
    partialIds={candidates.filter(user=>!user.skipped && !selectedUsers.includes(user.subject)).flatMap(user=>user.department_ids)}
    onChange={(values, toggledId, checked) => {
     setMode('departments');setSelected(values)
     if(job?.status === 'preview' && toggledId && !groupsOnly){
      const scope = subtreeIds(treeNodes,toggledId)
      const affected = candidates.filter(user=>(!checked || !user.skipped) && user.department_ids.some(id=>scope.includes(id))).map(user=>user.subject)
      setSelectedUsers(previous=>checked?[...new Set([...previous,...affected])]:previous.filter(subject=>!affected.includes(subject)))
     }
    }}/>
   </section>
   {job?.status === 'preview' ? <OrganizationSyncUsers key={focusedDepartment || 'all'} users={candidates} selected={selectedUsers} changesOnly={changesOnly} onChangesOnlyChange={setChangesOnly}
    departmentIds={focusedDepartment?subtreeIds(treeNodes,focusedDepartment):undefined}
    departmentName={byId.get(focusedDepartment)?.display_name}
    departmentNames={new Map(departments.map(item=>[item.external_id,item.display_name]))} disabled={locked || groupsOnly} onChange={values=>{setMode('users');maintainedSubjects.current=values;setSelectedUsers(values);setSelected(userDepartmentScope(departments,candidates,values))}}/>
    : <section className="gateway-sync-users"><h3>同步用户</h3><p>{starting || running ? '正在读取组织用户，请稍候…' : '首次读取通讯录后勾选同步；日常使用“检查变更”核对新增、调部门、离职及源端删除。点击“查看用户”或“查看全部”可挑选指定用户。'}</p></section>}
   </div>
   {focusedDepartment && <button type="button" onClick={()=>{setFocusedDepartment('');setChangesOnly(false)}}>查看所有所选组织用户</button>}
   {!visible.length && <p>没有匹配的组织。</p>}
   <div className="gateway-sync-progress" aria-live="polite">
    {job?.status === 'preview' && <p>变更预览：确认后才更新组织和成员；预览有效期为 15 分钟。</p>}
    {running && <><p><span className="gateway-spinner" /> {job?.status === 'applying' ? job.preview_requested?'正在整理变更预览…':'正在保存用户组和成员…' : job?.status === 'queued' ? '等待同步…' : '正在读取全部通讯录…'}{job?.current_department && ` · ${byId.get(job.current_department)?.display_name ?? job.current_department}`}</p>
     <progress aria-label="部门读取进度" value={job?.completed ?? 0} max={job?.total || 1} /><span>{job?.completed ?? 0} / {job?.total ?? selected.length} 个部门</span></>}
    {job?.status === 'completed' && <p>同步完成：{job.result?.departments ?? 0} 个组织、{job.result?.people ?? 0} 位用户。</p>}
    {job && ['preview', 'completed'].includes(job.status) && <OrganizationSyncResult result={job.status==='preview' && job.result?.user_candidates?selectedPreview:job.result} departmentNames={new Map(departments.map(item=>[item.external_id,item.display_name]))}/>}
    {job?.status === 'failed'  && <p role="alert">{job.error_code === 'interrupted' ? '服务重启或关闭导致同步中断，请重新同步。' : '同步失败，请检查应用密钥、通讯录权限或组织是否仍然存在，然后重试。'}</p>}
   </div>
  </>}
  {discard && <GatewayConfirmDialog title="放弃组织选择" message="尚未提交的组织和用户选择将丢失。" confirmLabel="放弃并关闭" onConfirm={onClose} onCancel={()=>setDiscard(false)} />}
 </GatewayModal>
}

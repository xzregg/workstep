import { useEffect, useRef, useState } from 'react'
import { GatewayModal } from './GatewayModal'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

import { DepartmentSelectionTree } from './DepartmentSelectionTree'
import type { Department } from './DepartmentSelectionTree'
import { subtreeIds } from './TreeSelection'
type Job = { id?: string; status: 'idle' | 'queued' | 'fetching' | 'applying' | 'completed' | 'failed';
 completed?: number; total?: number; current_department?: string | null; error_code?: string;
 result?: { departments: number; people: number; departments_added?: number; people_added?: number; departments_deleted_skipped?: number; people_deleted_skipped?: number } }
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
 const [search, setSearch] = useState('')
 const submitting = useRef(false)
 const savedSelection = useRef<string[]>([])
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
   const choices = active(progress) ? progress.department_ids : data.selected_department_ids
   const restored = (choices ?? []).filter((id: string) => data.departments.some((item: Department) => item.external_id === id))
   savedSelection.current = restored; setSelected(restored)
  }).catch(reason => {if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '组织列表加载失败。')})
   .finally(() => {if (!controller.signal.aborted) setLoading(false)})
  return () => controller.abort()
 }, [base, revision])
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
 async function start() {
  if (submitting.current || running || !selected.length || !csrf) return
  submitting.current = true; setStarting(true); setError('')
  try {
   const response = await fetch(base + '/sync-jobs', {method:'POST',credentials:'same-origin',
    headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({department_ids:selected})})
   if (!response.ok) {
    if (response.status === 409) {
     const latest = await fetch(base + '/sync-jobs/latest', {credentials:'same-origin'})
     if (latest.ok) {setJob(await latest.json()); return}
    }
    throw Error('同步启动失败，请检查应用配置和权限后重试。')
   }
   setJob(await response.json()); savedSelection.current = [...selected]
  } catch (reason) {setError(reason instanceof Error ? reason.message : '同步启动失败。')}
  finally {submitting.current = false; setStarting(false)}
 }
 const locked = loading || starting || running
 const visible = departments.filter(item => item.display_name.toLowerCase().includes(search.toLowerCase()))
 const byId = new Map(departments.map(item => [item.external_id, item]))
 const treeNodes = departments.map(item => ({id:item.external_id,parent_id:item.parent_external_id}))
 function close() {
  if (starting) return
  if (!running && [...selected].sort().join(',') !== [...savedSelection.current].sort().join(',')) setDiscard(true)
  else onClose()
 }
 return <GatewayModal title={names[provider] + ' · 选择同步组织'} onClose={close} footer={<>
  <span>已选 {selected.length} / {departments.length} 个组织</span>
  <button type="button" className="gateway-dialog-cancel" disabled={starting} onClick={close}>{running ? '后台运行并关闭' : '取消'}</button>
  <button type="button" disabled={locked || !csrf || !selected.length} onClick={() => void start()}>{starting && <span className="gateway-spinner" />}{starting ? '正在提交…' : '同步组织与用户'}</button>
 </>}>
  <p>勾选上级会自动包含全部下级组织及用户；取消上级会一起取消下级。搜索或折叠隐藏的下级也包含在选择中。仅同步新增组织和用户，已有记录保持不变；本地已删除记录将跳过并提示，不会自动恢复。未勾选的已有组织和成员保留；后续自动同步沿用最近一次成功的选择。</p>
  {loading && <p role="status"><span className="gateway-spinner" /> 正在读取组织列表…</p>}
  {error && <p role="alert" className="gateway-auth-error">{error}<button type="button" onClick={() => departments.length ? setError('') : setRevision(value => value + 1)}>重试</button></p>}
  {!loading && <>
   <div className="gateway-sync-selection-toolbar"><label>搜索组织<input value={search} onChange={event => setSearch(event.target.value)} /></label>
    <button type="button" disabled={locked || !visible.length} onClick={() => setSelected(previous => [...new Set([...previous, ...visible.flatMap(item => subtreeIds(treeNodes,item.external_id))])])}>勾选搜索结果</button>
    <button type="button" disabled={locked || !selected.length} onClick={() => setSelected([])}>清空勾选</button><span>已选 {selected.length} / {departments.length} 个组织</span></div>
   <DepartmentSelectionTree departments={departments} selected={selected} search={search} disabled={locked} onChange={setSelected}/>
   {!visible.length && <p>没有匹配的组织。</p>}
   <div className="gateway-sync-progress" aria-live="polite">
    {running && <><p><span className="gateway-spinner" /> {job?.status === 'applying' ? '正在保存用户组和成员…' : job?.status === 'queued' ? '等待同步…' : '正在读取所选部门成员…'}{job?.current_department && ` · ${byId.get(job.current_department)?.display_name ?? job.current_department}`}</p>
     <progress aria-label="部门读取进度" value={job?.completed ?? 0} max={job?.total || 1} /><span>{job?.completed ?? 0} / {job?.total ?? selected.length} 个部门</span></>}
    {job?.status === 'completed' && <p>同步完成：{job.result?.departments ?? 0} 个组织、{job.result?.people ?? 0} 位用户。</p>}
    {job?.status === 'completed' && job.result?.people_added !== undefined && <p>本次新增：{job.result.departments_added ?? 0} 个组织、{job.result.people_added} 位用户。跳过本地已删除：{job.result.departments_deleted_skipped ?? 0} 个组织、{job.result.people_deleted_skipped ?? 0} 位用户；请在回收站恢复后启用。</p>}
    {job?.status === 'failed' && <p role="alert">{job.error_code === 'interrupted' ? '服务重启或关闭导致同步中断，请重新同步。' : '同步失败，请检查应用密钥、通讯录权限或组织是否仍然存在，然后重试。'}</p>}
   </div>
  </>}
  {discard && <GatewayConfirmDialog title="放弃组织选择" message="尚未提交的组织选择将丢失。" confirmLabel="放弃并关闭" onConfirm={onClose} onCancel={()=>setDiscard(false)} />}
 </GatewayModal>
}

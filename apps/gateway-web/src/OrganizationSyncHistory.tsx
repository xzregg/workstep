import { useEffect, useState } from 'react'
import { GatewayModal } from './GatewayModal'
import { OrganizationSyncResult, type SyncResult } from './OrganizationSyncResult'
export function OrganizationSyncHistory({sourceId,onClose}: {sourceId:string;onClose:()=>void}) {
 const [jobs,setJobs]=useState<{id:string;status:string;started_at:string;result?:SyncResult}[]>([])
 const [loading,setLoading]=useState(true);const [error,setError]=useState('');const [revision,setRevision]=useState(0)
 useEffect(()=>{
  const controller=new AbortController();setLoading(true);setError('')
  void fetch('/api/admin/identity-sources/'+encodeURIComponent(sourceId)+'/sync-history',{credentials:'same-origin',signal:controller.signal}).then(async response=>{
   if(!response.ok)throw Error()
   const data=await response.json();if(!controller.signal.aborted)setJobs(data.jobs ?? [])
  }).catch(()=>{if(!controller.signal.aborted)setError('同步记录加载失败，请重试。')}).finally(()=>{if(!controller.signal.aborted)setLoading(false)})
  return ()=>controller.abort()
 },[sourceId,revision])
 return <GatewayModal title="组织同步记录" onClose={onClose} footer={<button type="button" onClick={onClose}>关闭</button>}>
  <p>保留最近 30 次同步结果，手动同步和自动同步共用同一套状态对账规则。</p>
  {loading && <p role="status"><span className="gateway-spinner"/> 正在读取同步记录…</p>}
  {error && <p role="alert">{error}<button type="button" onClick={()=>setRevision(value=>value+1)}>重试</button></p>}
  {!loading && !error && !jobs.length && <p>尚无同步记录。</p>}
  {jobs.map(job=><article key={job.id}><h3>{new Date(job.started_at).toLocaleString()} · {job.status === 'completed' ? '同步完成' : '同步失败'}</h3>{job.result && <OrganizationSyncResult result={job.result}/>}</article>)}
 </GatewayModal>
}

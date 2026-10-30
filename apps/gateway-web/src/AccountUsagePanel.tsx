import { useEffect, useState } from 'react'
import { AdminRecordTable } from './AdminRecordTable'
import { UsageTrendChart } from './UsageTrendChart'
import { usageCount, usageCost, type UsageGroup, type UsageTotals } from './usageStatistics'

type AccountUsage = {summary:UsageTotals; daily:UsageGroup[]; models:UsageGroup[]}
export function AccountUsagePanel({onExpired}:{onExpired:()=>void}) {
 const [days,setDays]=useState(30)
 const [revision,setRevision]=useState(0)
 const [data,setData]=useState<AccountUsage|null>(null)
 const [loading,setLoading]=useState(true)
 const [error,setError]=useState('')
 useEffect(()=>{
  const controller=new AbortController()
  setLoading(true);setError('')
  void fetch(`/api/account/usage?days=${days}`,{credentials:'same-origin',signal:controller.signal}).then(async response=>{
   if(response.status===401){if(!controller.signal.aborted)onExpired();return}
   if(!response.ok)throw Error('用量加载失败，请重试。')
   const result=await response.json()
   if(!controller.signal.aborted)setData(result)
  }).catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'用量加载失败，请重试。')})
   .finally(()=>{if(!controller.signal.aborted)setLoading(false)})
  return ()=>controller.abort()
 },[days,revision,onExpired])
 const totals=data?.summary
 const token=(value:number|null)=>totals?.event_count===0?'0':usageCount(value)
 return <section aria-label="我的用量统计" className="gateway-account-usage">
  <div className="gateway-center-report-heading"><div><h3>我的用量</h3><p className="gateway-center-muted">统计归属当前账号的设备回传用量，按 UTC 日期汇总。</p></div><div className="gateway-center-report-actions"><div className="gateway-center-period" role="group" aria-label="统计时间范围">{[7,30,90].map(value=><button key={value} type="button" aria-pressed={days===value} onClick={()=>setDays(value)}>近 {value} 天</button>)}</div><button type="button" disabled={loading} onClick={()=>setRevision(value=>value+1)}>刷新</button></div></div>
  {loading && <div className="gateway-center-state" role="status"><span className="gateway-spinner"/> 正在加载用量…</div>}
  {error && <div className="gateway-center-state" role="alert">{error}<button type="button" onClick={()=>setRevision(value=>value+1)}>重试用量</button></div>}
  {!loading && !error && data && totals && <>
   <dl className="gateway-center-metrics">{[
    ['调用次数',usageCount(totals.event_count),'所选时间范围内'],['总 Token',token(totals.total_tokens),'仅汇总已上报值'],
    ['输入 / 输出',`${token(totals.input_tokens)} / ${token(totals.output_tokens)}`,'Token'],['估算成本',usageCost(totals,false),'非实际账单金额'],
   ].map(([title,value,note])=><div key={title}><dt>{title}</dt><dd>{value}</dd><small>{note}</small></div>)}</dl>
   {totals.unmetered_count>0 && <p className="gateway-center-measurement-note">有 {totals.unmetered_count} 次调用未完成计量，缺失的 Token 和费用不按零计算。</p>}
   {totals.event_count===0?<div className="gateway-center-empty"><h3>这段时间还没有用量记录</h3><p>使用已连接的设备执行任务后，回传的用量会显示在这里。</p></div>:<>
    <div className="gateway-center-charts"><UsageTrendChart rows={data.daily} field="total_tokens" title="Token 使用趋势"/><UsageTrendChart rows={data.daily} field="event_count" title="调用次数趋势"/></div>
    <section className="gateway-center-panel"><div className="gateway-center-report-heading"><h3>常用模型</h3><span className="gateway-center-muted">按调用次数排序，最多显示 8 个</span></div>
     <AdminRecordTable columns={['模型','调用次数','输入 Token','输出 Token','总 Token','估算成本']}>
      {data.models.map(row=><tr key={row.value??'unknown'}><td>{row.value??'未上报模型'}</td><td>{usageCount(row.event_count)}</td><td>{usageCount(row.input_tokens)}</td><td>{usageCount(row.output_tokens)}</td><td>{usageCount(row.total_tokens)}</td><td>{usageCost(row,false)}</td></tr>)}
     </AdminRecordTable>
    </section>
   </>}
  </>}
 </section>
}

import { useEffect, useState } from 'react'
import { UsageTrendChart } from './UsageTrendChart'
import { UsageDistributionChart } from './UsageDistributionChart'
import type { UsageGroup } from './usageStatistics'
export function UsageOverviewCharts({ filters }: { filters: string }) {
 const [data,setData] = useState<{day:UsageGroup[];model:UsageGroup[]}>({day:[],model:[]})
 const [loading,setLoading] = useState(true)
 const [error,setError] = useState('')
 const [revision,setRevision] = useState(0)
 const [truncated,setTruncated] = useState(false)
 useEffect(() => {
  const controller = new AbortController()
  setLoading(true);setError('')
  void Promise.all((['day','model'] as const).map(async dimension => {
   const params = new URLSearchParams(filters);params.set('group_by',dimension);params.set('limit','1000');params.set('offset','0')
   const response = await fetch(`/api/admin/usage?${params}`,{credentials:'same-origin',signal:controller.signal})
   if(!response.ok)throw Error('用量图表加载失败。')
   return [dimension,await response.json()] as const
  })).then(results => {
   if(controller.signal.aborted)return
   setData(Object.fromEntries(results.map(([key,value])=>[key,value.groups ?? []])) as typeof data)
   setTruncated(results.some(([,value])=>value.group_total>1000))
  }).catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'用量图表加载失败。')})
  .finally(()=>{if(!controller.signal.aborted)setLoading(false)})
  return()=>controller.abort()
 },[filters,revision])
 if(loading)return <p role="status"><span className="gateway-spinner"/> 正在加载图表…</p>
 if(error)return <p role="alert">{error}<button type="button" onClick={()=>setRevision(value=>value+1)}>重试图表</button></p>
 return <><div className="gateway-usage-charts"><UsageTrendChart rows={data.day} field="total_tokens" title="每日 Token 趋势（UTC）"/><UsageTrendChart rows={data.day} field="event_count" title={new URLSearchParams(filters).get('source')==='provider_reconciled'?'每日账单行趋势（UTC）':'每日调用趋势（UTC）'}/><UsageDistributionChart rows={data.model}/></div>{truncated && <p className="gateway-usage-chart-note">图表仅显示前 1000 天／组；完整统计请在对应 Tab 分页查看。</p>}</>
}

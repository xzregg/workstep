import { ActivityHeatmap, activityDateRange } from '@workstep/gateway-ui/ActivityHeatmap'
import type { UsageGroup } from './usageStatistics'

export function UsageActivityHeatmap({ rows, filters }: { rows: UsageGroup[]; filters: string }) {
 const params = new URLSearchParams(filters)
 const dates = rows.map(row => row.value).filter((value): value is string => Boolean(value)).sort()
 const from = params.get('from_time') || (dates[0] || new Date().toISOString().slice(0,10)) + 'T00:00:00Z'
 const to = params.get('to_time') || new Date(Date.parse((dates.at(-1) || from.slice(0,10)) + 'T00:00:00Z') + 86400000).toISOString()
 const range = activityDateRange(from, to)
 const billed = params.get('source') === 'provider_reconciled'
 return <ActivityHeatmap rows={rows.flatMap(row => row.value ? [{date:row.value,count:row.event_count,tokens:row.total_tokens}] : [])}
  {...range} labels={{title:'使用活跃情况（UTC）',previous:'上一年',next:'下一年',less:'少',more:'多',outside:'不在统计范围',unknown:'未上报',calls:billed?'条账单':'次调用',days:'活跃天数',hint:billed?'仅统计所选时间范围，颜色按每日账单行数显示':'仅统计所选时间范围，颜色按每日调用次数显示'}}/>
}

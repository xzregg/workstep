export type UsageTotals = {
 event_count: number; unmetered_count: number; input_tokens: number | null;
 output_tokens: number | null; cache_read_tokens: number | null;
 cache_write_tokens: number | null; total_tokens: number | null;
 estimated_cost: string | null; billed_cost: string | null; currency: string | null;
}
export type UsageGroup = UsageTotals & { value: string | null; label?: string | null }
export type UsageSummary = UsageTotals & { groups?: UsageGroup[]; group_total?: number }
export type UsageDimension = 'day' | 'user' | 'device' | 'project' | 'provider' | 'model'
export const usageDimensions: Record<UsageDimension, { label: string; filter?: string }> = {
 day: { label: '日期', }, user: { label: '用户', filter: 'user_id' },
 device: { label: '设备', filter: 'device_id' }, project: { label: '项目', filter: 'project_id' },
 provider: { label: '供应商', filter: 'provider_id' }, model: { label: '模型', filter: 'model' },
}
export function usageCount(value: number | null | undefined) {
 return value == null ? '未上报' : value.toLocaleString('zh-CN')
}
export function usageCost(row: UsageTotals, billed: boolean) {
 if (row.currency === 'mixed') return '多种币种，暂不可汇总'
 const cost = billed ? row.billed_cost : row.estimated_cost
 return cost == null ? '暂不可汇总' : cost + (row.currency ? ' ' + row.currency : '')
}

export function usageGroupName(row: UsageGroup, dimension: UsageDimension) {
 if (row.label) return row.label
 if (row.value === null) return '未标记'
 return dimension === 'day' || dimension === 'model' ? row.value : '未登记'+usageDimensions[dimension].label
}

export function usageCacheRate(row: Pick<UsageTotals, 'input_tokens' | 'cache_read_tokens'>): number | null {
 const input = row.input_tokens, read = row.cache_read_tokens
 return input != null && input > 0 && read != null && read >= 0 && read <= input ? read / input : null
}
export function usageChange(current: number | null, previous: number | null) {
 if (current === null || previous === null) return '未上报'
 if (previous === 0) return current === 0 ? '持平' : '新增用量'
 const delta = (current - previous) / previous * 100
 return delta === 0 ? '持平' : (delta > 0 ? '+' : '−') + Math.abs(delta).toFixed(1) + '%'
}
export function usageTokenTotal(row: UsageTotals | null): number | null {
 return row ? row.event_count === 0 ? 0 : row.total_tokens : null
}
export function usageCompact(value: number | null) {
 if (value === null) return '未上报'
 return value >= 1e6 ? (value / 1e6).toFixed(2)+'M' : value >= 1e3 ? (value / 1e3).toFixed(2)+'K' : usageCount(value)
}
export type UsageRange = { from: string; to: string }
export function usageComparisonRanges(from: string, to: string, now = new Date()) {
 const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
 const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
 const month = { from: monthStart.toISOString(), to: monthEnd.toISOString() }
 const a = new Date(from), b = new Date(to)
 if (!Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime()) || a >= b) return { month, previous: null, year: null }
 const lastYear = (value: Date) => {
  const result = new Date(value), day = result.getUTCDate()
  result.setUTCDate(1); result.setUTCFullYear(result.getUTCFullYear() - 1)
  const last = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth()+1, 0)).getUTCDate()
  result.setUTCDate(Math.min(day, last)); return result.toISOString()
 }
 const year = { from: lastYear(a), to: lastYear(b) }
 return { month, previous: { from: new Date(a.getTime() - (b.getTime()-a.getTime())).toISOString(), to: a.toISOString() },
  year: year.from < year.to ? year : null }
}

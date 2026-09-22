export function formatTokenTotal(value: number, locale = 'zh-CN'): string {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 10_000) {
    return `${(value / 10_000).toFixed(2)} 万`
  }
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value)
}


export function formatCompactMetric(value: number, locale: string): string {
  if (!Number.isFinite(value)) return '—'
  return new Intl.NumberFormat(locale, {
    notation: Math.abs(value) >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: Math.abs(value) >= 10_000 ? 1 : 0,
  }).format(value)
}


export function formatExactMetric(value: number, locale: string): string {
  if (!Number.isFinite(value)) return '—'
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value)
}


interface TrendTooltipPoint {
  bucket: string
  succeeded_runs: number
  failed_runs: number
  total_tokens: number
}


interface TrendTooltipLabels {
  succeeded: string
  failed: string
  totalTokens: string
}


export function trendTooltipContent(
  point: TrendTooltipPoint,
  mode: 'runs' | 'tokens',
  locale: string,
  labels: TrendTooltipLabels,
) {
  const items = mode === 'runs'
    ? [
        { label: labels.succeeded, value: formatExactMetric(point.succeeded_runs, locale), tone: 'success' as const },
        { label: labels.failed, value: formatExactMetric(point.failed_runs, locale), tone: 'danger' as const },
      ]
    : [
        { label: labels.totalTokens, value: formatExactMetric(point.total_tokens, locale), tone: 'token' as const },
      ]
  return {
    bucket: point.bucket,
    items,
    accessibleText: [point.bucket, ...items.map((item) => `${item.label} ${item.value}`)].join(' · '),
  }
}


export function formatRate(value: number | null, locale: string): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(value)
}


export function seriesPoints(
  values: number[],
  width: number,
  height: number,
  scaleMaximum?: number,
): string {
  if (values.length === 0) return ''
  const maximum = Math.max(scaleMaximum ?? Math.max(...values), 1)
  return values.map((value, index) => {
    const x = values.length === 1
      ? width / 2
      : index * width / (values.length - 1)
    const y = height - Math.max(0, value) / maximum * height
    return `${Number(x.toFixed(2))},${Number(y.toFixed(2))}`
  }).join(' ')
}

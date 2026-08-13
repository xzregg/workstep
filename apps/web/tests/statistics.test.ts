import assert from 'node:assert/strict'
import test from 'node:test'

import {
  formatCompactMetric,
  formatExactMetric,
  formatRate,
  formatTokenTotal,
  seriesPoints,
  trendTooltipContent,
} from '../src/utils/statistics.ts'


test('formats token totals with 万 scaling beyond ten thousand', () => {
  assert.equal(formatTokenTotal(9_999, 'zh-CN'), '9,999')
  assert.equal(formatTokenTotal(10_000, 'zh-CN'), '1.00 万')
  assert.equal(formatTokenTotal(10_100, 'zh-CN'), '1.01 万')
  assert.equal(formatTokenTotal(150_000, 'zh-CN'), '15.00 万')
})


test('formats dashboard metrics consistently', () => {
  assert.equal(formatCompactMetric(0, 'zh-CN'), '0')
  assert.equal(formatCompactMetric(12_500, 'zh-CN'), '1.3万')
  assert.equal(formatRate(0.5, 'zh-CN'), '50%')
  assert.equal(formatRate(null, 'zh-CN'), '—')
})


test('scales trend values into an SVG polyline', () => {
  assert.equal(seriesPoints([0, 10], 100, 40), '0,40 100,0')
  assert.equal(seriesPoints([5], 100, 40), '50,0')
  assert.equal(seriesPoints([], 100, 40), '')
})


test('formats exact trend values for hover tooltips', () => {
  assert.equal(formatExactMetric(12_500, 'zh-CN'), '12,500')
  assert.deepEqual(
    trendTooltipContent({
      bucket: '2026-08-10',
      succeeded_runs: 2,
      failed_runs: 1,
      total_tokens: 12_500,
    }, 'runs', 'zh-CN', {
      succeeded: '成功',
      failed: '失败',
      totalTokens: 'Token 总量',
    }),
    {
      bucket: '2026-08-10',
      items: [
        { label: '成功', value: '2', tone: 'success' },
        { label: '失败', value: '1', tone: 'danger' },
      ],
      accessibleText: '2026-08-10 · 成功 2 · 失败 1',
    },
  )
  assert.equal(
    trendTooltipContent({
      bucket: '2026-08-10',
      succeeded_runs: 2,
      failed_runs: 1,
      total_tokens: 12_500,
    }, 'tokens', 'zh-CN', {
      succeeded: '成功',
      failed: '失败',
      totalTokens: 'Token 总量',
    }).accessibleText,
    '2026-08-10 · Token 总量 12,500',
  )
})

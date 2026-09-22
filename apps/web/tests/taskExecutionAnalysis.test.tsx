import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import type { TaskExecutionReport } from '../src/api/client'
import { TaskExecutionAnalysisView } from '../src/components/TaskExecutionAnalysis'
import { I18nProvider } from '../src/i18n'

const styles = await readFile(new URL('../src/components/TaskExecutionAnalysis.css', import.meta.url), 'utf8')

function installDom() {
  const window = new Window({ url: 'http://localhost/' })
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  return window
}

const report: TaskExecutionReport = {
  currency: 'CNY',
  generated_at: '2026-09-20T02:20:00Z',
  summary: {
    duration_ms: 1_080_000,
    total_tokens: 128_600,
    cost: 1.84,
    provider_cost: 1.18,
    estimated_cost: 0.66,
    usage_coverage: 0.92,
    run_count: 2,
    attempt_count: 5,
    retry_count: 1,
  },
  runs: [
    { id: 'run-1', round: 1, status: 'superseded', parent_run_id: null, restart_from_step_key: null, started_at: '2026-09-20T02:00:00Z', ended_at: '2026-09-20T02:12:00Z' },
    { id: 'run-2', round: 2, status: 'running', parent_run_id: 'run-1', restart_from_step_key: 'frontend', started_at: '2026-09-20T02:13:00Z', ended_at: null },
  ],
  segments: [
    {
      id: 'step-req', type: 'execution', workflow_run_id: 'run-1', step_run_id: 'step-req', round: 1,
      step_key: 'req', step_title: '需求分析', attempt: 1, status: 'succeeded', engine: 'claude', model: 'sonnet',
      started_at: '2026-09-20T02:00:00Z', ended_at: '2026-09-20T02:03:00Z', duration_ms: 180_000,
      input_tokens: 6_000, output_tokens: 4_000, cache_read_tokens: 0, cache_write_tokens: 0,
      total_tokens: 10_000, cost: 0.18, cost_source: 'provider', message_count: 1,
    },
    {
      id: 'step-frontend-2', type: 'execution', workflow_run_id: 'run-2', step_run_id: 'step-frontend-2', round: 2,
      step_key: 'frontend', step_title: '前端开发', attempt: 1, status: 'running', engine: 'codex', model: 'gpt-5.6',
      started_at: '2026-09-20T02:13:00Z', ended_at: null, duration_ms: 420_000,
      input_tokens: 80_000, output_tokens: 30_000, cache_read_tokens: 20_000, cache_write_tokens: 0,
      total_tokens: 110_000, cost: 1.52, cost_source: 'estimated', message_count: 2,
    },
  ],
  step_breakdown: [
    { step_key: 'frontend', step_title: '前端开发', status: 'running', attempt_count: 2, duration_ms: 720_000, total_tokens: 110_000, cost: 1.52 },
    { step_key: 'req', step_title: '需求分析', status: 'succeeded', attempt_count: 1, duration_ms: 180_000, total_tokens: 10_000, cost: 0.18 },
  ],
  user_breakdown: [
    {
      author_id: 'user-a', author_name: '小王', message_count: 2,
      input_tokens: 86_000, output_tokens: 34_000,
      cache_read_tokens: 20_000, cache_write_tokens: 0,
      total_tokens: 120_000, cost: 1.7,
    },
  ],
  milestones: [
    { id: 'm-1', kind: 'step_completed', step_key: 'req', step_title: '需求分析', status: 'succeeded', at: '2026-09-20T02:03:00Z', duration_ms: 180_000, total_tokens: 10_000, cost: 0.18 },
  ],
  data_quality: { eligible_usage_calls: 12, reported_usage_calls: 11 },
}

test('task execution analysis renders metrics, filters rounds, and opens a segment drawer', async () => {
  const window = installDom()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(<I18nProvider><TaskExecutionAnalysisView report={report} /></I18nProvider>)
    })

    assert.match(container.textContent || '', /12\.9万/)
    assert.match(container.textContent || '', /¥1.84/)
    assert.match(container.textContent || '', /用户消耗/)
    assert.match(container.textContent || '', /小王/)
    assert.equal(container.querySelectorAll('[data-execution-segment]').length, 2)
    assert.equal(container.querySelectorAll('[data-execution-segment] .ws-marquee').length, 2)

    const secondRound = container.querySelector<HTMLButtonElement>('[data-round-filter="2"]')!
    await act(async () => secondRound.click())
    assert.equal(container.querySelectorAll('[data-execution-segment]').length, 1)
    assert.match(container.textContent || '', /前端开发/)

    const segment = container.querySelector<HTMLButtonElement>('[data-execution-segment]')!
    await act(async () => segment.click())
    const drawer = container.querySelector('[role="dialog"]')
    assert.ok(drawer)
    assert.match(drawer?.textContent || '', /gpt-5.6/)
    assert.match(drawer?.textContent || '', /按价格配置估算/)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('task execution gantt freezes its first column and round labels without a shadow', () => {
  assert.match(styles, /\.execution-gantt-axis-label\s*\{[^}]*position:\s*sticky[^}]*left:\s*0/s)
  assert.match(styles, /\.execution-gantt-round-title-label\s*\{[^}]*position:\s*sticky[^}]*left:\s*0/s)
  assert.match(styles, /\.execution-gantt-label\s*\{[^}]*position:\s*sticky[^}]*left:\s*0/s)
  assert.doesNotMatch(styles, /\.execution-gantt-(?:axis-label|label)\s*\{[^}]*box-shadow\s*:/s)
})

test('task execution analysis remains compatible with reports without user breakdown', async () => {
  const window = installDom()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const legacyReport = { ...report } as TaskExecutionReport & { user_breakdown?: TaskExecutionReport['user_breakdown'] }
  delete legacyReport.user_breakdown
  try {
    await act(async () => {
      root.render(<I18nProvider><TaskExecutionAnalysisView report={legacyReport} /></I18nProvider>)
    })
    assert.match(container.textContent || '', /执行分析/)
    assert.match(container.textContent || '', /用户消耗/)
    assert.match(container.textContent || '', /暂无用户 Token 数据/)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

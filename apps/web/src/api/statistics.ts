import { request } from './transport'

// --- Statistics API ---

export interface StatisticsSummary {
  project_count: number
  workflow_count: number
  task_count: number
  run_count: number
  succeeded_runs: number
  failed_runs: number
  running_runs: number
  paused_runs: number
  superseded_runs: number
  success_rate: number | null
  restart_count: number
  average_duration_ms: number | null
  p50_duration_ms: number | null
  p95_duration_ms: number | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cache_rate: number | null
  total_tokens: number
  cost: number
  token_coverage: number | null
}

export interface StatisticsScope {
  level: 'global' | 'project' | 'workflow'
  project_id: string | null
  project_name: string | null
  workflow_id: string | null
  workflow_name: string | null
}

export interface StatisticsTrendPoint {
  bucket: string
  run_count: number
  succeeded_runs: number
  failed_runs: number
  total_tokens: number
  average_duration_ms: number | null
}

export interface StatisticsProjectRow extends StatisticsSummary {
  id: string
  name: string
  workflow_count: number
}

export interface StatisticsWorkflowRow extends StatisticsSummary {
  id: string
  name: string
  deleted: boolean
  drilldown_available: boolean
  node_count: number
}

export interface StatisticsStepRow {
  step_key: string
  name: string
  attempt_count: number
  succeeded_attempts: number
  failed_attempts: number
  cancelled_attempts: number
  retry_count: number
  failure_rate: number | null
  review_passed: number
  review_rejected: number
  review_pass_rate: number | null
  average_duration_ms: number | null
  p95_duration_ms: number | null
  total_tokens: number
}

export interface StatisticsEngineRow {
  engine: string
  model: string
  call_count: number
  attempt_count: number
  failure_rate: number | null
  average_duration_ms: number | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  total_tokens: number
  cost: number
}

export interface StatisticsUserRow {
  author_id: string
  author_name: string
  call_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  total_tokens: number
  cost: number
}

export interface StatisticsReport {
  currency: 'USD' | 'CNY'
  scope: StatisticsScope
  period: {
    range: string
    start: string
    end: string
    timezone: string
    granularity: 'day' | 'week' | 'month'
  }
  summary: StatisticsSummary
  trend: StatisticsTrendPoint[]
  projects: StatisticsProjectRow[]
  workflows: StatisticsWorkflowRow[]
  steps: StatisticsStepRow[]
  engines: StatisticsEngineRow[]
  users: StatisticsUserRow[]
  quality: {
    step_attempt_count: number
    step_failed: number
    step_cancelled: number
    step_failure_rate: number | null
    retry_count: number
    review_passed: number
    review_rejected: number
    review_pending: number
    review_pass_rate: number | null
    average_review_duration_ms: number | null
  }
  comparison: {
    period: StatisticsReport['period']
    summary: StatisticsSummary
    changes: {
      task_count: number | null
      run_count: number | null
      succeeded_runs: number | null
      failed_runs: number | null
      success_rate: number | null
      total_tokens: number | null
      cost: number | null
      cache_rate: number | null
      average_duration_ms: number | null
    }
  } | null
  data_quality: {
    eligible_token_calls: number
    reported_token_calls: number
    token_coverage: number | null
  }
}

export interface StatisticsParams {
  projectId?: string
  workflowId?: string
  range?: '7d' | '30d' | '90d' | 'all' | 'custom'
  start?: string
  end?: string
  timezone?: string
}

export const statisticsApi = {
  overview: (params: StatisticsParams = {}) => {
    const query = new URLSearchParams()
    if (params.projectId) query.set('project_id', params.projectId)
    if (params.workflowId) query.set('workflow_id', params.workflowId)
    if (params.range) query.set('range', params.range)
    if (params.start) query.set('start', params.start)
    if (params.end) query.set('end', params.end)
    if (params.timezone) query.set('timezone', params.timezone)
    return request<StatisticsReport>(`/statistics/overview?${query.toString()}`)
  },
}

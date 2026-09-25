import { request } from './transport'

// --- Project schedule API ---

export type ScheduleRule = (
  | { kind: 'once'; run_at: string; timezone: string }
  | { kind: 'daily'; time: string; timezone: string }
  | { kind: 'weekly'; weekdays: number[]; time: string; timezone: string }
  | { kind: 'monthly'; monthdays: number[]; time: string; timezone: string }
  | { kind: 'interval'; every: number; unit: 'hours'; weekdays: number[]; timezone: string }
  | { kind: 'cron'; expression: string; timezone: string }
) & { start_date?: string; end_date?: string }

export interface ProjectSchedule {
  id: string
  name: string
  workflow_id: string
  task_template: {
    mode?: 'static' | 'agent'
    title?: string
    description?: string
    start_step_key?: string
    review_overrides?: Record<string, unknown>
    instruction?: string
    candidate_workflow_ids?: string[]
    retry_count?: number
  }
  rule: ScheduleRule
  summary: string
  cron_expression: string | null
  timezone: string
  execution_mode: 'workflow' | 'immediate' | 'manual'
  overlap_policy: 'skip' | 'parallel' | 'queue'
  status: 'active' | 'paused' | 'invalid' | 'completed'
  invalid_reason?: string | null
  next_run_at?: string | null
  last_run_at?: string | null
  created_at: string
  updated_at: string
}

export interface ScheduleRun {
  id: string
  schedule_id: string
  scheduled_for: string
  status: 'queued' | 'running' | 'created' | 'succeeded' | 'failed' | 'skipped'
  reason?: string | null
  task_id?: string | null
  workflow_run_id?: string | null
  started_at?: string | null
  ended_at?: string | null
}

export interface SchedulePayload {
  name: string
  workflow_id: string
  task_template: ProjectSchedule['task_template']
  rule: ScheduleRule
  execution_mode: ProjectSchedule['execution_mode']
  overlap_policy: ProjectSchedule['overlap_policy']
}

export const scheduleApi = {
  list: (projectId: string) => request<{ schedules: ProjectSchedule[] }>(
    `/schedule/list?project_id=${encodeURIComponent(projectId)}`,
  ),
  create: (projectId: string, payload: SchedulePayload) => request<ProjectSchedule>(
    `/schedule/create?project_id=${encodeURIComponent(projectId)}`,
    { method: 'POST', body: JSON.stringify(payload) },
  ),
  update: (projectId: string, id: string, payload: Partial<SchedulePayload>) => request<ProjectSchedule>(
    `/schedule/${encodeURIComponent(id)}?project_id=${encodeURIComponent(projectId)}`,
    { method: 'PATCH', body: JSON.stringify(payload) },
  ),
  pause: (projectId: string, id: string) => request<ProjectSchedule>(
    `/schedule/${encodeURIComponent(id)}/pause?project_id=${encodeURIComponent(projectId)}`,
    { method: 'POST' },
  ),
  resume: (projectId: string, id: string) => request<ProjectSchedule>(
    `/schedule/${encodeURIComponent(id)}/resume?project_id=${encodeURIComponent(projectId)}`,
    { method: 'POST' },
  ),
  delete: (projectId: string, id: string) => request<{ deleted: boolean }>(
    `/schedule/${encodeURIComponent(id)}?project_id=${encodeURIComponent(projectId)}`,
    { method: 'DELETE' },
  ),
  runs: (projectId: string, id: string, limit = 100, offset = 0) => request<{ runs: ScheduleRun[] }>(
    `/schedule/${encodeURIComponent(id)}/runs?project_id=${encodeURIComponent(projectId)}&limit=${limit}&offset=${offset}`,
  ),
  preview: (rule: ScheduleRule) => request<{ cron_expression: string | null; timezone: string; summary: string; next_runs: string[] }>(
    '/schedule/preview', { method: 'POST', body: JSON.stringify(rule) },
  ),
}

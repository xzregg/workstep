/** REST API client for the WorkStep daemon. */

const BASE = '/api'

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers || {}),
    },
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ detail: res.statusText }))
    throw new ApiError(detail.detail || `HTTP ${res.status}`, res.status)
  }
  return res.json()
}

// Dedupe concurrent in-flight reads: React StrictMode double-mounts effects in
// dev, so mount-time fetches would otherwise fire twice (first result discarded).
const inFlightReads = new Map<string, Promise<unknown>>()
function singleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const pending = inFlightReads.get(key)
  if (pending) return pending as Promise<T>
  const promise = run().finally(() => {
    if (inFlightReads.get(key) === promise) inFlightReads.delete(key)
  })
  inFlightReads.set(key, promise)
  return promise
}

export interface SystemSettings {
  user_name: string
  device_id?: string
  device_name?: string
}

export interface ModelPrice {
  provider_id: string | null
  model: string
  input_price: number
  output_price: number
  cache_price: number
}

export interface ModelPricingSettings {
  currency: 'USD' | 'CNY'
  usd_to_cny_rate: number
  prices: ModelPrice[]
  providers: {
    id: string
    name: string
    models: { id: string; label: string; description: string }[]
  }[]
  standalone_models: string[]
}

export const systemSettingsApi = {
  get: () => request<SystemSettings>('/system-settings'),
  updateUserName: (userName: string) => request<SystemSettings>('/system-settings', {
    method: 'PUT',
    body: JSON.stringify({ user_name: userName }),
  }),
  modelPricing: () => request<ModelPricingSettings>('/system-settings/model-pricing'),
  saveModelPricing: (settings: Omit<ModelPricingSettings, 'providers' | 'standalone_models'>) =>
    request<ModelPricingSettings>('/system-settings/model-pricing', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
}

// --- Project API ---

export interface WorkflowSummary {
  id: string
  name: string
  is_default: boolean
  deleted?: boolean
  running?: boolean
  nodeCount: number
}

export interface Project {
  id: string
  path: string
  name: string
  steps: any
  workflows: WorkflowSummary[]
  type?: 'local' | 'remote'
  connection_status?: 'local' | 'connecting' | 'connected' | 'disconnected' | 'error'
  endpoint?: string
  host_project_id?: string
}

export const projectApi = {
  list: () => request<{ projects: Project[] }>('/project/list'),
  init: (path: string, name?: string) =>
    request<Project>('/project/init', {
      method: 'POST',
      body: JSON.stringify({ path, name }),
    }),
  register: (path: string, name?: string) =>
    request<Project>('/project/register', {
      method: 'POST',
      body: JSON.stringify({ path, name }),
    }),
  rename: (path: string, name: string) =>
    request<Project>('/project/rename', {
      method: 'POST',
      body: JSON.stringify({ path, name }),
    }),
  reorder: (orderedIds: string[]) =>
    request<{ reordered: boolean }>('/project/reorder', {
      method: 'POST',
      body: JSON.stringify({ ordered_ids: orderedIds }),
    }),
  delete: (projectId: string) =>
    request<{ deleted: boolean }>(`/project/${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
    }),
  saveSteps: (projectId: string, steps: any, workflowId?: string) =>
    request<{ saved: boolean }>(
      `/project/save-steps?project_id=${encodeURIComponent(projectId)}${workflowId ? `&workflow_id=${encodeURIComponent(workflowId)}` : ''}`,
      {
        method: 'POST',
        body: JSON.stringify({ steps }),
      },
    ),
}

export interface RemoteAccessSettings {
  enabled: boolean
  internal_base_url: string
  external_base_url: string
  host_id: string
}

export interface RemoteDevice {
  project_id: string
  device_id: string
  user_name: string
  device_name: string
  revoked: boolean
  connected: boolean
  last_seen_at: number
}

export const remoteProjectApi = {
  settings: () => request<RemoteAccessSettings>('/remote-project/settings'),
  updateSettings: (settings: Omit<RemoteAccessSettings, 'host_id'>) =>
    request<RemoteAccessSettings>('/remote-project/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
  createShare: (projectId: string, access: 'internal' | 'external') =>
    request<{ share_string: string; endpoint: string; expires_at: number }>('/remote-project/share', {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId, access }),
    }),
  add: (shareString: string) => request<Project>('/remote-project/add', {
    method: 'POST',
    body: JSON.stringify({ share_string: shareString }),
  }),
  remove: (projectId: string) =>
    request<{ deleted: boolean }>(`/remote-project/${encodeURIComponent(projectId)}`, { method: 'DELETE' }),
  devices: (projectId?: string) =>
    request<{ devices: RemoteDevice[]; connected_count: number }>(
      `/remote-project/devices/list${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`,
    ),
  revokeDevice: (projectId: string, deviceId: string) =>
    request<{ revoked: boolean }>('/remote-project/devices/revoke', {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId, device_id: deviceId }),
    }),
}

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

export interface StatisticsStageRow {
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
  stages: StatisticsStageRow[]
  engines: StatisticsEngineRow[]
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

// --- Workflow API ---

export interface WorkflowDetail {
  id: string
  name: string
  steps: any
  is_default: boolean
  created_at: string
  updated_at: string
}

export const workflowApi = {
  list: (projectId: string) =>
    request<{ workflows: WorkflowSummary[] }>(`/workflow/list?project_id=${encodeURIComponent(projectId)}`),
  get: (id: string, projectId: string) =>
    request<WorkflowDetail>(`/workflow/${encodeURIComponent(id)}?project_id=${encodeURIComponent(projectId)}`),
  create: (projectId: string, name: string, steps?: any, templateId?: string) =>
    request<WorkflowDetail>(`/workflow/create?project_id=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      body: JSON.stringify({ name, steps, template_id: templateId, is_default: false }),
    }),
  update: (id: string, projectId: string, name?: string, steps?: any) =>
    request<WorkflowDetail>(`/workflow/${encodeURIComponent(id)}?project_id=${encodeURIComponent(projectId)}`, {
      method: 'PUT',
      body: JSON.stringify({ name, steps }),
    }),
  delete: (id: string, projectId: string) =>
    request<{ deleted: boolean; soft?: boolean }>(`/workflow/${encodeURIComponent(id)}?project_id=${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
    }),
  restore: (id: string, projectId: string) =>
    request<WorkflowDetail>(`/workflow/${encodeURIComponent(id)}/restore?project_id=${encodeURIComponent(projectId)}`, {
      method: 'POST',
    }),
  reorder: (projectId: string, orderedIds: string[]) =>
    request<{ ok: boolean }>(`/workflow/reorder?project_id=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      body: JSON.stringify({ ordered_ids: orderedIds }),
    }),
}

// --- Workflow generation chat API (AI-assisted flow design) ---

export interface WorkflowGenAccepted {
  session_id: string
  turn_id: string
  status: string
}

export interface WorkflowGenHistoryEvent {
  type?: string
  data?: Record<string, unknown>
  timestamp?: number
  created_at?: string
}

export interface WorkflowGenHistoryMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  status: 'succeeded' | 'stopped' | 'error'
  engine?: string
  model?: string
  created_at?: string
  ended_at?: string
  prompt?: string
  events?: WorkflowGenHistoryEvent[]
  author_id?: string
  author_name?: string
  author_device_id?: string
  author_device_name?: string
}

export interface WorkflowGenHistory {
  session_id: string
  engine: string
  model?: string | null
  fast_model?: string | null
  engine_session_id?: string | null
  messages: WorkflowGenHistoryMessage[]
}

export const workflowGenApi = {
  chat: (
    projectId: string,
    content: string,
    sessionId: string | null,
    idempotencyKey: string,
    options: { engine?: string; model?: string; fastModel?: string; providerId?: string; thinkingEffort?: string; steps?: any; workflowName?: string; contextMode?: 'initial' | 'canvas_updated' | 'none'; workflowId?: string } = {},
  ) =>
    request<WorkflowGenAccepted>(`/workflow/generate/chat`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({
        project_id: projectId,
        content,
        session_id: sessionId,
        engine: options.engine || undefined,
        model: options.model || undefined,
        fast_model: options.fastModel || undefined,
        provider_id: options.providerId || undefined,
        thinking_effort: options.thinkingEffort || undefined,
        steps: options.steps || undefined,
        workflow_name: options.workflowName || undefined,
        context_mode: options.contextMode || 'none',
        workflow_id: options.workflowId || undefined,
      }),
    }),
  history: (projectId: string, workflowId: string) =>
    singleFlight(
      `workflow-history:${projectId}/${workflowId}`,
      () => request<WorkflowGenHistory>(
        `/workflow/generate/history?project_id=${encodeURIComponent(projectId)}&workflow_id=${encodeURIComponent(workflowId)}`,
      ),
    ),
  reset: (projectId: string, workflowId: string) =>
    request<{ reset: boolean; session_id: string }>(
      `/workflow/generate/history?project_id=${encodeURIComponent(projectId)}&workflow_id=${encodeURIComponent(workflowId)}`,
      { method: 'DELETE' },
    ),
  stop: (sessionId: string, projectId: string) =>
    request<{ stopped: boolean }>(
      `/workflow/generate/${encodeURIComponent(sessionId)}/stop?project_id=${encodeURIComponent(projectId)}`,
      { method: 'POST' },
    ),
}

// --- Task creation assistant API ---

export interface TaskDraftAccepted {
  session_id: string
  turn_id: string
  status: string
}

export interface TaskDraftChatOptions {
  title: string
  description?: string
  workflowId?: string
  startStepKey?: string
  engine?: string
  model?: string
  fastModel?: string
  providerId?: string
  thinkingEffort?: string
  instruction?: string
  candidateWorkflowIds?: string[]
  allowGenerateTitle?: boolean
}

export const taskDraftApi = {
  chat: (
    projectId: string,
    content: string,
    sessionId: string | null,
    idempotencyKey: string,
    options: TaskDraftChatOptions,
  ) => request<TaskDraftAccepted>('/task-draft/chat', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({
      project_id: projectId,
      content,
      session_id: sessionId,
      title: options.title,
      description: options.description || undefined,
      workflow_id: options.workflowId || undefined,
      start_step_key: options.startStepKey || undefined,
      engine: options.engine || undefined,
      model: options.model || undefined,
      fast_model: options.fastModel || undefined,
      provider_id: options.providerId || undefined,
      thinking_effort: options.thinkingEffort || undefined,
      instruction: options.instruction || undefined,
      candidate_workflow_ids: options.candidateWorkflowIds || undefined,
      allow_generate_title: options.allowGenerateTitle || false,
    }),
  }),
  stop: (sessionId: string, projectId: string) =>
    request<{ stopped: boolean }>(
      `/task-draft/${encodeURIComponent(sessionId)}/stop?project_id=${encodeURIComponent(projectId)}`,
      { method: 'POST' },
    ),
}


// --- Codex-style session chat API ---

export interface ChatSessionSummary {
  id: string
  project_id: string
  workflow_id: string
  title: string
  engine: string
  model?: string | null
  permission_mode?: string
  message_count: number
  preview?: string
  created_at?: string
  updated_at?: string
}

export interface ChatSessionDetail extends ChatSessionSummary {
  messages: WorkflowGenHistoryMessage[]
}

export interface ChatQuickButton {
  id: string
  label: string
  prompt: string
}

export interface ChatAccepted {
  session_id: string
  turn_id: string
  status: string
}

export interface ChatSessionCreateInput {
  project_id: string
  workflow_id?: string
  title?: string
  engine?: string
  model?: string
  fast_model?: string
  provider_id?: string
  permission_mode?: string
}

export interface ChatMessageOptions {
  engine?: string
  model?: string
  fast_model?: string
  provider_id?: string
  thinking_effort?: string
  permission_mode?: string
  plan_mode?: boolean
}

export const chatSessionApi = {
  list: (projectId: string) =>
    request<{ sessions: ChatSessionSummary[] }>(
      `/chat-sessions?project_id=${encodeURIComponent(projectId)}`,
    ),
  create: (input: ChatSessionCreateInput) =>
    request<ChatSessionDetail>('/chat-sessions', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  get: (sessionId: string, projectId: string) =>
    request<ChatSessionDetail>(
      `/chat-sessions/${encodeURIComponent(sessionId)}?project_id=${encodeURIComponent(projectId)}`,
    ),
  rename: (sessionId: string, projectId: string, title: string) =>
    request<ChatSessionSummary>(
      `/chat-sessions/${encodeURIComponent(sessionId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ project_id: projectId, title }),
      },
    ),
  remove: (sessionId: string, projectId: string) =>
    request<{ deleted: boolean }>(
      `/chat-sessions/${encodeURIComponent(sessionId)}?project_id=${encodeURIComponent(projectId)}`,
      { method: 'DELETE' },
    ),
  chat: (
    sessionId: string,
    projectId: string,
    content: string,
    idempotencyKey: string,
    options: ChatMessageOptions = {},
  ) =>
    request<ChatAccepted>(`/chat-sessions/${encodeURIComponent(sessionId)}/chat`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({
        project_id: projectId,
        content,
        engine: options.engine || undefined,
        model: options.model || undefined,
        fast_model: options.fast_model || undefined,
        provider_id: options.provider_id || undefined,
        thinking_effort: options.thinking_effort || undefined,
        permission_mode: options.permission_mode || undefined,
        plan_mode: options.plan_mode || undefined,
      }),
    }),
  stop: (sessionId: string, projectId: string) =>
    request<{ stopped: boolean }>(
      `/chat-sessions/${encodeURIComponent(sessionId)}/stop?project_id=${encodeURIComponent(projectId)}`,
      { method: 'POST' },
    ),
  reorder: (projectId: string, orderedIds: string[]) =>
    request<{ ok: boolean }>(
      `/chat-sessions/reorder?project_id=${encodeURIComponent(projectId)}`,
      {
        method: 'POST',
        body: JSON.stringify({ ordered_ids: orderedIds }),
      },
    ),
  quickButtons: (projectId: string) =>
    request<{ buttons: ChatQuickButton[] }>(
      `/chat-sessions/quick-buttons?project_id=${encodeURIComponent(projectId)}`,
    ),
  saveQuickButtons: (projectId: string, buttons: ChatQuickButton[]) =>
    request<{ buttons: ChatQuickButton[] }>('/chat-sessions/quick-buttons', {
      method: 'PUT',
      body: JSON.stringify({ project_id: projectId, buttons }),
    }),
  getSystemPrompt: (projectId: string) =>
    request<{ prompt: string }>(
      `/chat-sessions/system-prompt?project_id=${encodeURIComponent(projectId)}`,
    ),
  saveSystemPrompt: (projectId: string, prompt: string) =>
    request<{ prompt: string }>('/chat-sessions/system-prompt', {
      method: 'PUT',
      body: JSON.stringify({ project_id: projectId, prompt }),
    }),
  enhancePrompt: (projectId: string, prompt: string) =>
    request<{ prompt: string }>('/chat-sessions/enhance-prompt', {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId, prompt }),
    }),
}


// --- Template API ---

export interface TemplateInfo {
  id: string
  name: string
  description: string
  nodeCount: number
  custom?: boolean
  /** Shipped default template seeded to ~/.workstep/data/templates/ (editable in place). */
  default?: boolean
  steps?: any
}

// --- Template list cache ---
// Template consumers (settings, workflow dialog, canvas) share one cached
// list; only mutations invalidate it and a forced fetch hits the API again.

let templatesCache: { templates: TemplateInfo[] } | null = null
let templatesInflight: Promise<{ templates: TemplateInfo[] }> | null = null

export function getCachedTemplates(): { templates: TemplateInfo[] } | null {
  return templatesCache
}

export async function fetchTemplates(
  force = false,
): Promise<{ templates: TemplateInfo[] }> {
  if (!force) {
    if (templatesCache) return templatesCache
    if (templatesInflight) return templatesInflight
  }
  const promise = templateApi.list().then((result) => {
    templatesCache = result
    return result
  })
  templatesInflight = promise
  try {
    return await promise
  } finally {
    if (templatesInflight === promise) templatesInflight = null
  }
}

export function invalidateTemplates(): void {
  templatesCache = null
  templatesInflight = null
}

export const templateApi = {
  list: () => request<{ templates: TemplateInfo[] }>('/templates/list'),
  get: (id: string) => request<TemplateInfo>(`/templates/${encodeURIComponent(id)}`),
  save: (template: {
    id: string
    name: string
    description: string
    steps: any
  }) => request<{ saved: boolean; id: string }>('/templates/save', {
    method: 'POST',
    body: JSON.stringify(template),
  }),
  del: (id: string) =>
    request<{ deleted: boolean; id: string }>(`/templates/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
}

// --- Task API ---

export interface Task {
  id: string
  title: string
  description: string | null
  cwd: string
  status: string
  archived?: boolean
  engine: string
  model?: string | null
  coordinator_engine?: string | null
  coordinator_model?: string | null
  coordinator_fast_model?: string | null
  coordinator_session_id?: string | null
  active_workflow_run_id?: string | null
  run_round?: number
  restart_from_step_key?: string | null
  recovered_at?: string | null
  recovered_count?: number
  state_version?: number
  review_overrides?: Record<string, any> | null
  created_at: string
  updated_at: string
  first_message_at?: string | null
  completed_at?: string | null
  duration_ms?: number | null
  total_tokens?: number | null
  steps: TaskStepState[]
}

export interface TaskStepState {
  step_key: string
  status: 'pending' | 'running' | 'reviewing' | 'awaiting_review' | 'retrying' | 'rework' | 'rework_waiting' | 'passed' | 'rejected' | 'failed' | 'cancelled' | 'skipped'
  engine: string | null
  session_id?: string | null
  started_at: string | null
  ended_at: string | null
  error: string | null
}

export interface ReviewRun {
  id: string
  workflow_run_id: string
  step_run_id: string
  step_key: string
  mode: 'auto' | 'manual'
  status: 'pending' | 'running' | 'passed' | 'rejected' | 'failed' | 'skipped'
  engine: string | null
  model: string | null
  report: {
    passed: boolean
    score: number | null
    summary: string
    issues: Array<{
      severity: 'error' | 'warning'
      category: string
      description: string
      suggestion: string
    }>
  } | null
  decision: string | null
  decision_comment: string | null
  started_at: string | null
  ended_at: string | null
}

export interface TaskArtifact {
  step_key: string
  name: string
  logical_name: string | null
  artifact_type: string | null
  path: string
  relative_path: string
  size: number | null
  is_dir?: boolean
}

export interface ActionProposal {
  id: string
  type: 'supplement_stage' | 'rerun_from_stage' | 'review_decision'
  target_step_key: string | null
  payload: Record<string, unknown>
  impact: { summary?: string; target_step_key?: string } | null
  status: 'pending' | 'executing' | 'succeeded' | 'failed' | 'cancelled' | 'expired'
  result: Record<string, unknown> | null
  error: string | null
}

export interface CoordinatorEngineSummary {
  id: string
  mode: 'cli' | 'acp' | 'agent' | 'sdk' | null
  installed: boolean
  configured: boolean
  verified: boolean
  built_in: boolean
  supports_coordinator: boolean
  supports_provider: boolean
  provider_protocols: string[]
}

export interface CoordinatorSelection {
  configured: {
    engine: string | null
    model: string | null
    fast_model: string | null
    vision_model: string | null
    thinking_effort: string | null
    provider_id: string | null
  }
  resolved: {
    engine: string
    model: string | null
    fast_model: string | null
    vision_model: string | null
    thinking_effort: string | null
    provider_id: string | null
  }
}

export interface CoordinatorConfig extends CoordinatorSelection {
  available_engines: CoordinatorEngineSummary[]
}

export const taskApi = {
  list: (projectId: string, workflowId?: string | null, archived?: boolean) =>
    request<{ tasks: Task[] }>(
      `/task/list?project_id=${encodeURIComponent(projectId)}${workflowId ? '&workflow_id=' + encodeURIComponent(workflowId) : ''}${archived ? '&archived=true' : ''}`
    ),
  create: (
    title: string,
    cwd: string,
    projectId: string,
    engine?: string,
    description?: string,
    startStepKey?: string | null,
    reviewOverrides?: Record<string, any> | null,
    workflowId?: string | null,
    autoStart?: boolean,
  ) =>
    request<Task>(`/task/create?project_id=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      body: JSON.stringify({
        title,
        cwd,
        engine,
        description,
        start_step_key: startStepKey,
        auto_start: autoStart,
        review_overrides: reviewOverrides,
        workflow_id: workflowId,
      }),
    }),
  get: (id: string, projectId: string) =>
    request<Task>(`/task/${id}?project_id=${encodeURIComponent(projectId)}`),
  updateDescription: (id: string, projectId: string, description: string | undefined, reviewOverrides?: Record<string, any> | null) =>
    request<Task>(`/task/${id}?project_id=${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ description, review_overrides: reviewOverrides }),
    }),
  history: (taskId: string, projectId: string, limit = 50, offset = 0) =>
    request<{ messages: any[]; limit: number; offset: number }>(
      `/task/${taskId}/history?project_id=${encodeURIComponent(projectId)}&limit=${limit}&offset=${offset}`
    ),
  respondInteraction: (interactionId: string, data: Record<string, unknown>, projectId?: string) =>
    request<{ delivered: boolean }>(`/intervention/respond${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`, {
      method: 'POST',
      body: JSON.stringify({ intervention_id: interactionId, data }),
    }),
  chat: (taskId: string, content: string, projectId: string, idempotencyKey: string) =>
    request<{
      turn_id: string
      user_message_id: string
      assistant_message_id: string
      status: 'queued' | 'running' | 'succeeded' | 'failed'
    }>(`/task/${taskId}/chat?project_id=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ content }),
    }),
  stopCoordinator: (taskId: string, projectId: string) =>
    request<{ stopped: boolean }>(
      `/task/${taskId}/coordinator/stop?project_id=${encodeURIComponent(projectId)}`,
      { method: 'POST' },
    ),
  sendStageMessage: (taskId: string, stepKey: string, content: string, projectId: string, asGuidance = false) =>
    request<{ message_id: string; step_key: string; status: 'queued'; sequence?: number; created_at?: string }>(
      `/task/${taskId}/step/${encodeURIComponent(stepKey)}/message?project_id=${encodeURIComponent(projectId)}`,
      {
        method: 'POST',
        body: JSON.stringify({ content, as_guidance: asGuidance }),
      },
    ),
  cancelStep: (taskId: string, stepKey: string, projectId: string) =>
    request<{ cancelled: boolean }>(
      `/task/${taskId}/step/${encodeURIComponent(stepKey)}/cancel?project_id=${encodeURIComponent(projectId)}`,
      { method: 'POST' },
    ),
  resumeStageWithMessage: (taskId: string, stepKey: string, content: string, projectId: string) =>
    request<{ message_id: string; step_key: string; run_id: string; status: 'queued'; sequence?: number; created_at?: string }>(
      `/task/${taskId}/step/${encodeURIComponent(stepKey)}/resume?project_id=${encodeURIComponent(projectId)}`,
      {
        method: 'POST',
        body: JSON.stringify({ content }),
      },
    ),
  coordinatorConfig: (taskId: string, projectId: string) =>
    request<CoordinatorConfig>(
      `/task/${taskId}/coordinator-config?project_id=${encodeURIComponent(projectId)}`,
    ),
  updateCoordinatorConfig: (
    taskId: string,
    projectId: string,
    engine: string | null,
    model: string | null,
    fastModel: string | null,
    visionModel: string | null,
    thinkingEffort: string | null,
    providerId: string | null,
  ) => request<CoordinatorSelection>(
    `/task/${taskId}/coordinator-config?project_id=${encodeURIComponent(projectId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        engine,
        model,
        fast_model: fastModel,
        vision_model: visionModel,
        thinking_effort: thinkingEffort,
        provider_id: providerId,
      }),
    },
  ),
  confirmAction: (
    taskId: string,
    proposalId: string,
    projectId: string,
    idempotencyKey: string,
  ) => request<ActionProposal>(
    `/task/${taskId}/actions/${proposalId}/confirm?project_id=${encodeURIComponent(projectId)}`,
    { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey } },
  ),
  cancelAction: (taskId: string, proposalId: string, projectId: string) =>
    request<ActionProposal>(
      `/task/${taskId}/actions/${proposalId}/cancel?project_id=${encodeURIComponent(projectId)}`,
      { method: 'POST' },
    ),
  artifacts: (taskId: string, projectId: string) =>
    request<{ artifacts: TaskArtifact[] }>(
      `/task/${taskId}/artifacts?project_id=${encodeURIComponent(projectId)}`
    ),
  reviews: (taskId: string, projectId: string) =>
    request<{ reviews: ReviewRun[] }>(
      `/task/${taskId}/reviews?project_id=${encodeURIComponent(projectId)}`
    ),
  decideReview: (
    taskId: string,
    stepKey: string,
    reviewRunId: string,
    decision: 'approve' | 'reject' | 'force-approve',
    projectId: string,
    comment?: string,
  ) =>
    request<{ decision: string; resumed: boolean; run_id: string | null }>(
      `/task/${taskId}/steps/${stepKey}/review/${decision}?project_id=${encodeURIComponent(projectId)}`,
      {
        method: 'POST',
        body: JSON.stringify({ review_run_id: reviewRunId, comment }),
      },
    ),
  run: (taskId: string, prompt: string, projectId: string) =>
    request<{ status: string }>(`/task/run?project_id=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      body: JSON.stringify({ task_id: taskId, prompt }),
    }),
  cancel: (taskId: string, projectId: string) =>
    request<{ cancelled: boolean }>(`/task/cancel?project_id=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      body: JSON.stringify({ task_id: taskId }),
    }),
  pause: (taskId: string, projectId: string) =>
    request<{ paused: boolean }>(`/task/pause?project_id=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      body: JSON.stringify({ task_id: taskId }),
    }),
  delete: (taskId: string, projectId: string) =>
    request<{ deleted: boolean }>(`/task/delete?project_id=${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
      body: JSON.stringify({ task_id: taskId }),
    }),
  archive: (taskId: string, projectId: string) =>
    request<{ archived: boolean }>(`/task/archive?project_id=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      body: JSON.stringify({ task_id: taskId }),
    }),
  unarchive: (taskId: string, projectId: string) =>
    request<{ unarchived: boolean }>(`/task/unarchive?project_id=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      body: JSON.stringify({ task_id: taskId }),
    }),
  copy: (taskId: string, projectId: string, newTitle: string) =>
    request<Task>(`/task/copy?project_id=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      body: JSON.stringify({ task_id: taskId, newTitle }),
    }),
  share: {
    get: (taskId: string, projectId: string) =>
      request<ShareInfo>(
        `/task-share/${encodeURIComponent(taskId)}?project_id=${encodeURIComponent(projectId)}`,
      ),
    create: (taskId: string, projectId: string, password?: string | null, title?: string | null) =>
      request<ShareInfo>(
        `/task-share/${encodeURIComponent(taskId)}/create?project_id=${encodeURIComponent(projectId)}`,
        {
          method: 'POST',
          body: JSON.stringify({ password: password || null, title: title ?? null }),
        },
      ),
    revoke: (taskId: string, projectId: string) =>
      request<{ revoked: boolean }>(
        `/task-share/${encodeURIComponent(taskId)}?project_id=${encodeURIComponent(projectId)}`,
        { method: 'DELETE' },
      ),
  },
}

// --- Public share API (no project context, session-token gated) ---

export interface ShareInfo {
  id: string
  task_id: string
  token: string
  title: string | null
  revoked: boolean
  has_password: boolean
  created_at: string
  revoked_at: string | null
}

export interface ShareMeta {
  token: string
  title: string | null
  task_id: string
  has_password: boolean
  created_at: string
}

export interface SharedTask {
  id: string
  title: string
  description: string | null
  status: string
  engine: string
  model: string | null
  workflow_id: string | null
  workflow: { id: string; name: string; steps: any } | null
  created_at: string
  updated_at: string
  steps: TaskStepState[]
}

async function shareRequest<T>(
  path: string,
  sessionToken: string,
  options?: RequestInit,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Share-Session': sessionToken,
      ...(options?.headers || {}),
    },
  })
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(detail.detail || `HTTP ${res.status}`)
  }
  return res.json()
}

export const shareApi = {
  meta: (token: string) =>
    request<ShareMeta>(`/task-share/public/${encodeURIComponent(token)}/meta`),
  unlock: (token: string, password: string) =>
    request<{ session_token: string }>(
      `/task-share/public/${encodeURIComponent(token)}/unlock`,
      {
        method: 'POST',
        body: JSON.stringify({ password }),
      },
    ),
  task: (token: string, sessionToken: string) =>
    shareRequest<SharedTask>(
      `/task-share/public/${encodeURIComponent(token)}/task`,
      sessionToken,
    ),
  history: (token: string, sessionToken: string, limit = 200, offset = 0) =>
    shareRequest<{ messages: any[]; limit: number; offset: number }>(
      `/task-share/public/${encodeURIComponent(token)}/history?limit=${limit}&offset=${offset}`,
      sessionToken,
    ),
  artifacts: (token: string, sessionToken: string) =>
    shareRequest<{ artifacts: TaskArtifact[] }>(
      `/task-share/public/${encodeURIComponent(token)}/artifacts`,
      sessionToken,
    ),
  buildWsUrl: (sessionToken: string): string => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${window.location.host}/ws/share?session=${encodeURIComponent(sessionToken)}`
  },
}

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

// --- Engine API ---

export interface EngineInfo {
  id: string
  installed: boolean
  configured: boolean
  verified: boolean
  built_in: boolean
  version: string | null
  mode: 'cli' | 'acp' | 'agent' | 'sdk' | null
  config: EngineConfigPayload | null
  installable: boolean
  install_command: string | null
  supports_resume: boolean
  supports_coordinator: boolean
  supports_tool_disable: boolean
  supports_native_schema: boolean
  supports_live_stage_message: boolean
  supports_provider: boolean
  provider_protocols: string[]
  binary_path: string | null
  configured_path: string | null
}

export interface EngineInstallResult {
  engine_id: string
  success: boolean
  already_installed: boolean
  message: string
  engine?: EngineInfo
}

export interface EngineTestResult {
  engine_id: string
  success: boolean
  message: string
  duration_ms: number
  engine?: EngineInfo
}

export interface ExecutionDefaultConfig {
  engine: string
  resolved_engine: string
}

export interface CoordinatorDefaultConfig {
  engine: string
  model: string
  fast_model: string
  vision_model: string
  thinking_effort: string
  available_engines: CoordinatorEngineSummary[]
}

export interface AssistantConfiguredDefaults {
  engine: string
  model: string
  fast_model: string
  vision_model: string
  thinking_effort: string
  provider_id: string
}

export interface AssistantConfigInfo {
  name: string
  channel: string
  scope: string
  engine_label: string
  fields: string[]
  configured: AssistantConfiguredDefaults
  available_engines: CoordinatorEngineSummary[]
}

export interface AssistantSaveResult {
  saved: boolean
  configured: Partial<AssistantConfiguredDefaults>
}

export interface EngineModel {
  id: string
  label: string
  description: string | null
}

export interface EngineModelsResult {
  engine_id: string
  models: EngineModel[]
  default_model: string
  fetched_at?: string | null
  error: string | null
}

export interface EngineInspectResult {
  engine_id: string
  project_root: string | null
  skills: Array<{
    name: string
    description: string
    source_dir: string
  }>
  input_items: EngineInputItem[]
  mcp_servers: Array<{
    name: string
    command: string
    args: string[]
  }>
  mcp_supported: boolean
  mcp_error: string | null
}

export interface EngineInputItem {
  kind: 'skill' | 'command'
  name: string
  description: string
  input_hint?: string
  insert_text: string
  action: 'prompt' | 'toggle_plan' | 'open_model' | 'open_reasoning' | 'show_status'
}

export interface EngineConfigOption {
  value: string
  label: string
}

export interface EngineConfigField {
  key: string
  label: string
  type: 'text' | 'password' | 'select' | 'textarea' | 'number' | 'checkbox'
  placeholder: string
  options: EngineConfigOption[] | null
  required: boolean
  help: string
  default: string | number | boolean
  sensitive: boolean
  confirm_values: string[]
}

export interface EngineConfigSchema {
  engine_id: string
  fields: EngineConfigField[]
  values: Record<string, string>
  secrets: Record<string, boolean>
  configured: boolean
  installed: boolean
  saved?: boolean
  message?: string
  engine?: EngineInfo
}

export interface EngineConfigPayload {
  fields: EngineConfigField[]
  stage_fields: EngineConfigField[]
  values: Record<string, string>
  secrets: Record<string, boolean>
}

export interface EngineConfigSaveInput {
  values: Record<string, string>
  clear?: Record<string, boolean>
  confirmed?: Record<string, boolean>
}

// --- Provider (供应商) API ---

export interface ProviderInfo {
  id: string
  name: string
  type: string
  protocol: string
  base_url: string
  api_key: string
  has_key: boolean
  enabled: boolean
  verified: boolean
  created_at: string
  model_count: number
  models_fetched_at: string | null
}

export interface ProviderTypeMeta {
  id: string
  label: string
  default_base_url: string
  auth: string
  default_protocol: string
  help: string
}

export interface ProviderListResult {
  providers: ProviderInfo[]
  types: ProviderTypeMeta[]
}

export interface ProviderSaveInput {
  id?: string
  name: string
  type: string
  protocol: string
  base_url: string
  api_key?: string
  enabled?: boolean
  clear?: Record<string, boolean>
  confirmed?: Record<string, boolean>
}

export interface ProviderSaveResult {
  saved: boolean
  message?: string
  provider: ProviderInfo | null
}

export interface ProviderTestResult {
  provider_id: string
  success: boolean
  message: string
  duration_ms: number
}

export interface ProviderModelsResult {
  provider_id: string
  models: EngineModel[]
  fetched_at?: string | null
  error: string | null
}

export interface ProviderImportCandidate {
  id: string
  source_type: string
  name: string
  type: string
  protocol: string
  base_url: string
  has_key: boolean
  wire_api: string
  model_ids: string[]
  category: string
  error: string | null
  already_exists: boolean
}

export interface ProviderImportSource {
  id: string
  name: string
  provider_count: number
  description: string
  providers: ProviderImportCandidate[]
}

export interface ProviderImportResult {
  source: string
  imported: ProviderInfo[]
  skipped: { id: string; name: string; message: string }[]
  errors: { id: string; name: string; message: string }[]
}

export const providerApi = {
  list: (projectId = '') => request<ProviderListResult>(
    `/provider/list${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`,
  ),
  save: (input: ProviderSaveInput) =>
    request<ProviderSaveResult>('/provider', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  remove: (providerId: string) =>
    request<{ deleted: boolean }>(`/provider/${encodeURIComponent(providerId)}`, {
      method: 'DELETE',
    }),
  test: (providerId: string) =>
    request<ProviderTestResult>(`/provider/${encodeURIComponent(providerId)}/test`, {
      method: 'POST',
      body: JSON.stringify({ timeout_seconds: 15 }),
    }),
  models: (providerId: string, refresh = false) =>
    request<ProviderModelsResult>(
      `/provider/${encodeURIComponent(providerId)}/models${
        refresh ? '?refresh=1' : ''
      }`,
    ),
  reveal: (providerId: string) =>
    request<{ key: string; value: string | null }>(
      `/provider/${encodeURIComponent(providerId)}/reveal`,
      { method: 'POST' },
    ),
  importSources: () =>
    request<{ sources: ProviderImportSource[] }>('/provider/import/sources'),
  importFromCcSwitch: (providerIds: string[]) =>
    request<ProviderImportResult>('/provider/import/cc-switch', {
      method: 'POST',
      body: JSON.stringify({ provider_ids: providerIds }),
    }),
}

// --- Engine model list cache ---
// Model dropdowns fetch each engine's model list once and reuse the result
// across pages. Only a manual refresh (force = true) hits the remote API
// again; invalidateEngineModels() clears the cache when the engine's config
// or binary path changes.

const engineModelsCache = new Map<string, EngineModelsResult>()

function modelsCacheKey(engineId: string, providerId: string, projectId: string): string {
  return `${engineId}::${providerId}::${projectId}`
}

export function getCachedEngineModels(
  engineId: string,
  providerId = '',
  projectId = '',
): EngineModelsResult | null {
  return engineModelsCache.get(modelsCacheKey(engineId, providerId, projectId)) ?? null
}

export async function fetchEngineModels(
  engineId: string,
  force = false,
  providerId = '',
  projectId = '',
): Promise<EngineModelsResult> {
  const cacheKey = modelsCacheKey(engineId, providerId, projectId)
  const cached = engineModelsCache.get(cacheKey)
  if (cached && !force) return cached
  const result = await engineApi.models(engineId, providerId, force, projectId)
  engineModelsCache.set(cacheKey, result)
  return result
}

export function invalidateEngineModels(engineId: string): void {
  for (const key of Array.from(engineModelsCache.keys())) {
    if (key.startsWith(`${engineId}::`)) {
      engineModelsCache.delete(key)
    }
  }
}

export const engineApi = {
  list: () => request<{ engines: EngineInfo[] }>('/engine/list'),
  refresh: () =>
    request<{ engines: EngineInfo[] }>('/engine/refresh', { method: 'POST' }),
  executionConfig: () =>
    request<ExecutionDefaultConfig>('/engine/execution/config'),
  setExecutionConfig: (engine: string) =>
    request<ExecutionDefaultConfig & { saved: boolean }>('/engine/execution/config', {
      method: 'PUT',
      body: JSON.stringify({ engine }),
    }),
  coordinatorDefaults: (projectId = '') =>
    singleFlight(`engine/coordinator/config::${projectId}`, () =>
      request<CoordinatorDefaultConfig>(
        `/engine/coordinator/config${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`,
      ),
    ),
  setCoordinatorDefaults: (engine: string, model: string, fastModel: string, visionModel: string, thinkingEffort: string) =>
    request<{ saved: boolean; engine: string; model: string; fast_model: string; vision_model: string; thinking_effort: string }>(
      '/engine/coordinator/config',
      {
        method: 'PUT',
        body: JSON.stringify({
          engine,
          model,
          fast_model: fastModel,
          vision_model: visionModel,
          thinking_effort: thinkingEffort,
        }),
      },
    ),
  test: (engineId: string) =>
    request<EngineTestResult>('/engine/test', {
      method: 'POST',
      body: JSON.stringify({ engine_id: engineId }),
    }),
  install: (engineId: string) =>
    request<EngineInstallResult>(`/engine/${encodeURIComponent(engineId)}/install`, {
      method: 'POST',
    }),
  models: (engineId: string, providerId = '', refresh = false, projectId = '') =>
    request<EngineModelsResult>(
      `/engine/${encodeURIComponent(engineId)}/models${
        providerId || refresh || projectId ? '?' : ''
      }${[
        providerId ? `provider_id=${encodeURIComponent(providerId)}` : '',
        refresh ? 'refresh=1' : '',
        projectId ? `project_id=${encodeURIComponent(projectId)}` : '',
      ].filter(Boolean).join('&')}`,
    ),
  setDefaultModel: (engineId: string, model: string) =>
    request<{ engine_id: string; default_model: string; saved: boolean }>(
      `/engine/${encodeURIComponent(engineId)}/default-model`,
      {
        method: 'PUT',
        body: JSON.stringify({ model }),
      },
    ),
  setBinaryPath: (engineId: string, path: string) =>
    request<{
      engine_id: string
      saved: boolean
      message?: string
      engine?: EngineInfo
    }>(`/engine/${encodeURIComponent(engineId)}/binary-path`, {
      method: 'PUT',
      body: JSON.stringify({ path }),
    }),
  config: (engineId: string) =>
    request<EngineConfigSchema>(`/engine/${encodeURIComponent(engineId)}/config`),
  saveConfig: (engineId: string, input: EngineConfigSaveInput) =>
    request<EngineConfigSchema>(`/engine/${encodeURIComponent(engineId)}/config`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  revealConfig: (engineId: string, key: string) =>
    request<{ key: string; value: string | null }>(
      `/engine/${encodeURIComponent(engineId)}/config/reveal`,
      {
        method: 'POST',
        body: JSON.stringify({ key }),
      },
    ),
  inspect: (engineId: string, projectId?: string, projectRoot?: string) => {
    const params = new URLSearchParams()
    if (projectId) params.set('project_id', projectId)
    if (projectRoot) params.set('project_root', projectRoot)
    const query = params.toString()
    return request<EngineInspectResult>(
      `/engine/${encodeURIComponent(engineId)}/inspect${query ? `?${query}` : ''}`,
    )
  },
}

// --- Assistant API ---

export interface EnhanceConfigResult {
  provider_id: string
  model: string
  providers: {
    id: string
    name: string
    type: string
    base_url: string
    enabled: boolean
  }[]
}

export const assistantApi = {
  list: () => request<{ assistants: AssistantConfigInfo[] }>('/assistant/list'),
  enhanceConfig: () => request<EnhanceConfigResult>('/assistant/enhance-config'),
  setEnhanceConfig: (config: { providerId: string; model: string }) =>
    request<{ saved: boolean; provider_id: string; model: string }>(
      '/assistant/enhance-config',
      {
        method: 'PUT',
        body: JSON.stringify({
          provider_id: config.providerId,
          model: config.model,
        }),
      },
    ),
  setConfig: (
    name: string,
    config: {
      engine: string
      model?: string
      fastModel?: string
      visionModel?: string
      thinkingEffort?: string
      providerId?: string
    },
  ) =>
    request<AssistantSaveResult>(
      `/assistant/${encodeURIComponent(name)}/config`,
      {
        method: 'PUT',
        body: JSON.stringify({
          engine: config.engine,
          model: config.model ?? '',
          fast_model: config.fastModel ?? '',
          vision_model: config.visionModel ?? '',
          thinking_effort: config.thinkingEffort ?? '',
          provider_id: config.providerId ?? '',
        }),
      },
    ),
}

// --- File System API ---

export interface FilePreview {
  type: 'text' | 'image' | 'binary'
  content_type: string
  content: string
  file_size: number
  extension?: string
}

export interface DirectoryOpener {
  id: string
  label: string
  available: boolean
}

export interface DirectoryEntry {
  name: string
  type: 'directory' | 'file'
  path: string
}

export interface DirectoryBrowseResult {
  path: string
  name: string
  parent: string | null
  entries: DirectoryEntry[]
}

export const fsApi = {
  readMemory: (projectId: string) =>
    request<{ path: string; content: string }>(
      `/fs/memory?project_id=${encodeURIComponent(projectId)}`
    ),
  saveMemory: (projectId: string, content: string) =>
    request<{ path: string; saved: boolean }>(
      `/fs/memory?project_id=${encodeURIComponent(projectId)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ content }),
      }
    ),
  uploadImage: async (file: File, projectId: string, prefix?: string) => {
    // Convert file to base64 data URL, then upload as JSON
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
    const res = await fetch(
      `${BASE}/fs/upload/image?project_id=${encodeURIComponent(projectId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, data_url: dataUrl, prefix }),
      }
    )
    if (!res.ok) throw new Error('Upload failed')
    const data = await res.json()
    return data as { url: string; filename: string; size: number }
  },

  preview: (path: string, projectId?: string) => request<FilePreview>(`/fs/preview?path=${encodeURIComponent(path)}${projectId ? `&project_id=${encodeURIComponent(projectId)}` : ''}`),
  browse: (path?: string, projectId?: string) =>
    request<DirectoryBrowseResult>(
      path
        ? `/fs/browse?path=${encodeURIComponent(path)}${projectId ? `&project_id=${encodeURIComponent(projectId)}` : ''}`
        : `/fs/browse${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`
    ),
  mkdir: (parent: string, name: string) =>
    request<{ path: string; name: string }>('/fs/mkdir', {
      method: 'POST',
      body: JSON.stringify({ parent, name }),
    }),
  fileUrl: (path: string, projectId?: string) =>
    `${BASE}/fs/raw/${path
      .replace(/^\/+/, '')
      .split('/')
      .map(encodeURIComponent)
      .join('/')}${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`,
  directoryOpeners: () =>
    request<{ platform: string; openers: DirectoryOpener[] }>('/fs/directory-openers'),
  openDirectory: (path: string, opener = 'file_manager') =>
    request<{ opened: boolean; path: string }>('/fs/open-directory', {
      method: 'POST',
      body: JSON.stringify({ path, opener }),
    }),
}

// --- Session/Search API ---

export interface Session {
  id: string
  title: string
  description: string | null
  status: string
  engine: string
  created_at: string
  updated_at: string
}

export const sessionApi = {
  list: (projectId: string | null, limit = 50, offset = 0) =>
    request<{ sessions: Session[]; limit: number; offset: number }>(
      `/sessions?${projectId ? `project_id=${encodeURIComponent(projectId)}&` : ''}limit=${limit}&offset=${offset}`
    ),
}

export interface SearchParams {
  query?: string
  status?: string
  engine?: string
  startDate?: string
  endDate?: string
  limit?: number
  offset?: number
}

export const searchApi = {
  tasks: (params: SearchParams) => {
    const url = new URL('/search/tasks', window.location.origin)
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.append(key, String(value))
      }
    })
    return request<{ tasks: Task[]; limit: number; offset: number }>(url.pathname + url.search)
  },
}

import { FULL_PAGE_LIMIT, request } from './transport'
import type { ShareInfo } from './share'
import type { EngineInfo } from './client'
import type { ChatMessageEventsPage } from './conversations'

// --- Task API ---

export interface Task {
  id: string
  workflow_id?: string | null
  title: string
  description: string | null
  cwd: string
  status: string
  queue_position?: number | null
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
  scheduled_start_at?: string | null
  scheduled_start_state?: 'pending' | 'missed' | 'failed' | null
  scheduled_start_error?: string | null
  source_dispatch_id?: string | null
  source_project_id?: string | null
  source_task_id?: string | null
  source_step_key?: string | null
  creator_id?: string | null
  creator_name?: string | null
  creator_device_id?: string | null
  creator_device_name?: string | null
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
  /** 该步骤最新产物轮数（权威来源：后端 StepRun.artifact_round 的最大值）。 */
  artifact_round?: number | null
  /** 最近一次实际执行该阶段时使用的输入输出约定。 */
  io_contract?: {
    inputs?: Array<{ name?: string; type?: string }>
    outputs?: Array<{ name?: string; type?: string }>
  } | null
  /** 当前状态被重置为 pending 时，最近一次历史结果。 */
  previous_status?: TaskStepState['status'] | null
  /** 该步骤是否执行过（含失败 / 停止）；用于决定「发给谁」里能否 @ 该步骤。 */
  has_history?: boolean
}

export interface ReviewRun {
  id: string
  workflow_run_id: string
  step_run_id: string
  artifact_round: number | null
  step_key: string
  mode: 'auto' | 'manual'
  status: 'pending' | 'running' | 'passed' | 'rejected' | 'failed' | 'skipped' | 'terminated'
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
  error?: string | null
  decision_comment: string | null
  reviewer_id: string | null
  reviewer_name: string | null
  reviewer_device_id: string | null
  reviewer_device_name: string | null
  started_at: string | null
  ended_at: string | null
}

export interface TaskExecutionRun {
  id: string
  round: number
  status: string
  parent_run_id: string | null
  restart_from_step_key: string | null
  started_at: string | null
  ended_at: string | null
}

export interface TaskExecutionSegment {
  id: string
  type: 'execution' | 'review'
  workflow_run_id: string
  step_run_id: string
  round: number
  step_key: string
  step_title: string
  attempt: number
  status: string
  engine: string | null
  model: string | null
  started_at: string | null
  ended_at: string | null
  duration_ms: number | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  total_tokens: number
  cost: number
  cost_source: 'provider' | 'estimated' | 'mixed' | null
  message_count: number
}

export interface TaskExecutionReport {
  currency: string
  generated_at: string
  summary: {
    duration_ms: number
    total_tokens: number
    cost: number
    provider_cost: number
    estimated_cost: number
    usage_coverage: number | null
    run_count: number
    attempt_count: number
    retry_count: number
  }
  runs: TaskExecutionRun[]
  segments: TaskExecutionSegment[]
  step_breakdown: Array<{
    step_key: string
    step_title: string
    status: string
    attempt_count: number
    duration_ms: number
    total_tokens: number
    cost: number
  }>
  user_breakdown: Array<{
    author_id: string
    author_name: string
    message_count: number
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_write_tokens: number
    total_tokens: number
    cost: number
  }>
  milestones: Array<{
    id: string
    kind: 'step_completed' | 'review_completed' | 'task_completed'
    step_key: string | null
    step_title: string
    status: string
    at: string
    duration_ms: number | null
    total_tokens: number
    cost: number
  }>
  data_quality: {
    eligible_usage_calls: number
    reported_usage_calls: number
  }
}

export interface TaskArtifact {
  step_key: string
  round: number
  is_latest: boolean
  is_selected: boolean
  manifest_status: string | null
  eligible_for_downstream: boolean
  name: string
  logical_name: string | null
  artifact_type: string | null
  output_port?: number | null
  declared_output?: boolean
  path: string
  relative_path: string
  size: number | null
  is_dir?: boolean
  updated_at?: string | null
  unchanged_from_round?: number | null
  round_unchanged_from?: number | null
}

export interface TaskArtifactInputSource {
  edge_id?: string
  kind?: string
  step: string
  output_port?: number
  round: number
  name: string
  path: string
  size?: number
}

export interface TaskArtifactInputSnapshot {
  step_key: string
  round: number
  execution_type?: string
  triggered_edges?: string[]
  ports: Array<{
    port: number
    name: string
    status: string
    sources: TaskArtifactInputSource[]
  }>
}

export interface ActionProposal {
  id: string
  type: 'supplement_step' | 'rerun_from_step' | 'review_decision' | 'create_workflow_action'
  target_step_key: string | null
  payload: Record<string, unknown>
  impact: { summary?: string; target_step_key?: string } | null
  status: 'pending' | 'executing' | 'succeeded' | 'failed' | 'cancelled' | 'expired'
  result: Record<string, unknown> | null
  error: string | null
}

export interface CoordinatorEngineSummary {
  name?: string
  description?: string
  enabled?: boolean
  id: string
  mode: 'cli' | 'acp' | 'agent' | 'sdk' | null
  installed: boolean
  configured: boolean
  verified: boolean
  built_in: boolean
  supports_coordinator: boolean
  supports_session_fork: boolean
  supports_provider: boolean
  provider_protocols: string[]
  skill_policy?: string
  supports_controlled_skills?: boolean
}

export interface EngineQuota {
  engine_id: string
  limit_name?: string | null
  plan_type?: string | null
  primary: {
    used_percent: number
    remaining_percent: number
    resets_at?: number | null
    window_duration_mins?: number | null
  }
  secondary?: EngineQuota['primary'] | null
  credits?: { balance?: string | null; has_credits: boolean; unlimited: boolean }
  individual_limit?: {
    limit: string
    used: string
    remaining_percent: number
    resets_at?: number | null
  }
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

export interface StepExecutionSelection {
  engine: string
  model: string
  config: Record<string, string>
}

export interface StepExecutionConfig {
  configured: StepExecutionSelection | null
  resolved: StepExecutionSelection
  source: 'workflow' | 'task_override'
  editable: boolean
  status: string
  has_history: boolean
  message_count: number
  session_engine: string
  /** Provider bound to the reusable engine session; null = no reusable session. */
  session_provider: string | null
  available_engines: EngineInfo[]
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
    scheduledStartAt?: string | null,
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
        scheduled_start_at: scheduledStartAt,
        review_overrides: reviewOverrides,
        workflow_id: workflowId,
      }),
    }),
  get: (id: string, projectId: string) =>
    request<Task>(`/task/${id}?project_id=${encodeURIComponent(projectId)}`),
  executionReport: (id: string, projectId: string) =>
    request<TaskExecutionReport>(
      `/task/${encodeURIComponent(id)}/execution-report?project_id=${encodeURIComponent(projectId)}`,
    ),
  updateDescription: (id: string, projectId: string, description: string | undefined, reviewOverrides?: Record<string, any> | null) =>
    request<Task>(`/task/${id}?project_id=${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ description, review_overrides: reviewOverrides }),
    }),
  history: (taskId: string, projectId: string, limit = 50, offset = 0) =>
    request<{ messages: any[]; limit: number; offset: number }>(
      `/task/${taskId}/history?project_id=${encodeURIComponent(projectId)}&limit=${limit}&offset=${offset}`
    ),
  messageEvents: (
    taskId: string,
    messageId: string,
    projectId: string,
    cursor = 0,
    limit = FULL_PAGE_LIMIT,
  ) => request<ChatMessageEventsPage>(
    `/task/${encodeURIComponent(taskId)}/messages/${encodeURIComponent(messageId)}/events`
    + `?project_id=${encodeURIComponent(projectId)}&cursor=${cursor}&limit=${limit}`,
  ),
  respondInteraction: (interactionId: string, data: Record<string, unknown>, projectId?: string) =>
    request<{ delivered: boolean }>(`/intervention/respond${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`, {
      method: 'POST',
      body: JSON.stringify({ intervention_id: interactionId, data }),
    }),
  chat: (
    taskId: string,
    content: string,
    projectId: string,
    idempotencyKey: string,
    pendingInsertIds: string[] = [],
    resetSession = false,
  ) =>
    request<{
      turn_id: string
      user_message_id: string
      assistant_message_id: string
      status: 'queued' | 'running' | 'succeeded' | 'failed'
    }>(`/task/${taskId}/chat?project_id=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ content, pending_insert_ids: pendingInsertIds, reset_session: resetSession }),
    }),
  stopCoordinator: (taskId: string, projectId: string) =>
    request<{ stopped: boolean }>(
      `/task/${taskId}/coordinator/stop?project_id=${encodeURIComponent(projectId)}`,
      { method: 'POST' },
    ),
  sendStepMessage: (taskId: string, stepKey: string, content: string, projectId: string, asGuidance = false) =>
    request<{ message_id: string; step_key: string; channel: 'execution' | 'review'; status: 'queued'; sequence?: number; created_at?: string }>(
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
  resumeStepWithMessage: (
    taskId: string,
    stepKey: string,
    content: string,
    projectId: string,
    resetStep = false,
  ) =>
    request<{ message_id: string; step_key: string; run_id: string; status: 'queued'; sequence?: number; created_at?: string }>(
      `/task/${taskId}/step/${encodeURIComponent(stepKey)}/resume?project_id=${encodeURIComponent(projectId)}`,
      {
        method: 'POST',
        body: JSON.stringify({ content, reset_step: resetStep }),
      },
    ),
  restartStepWithFreshSession: (taskId: string, stepKey: string, projectId: string) =>
    request<{ step_key: string; run_id: string; status: 'queued' }>(
      `/task/${taskId}/step/${encodeURIComponent(stepKey)}/restart?project_id=${encodeURIComponent(projectId)}`,
      { method: 'POST' },
    ),
  retryFailedMessage: (taskId: string, messageId: string, projectId: string) =>
    request<{ message_id: string; step_key: string; run_id: string; status: 'queued' }>(
      `/task/${encodeURIComponent(taskId)}/messages/${encodeURIComponent(messageId)}/retry?project_id=${encodeURIComponent(projectId)}`,
      { method: 'POST' },
    ),
  completeFailedMessage: (
    taskId: string, messageId: string, artifactRound: number,
    scheduleDownstream: boolean, projectId: string,
  ) => request<{ completed: boolean; resumed: boolean; run_id: string | null }>(
    `/task/${encodeURIComponent(taskId)}/messages/${encodeURIComponent(messageId)}/set-complete?project_id=${encodeURIComponent(projectId)}`,
    { method: 'POST', body: JSON.stringify({ artifact_round: artifactRound, schedule_downstream: scheduleDownstream }) },
  ),
  stepExecutionConfig: (taskId: string, stepKey: string, projectId: string) =>
    request<StepExecutionConfig>(
      `/task/${encodeURIComponent(taskId)}/step/${encodeURIComponent(stepKey)}/config?project_id=${encodeURIComponent(projectId)}`,
    ),
  updateStepExecutionConfig: (
    taskId: string,
    stepKey: string,
    projectId: string,
    selection: StepExecutionSelection,
    contextMode?: 'smart' | 'full' | 'none',
  ) => request<StepExecutionConfig>(
    `/task/${encodeURIComponent(taskId)}/step/${encodeURIComponent(stepKey)}/config?project_id=${encodeURIComponent(projectId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        ...selection,
        context_mode: contextMode,
      }),
    },
  ),
  resetStepExecutionConfig: (taskId: string, stepKey: string, projectId: string) =>
    request<StepExecutionConfig>(
      `/task/${encodeURIComponent(taskId)}/step/${encodeURIComponent(stepKey)}/config?project_id=${encodeURIComponent(projectId)}`,
      { method: 'DELETE' },
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
  updateScheduledStart: (id: string, projectId: string, scheduledStartAt: string | null) =>
    request<Task>(`/task/${encodeURIComponent(id)}/scheduled-start?project_id=${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ scheduled_start_at: scheduledStartAt }),
    }),
  confirmAction: (
    taskId: string,
    proposalId: string,
    projectId: string,
    idempotencyKey: string,
    overwrite = false,
  ) => request<ActionProposal>(
    `/task/${taskId}/actions/${proposalId}/confirm?project_id=${encodeURIComponent(projectId)}`,
    { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, ...(overwrite ? { body: JSON.stringify({ overwrite: true }) } : {}) },
  ),
  cancelAction: (taskId: string, proposalId: string, projectId: string) =>
    request<ActionProposal>(
      `/task/${taskId}/actions/${proposalId}/cancel?project_id=${encodeURIComponent(projectId)}`,
      { method: 'POST' },
    ),
  artifacts: (taskId: string, projectId: string) =>
    request<{ artifacts: TaskArtifact[]; input_snapshots: TaskArtifactInputSnapshot[]; artifact_directory: string }>(
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
    decision: 'approve' | 'reject' | 'force-approve' | 'terminate' | 'complete-task' | 'set-complete',
    projectId: string,
    comment?: string,
    scheduleDownstream?: boolean,
  ) =>
    request<{ decision: string; resumed: boolean; run_id: string | null }>(
      `/task/${taskId}/steps/${stepKey}/review/${decision}?project_id=${encodeURIComponent(projectId)}`,
      {
        method: 'POST',
        body: JSON.stringify({ review_run_id: reviewRunId, comment, schedule_downstream: scheduleDownstream }),
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
  delete: (taskId: string, projectId: string, deleteWorkspace?: boolean) =>
    request<{ deleted: boolean }>(`/task/delete?project_id=${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
      body: JSON.stringify({ task_id: taskId, delete_workspace: deleteWorkspace }),
    }),
  archive: (taskId: string, projectId: string) =>
    request<{ archived: boolean }>(`/task/archive?project_id=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      body: JSON.stringify({ task_id: taskId }),
    }),
  getArchiveExperienceDraft: (taskId: string, projectId: string) =>
    request<{
      found: boolean
      message_id: string | null
      experience: string
      has_experience: boolean
      events: Array<Record<string, unknown>>
      prompt: string
    }>(
      `/task/${encodeURIComponent(taskId)}/archive-experience/draft?project_id=${encodeURIComponent(projectId)}`,
    ),
  prepareArchiveExperience: (taskId: string, projectId: string, messageId: string) =>
    request<{ message_id: string; experience: string; has_experience: boolean; cached: boolean }>(
      `/task/${encodeURIComponent(taskId)}/archive-experience/prepare?project_id=${encodeURIComponent(projectId)}&message_id=${encodeURIComponent(messageId)}`,
      { method: 'POST' },
    ),
  stopArchiveExperience: (taskId: string, projectId: string, messageId: string) =>
    request<{ stopped: boolean }>(
      `/task/${encodeURIComponent(taskId)}/archive-experience/stop?project_id=${encodeURIComponent(projectId)}&message_id=${encodeURIComponent(messageId)}`,
      { method: 'POST' },
    ),
  confirmArchiveExperience: (taskId: string, projectId: string, experience: string) =>
    request<{ archived: boolean; memory_saved: boolean }>(
      `/task/${encodeURIComponent(taskId)}/archive-experience/confirm?project_id=${encodeURIComponent(projectId)}`,
      {
        method: 'POST',
        body: JSON.stringify({ experience }),
      },
    ),
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
    create: (
      taskId: string,
      projectId: string,
      password?: string | null,
      title?: string | null,
      mode: 'read_only' | 'interactive' = 'read_only',
    ) =>
      request<ShareInfo>(
        `/task-share/${encodeURIComponent(taskId)}/create?project_id=${encodeURIComponent(projectId)}`,
        {
          method: 'POST',
          body: JSON.stringify({
            password: password || null,
            title: title ?? null,
            mode,
          }),
        },
      ),
    revoke: (taskId: string, projectId: string) =>
      request<{ revoked: boolean }>(
        `/task-share/${encodeURIComponent(taskId)}?project_id=${encodeURIComponent(projectId)}`,
        { method: 'DELETE' },
      ),
  },
}

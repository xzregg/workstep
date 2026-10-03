import { FULL_PAGE_LIMIT, request, singleFlight } from './transport'

// --- Workflow generation chat API (AI-assisted flow design) ---

export interface WorkflowGenAccepted {
  session_id: string
  turn_id: string
  assistant_message_id: string
  status: string
}

export interface WorkflowGenHistoryEvent {
  type?: string
  data?: Record<string, unknown>
  timestamp?: number
  created_at?: string
  seq?: number
  [key: string]: unknown
}

export interface MessageEventSummary {
  event_count?: number
  last_event_seq?: number
  thought_characters?: number
  commentary_characters?: number
  tool_count?: number
}

export interface MessageEventDetail extends MessageEventSummary {
  available?: boolean
  loaded?: boolean
}

export interface WorkflowGenHistoryMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  status: 'running' | 'succeeded' | 'stopped' | 'error'
  engine?: string
  model?: string
  created_at?: string
  ended_at?: string
  prompt?: string
  events?: WorkflowGenHistoryEvent[]
  event_summary?: MessageEventSummary
  event_detail?: MessageEventDetail
  author_id?: string
  author_username?: string
  author_name?: string
  author_type?: 'user' | 'assistant' | 'system' | 'scheduler'
  initiated_by_user_id?: string
  initiated_by_username?: string
  author_device_id?: string
  author_device_name?: string
}

export interface WorkflowGenHistory {
  session_id: string
  engine: string
  model?: string | null
  fast_model?: string | null
  vision_model?: string | null
  engine_session_id?: string | null
  messages: WorkflowGenHistoryMessage[]
}

export const workflowGenApi = {
  chat: (
    projectId: string,
    content: string,
    sessionId: string | null,
    idempotencyKey: string,
    options: { engine?: string; model?: string; fastModel?: string; visionModel?: string; providerId?: string; thinkingEffort?: string; steps?: any; workflowName?: string; contextMode?: 'initial' | 'canvas_updated' | 'none'; workflowId?: string } = {},
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
        vision_model: options.visionModel || undefined,
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
  assistant_message_id: string
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
  visionModel?: string
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
      vision_model: options.visionModel || undefined,
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
  archived?: boolean
  source?: 'chat' | 'channel'
  channel_platform?: string | null
  channel_name?: string | null
  engine: string
  model?: string | null
  fast_model?: string | null
  vision_model?: string | null
  provider_id?: string | null
  permission_mode?: string
  engine_session_id?: string | null
  parent_session_id?: string | null
  forked_from_message_id?: string | null
  fork_context_mode?: 'native' | 'smart' | 'full' | 'none' | null
  fork_status?: 'pending' | 'ready' | 'failed'
  running?: boolean
  last_message_status?: string | null
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
  content?: string
  kind?: 'prompt' | 'display' | 'action'
  immediate_send?: boolean
  action_id?: string
  script_path?: string
  cwd_mode?: 'project' | 'task' | 'worktrees'
  require_confirmation?: boolean
  confirmation_input_prompt?: string
}

export interface TaskQuickButton extends ChatQuickButton {
  source: 'project' | 'workflow' | 'stage'
  step_key?: string
}

export interface ActionRun {
  run_id: string
  task_id: string | null
  session_id: string | null
  action_id: string
  button_id: string
  source: 'project' | 'workflow' | 'stage'
  title: string
  script_path: string
  cwd: string
  status: string
  output: string
  exit_code: number | null
  user_message_id: string
  reply_message_id: string
  started_at: string
  ended_at: string | null
  deduplicated?: boolean
}

export const taskActionApi = {
  list: (taskId: string, projectId: string, stepKey?: string) =>
    request<{ buttons: TaskQuickButton[]; runs: ActionRun[] }>(
      `/tasks/${encodeURIComponent(taskId)}/actions?project_id=${encodeURIComponent(projectId)}${stepKey ? `&step_key=${encodeURIComponent(stepKey)}` : ''}`,
    ),
  run: (taskId: string, projectId: string, button: TaskQuickButton, confirmed: boolean, actionInput = '') =>
    request<ActionRun>(`/tasks/${encodeURIComponent(taskId)}/actions/run?project_id=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      body: JSON.stringify({ button_id: button.id, source: button.source, step_key: button.step_key, confirmed, action_input: actionInput }),
    }),
  get: (runId: string, projectId: string) =>
    request<ActionRun>(`/action-runs/${encodeURIComponent(runId)}?project_id=${encodeURIComponent(projectId)}`),
  stop: (runId: string, projectId: string) =>
    request<ActionRun>(`/action-runs/${encodeURIComponent(runId)}/stop?project_id=${encodeURIComponent(projectId)}`, { method: 'POST' }),
}

export const actionDirectoryApi = {
  ensure: (projectId: string, actionId: string, workflowId?: string) =>
    request<{ path: string }>(
      `/projects/${encodeURIComponent(projectId)}/actions/${encodeURIComponent(actionId)}/directory${workflowId ? `?workflow_id=${encodeURIComponent(workflowId)}` : ''}`,
      { method: 'POST' },
    ),
}

export const projectActionApi = {
  list: (sessionId: string, projectId: string) =>
    request<{ buttons: ChatQuickButton[]; runs: ActionRun[]; active_action_ids: string[] }>(
      `/project-actions/sessions/${encodeURIComponent(sessionId)}?project_id=${encodeURIComponent(projectId)}`,
    ),
  run: (sessionId: string, projectId: string, buttonId: string, confirmed: boolean, actionInput = '') =>
    request<ActionRun>(`/project-actions/sessions/${encodeURIComponent(sessionId)}/run?project_id=${encodeURIComponent(projectId)}`, {
      method: 'POST', body: JSON.stringify({ button_id: buttonId, confirmed, action_input: actionInput }),
    }),
}

export interface ChatAccepted {
  session_id: string
  turn_id: string
  assistant_message_id: string
  status: string
}

export interface PendingMessageInsertItem {
  id: string
  target_message_id: string
  content: string
  position: number
  username: string
  created_at: string
  updated_at: string
}

export const pendingMessageInsertApi = {
  list: (projectId: string, targetMessageId: string) =>
    request<{ items: PendingMessageInsertItem[] }>(
      `/pending-message-inserts?project_id=${encodeURIComponent(projectId)}`
      + `&target_message_id=${encodeURIComponent(targetMessageId)}`,
    ),
  create: (projectId: string, targetMessageId: string, content: string) =>
    request<PendingMessageInsertItem>('/pending-message-inserts', {
      method: 'POST',
      body: JSON.stringify({
        project_id: projectId,
        target_message_id: targetMessageId,
        content,
      }),
    }),
  update: (projectId: string, insertId: string, content: string) =>
    request<PendingMessageInsertItem>(
      `/pending-message-inserts/${encodeURIComponent(insertId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ project_id: projectId, content }),
      },
    ),
  reorder: (projectId: string, targetMessageId: string, ids: string[]) =>
    request<{ items: PendingMessageInsertItem[] }>('/pending-message-inserts/reorder', {
      method: 'PUT',
      body: JSON.stringify({
        project_id: projectId,
        target_message_id: targetMessageId,
        ids,
      }),
    }),
  remove: (projectId: string, insertId: string) =>
    request<{ deleted: boolean }>(
      `/pending-message-inserts/${encodeURIComponent(insertId)}`
      + `?project_id=${encodeURIComponent(projectId)}`,
      { method: 'DELETE' },
    ),
  clear: (projectId: string, targetMessageId: string) =>
    request<{ deleted: number }>(
      `/pending-message-inserts?project_id=${encodeURIComponent(projectId)}`
      + `&target_message_id=${encodeURIComponent(targetMessageId)}`,
      { method: 'DELETE' },
    ),
}

export interface ChatMessageEventsPage {
  message_id: string
  events: WorkflowGenHistoryEvent[]
  event_count: number
  last_event_seq: number
  next_cursor: number | null
  complete: boolean
}

export interface ChatSessionCreateInput {
  project_id: string
  workflow_id?: string
  title?: string
  engine?: string
  model?: string
  fast_model?: string
  vision_model?: string
  provider_id?: string
  permission_mode?: string
}

export interface ChatSessionForkInput {
  project_id: string
  title: string
  engine: string
  context_mode: 'native' | 'smart' | 'full' | 'none'
  model?: string
  fast_model?: string
  vision_model?: string
  provider_id?: string
  permission_mode?: string
  fork_message_id?: string
}

export interface ChatSessionHandoffInput {
  project_id: string
  engine: string
  context_mode: 'smart' | 'full' | 'none'
  model?: string
  fast_model?: string
  vision_model?: string
  provider_id?: string
  permission_mode?: string
}

export interface ChatMessageOptions {
  engine?: string
  model?: string
  fast_model?: string
  vision_model?: string
  provider_id?: string
  thinking_effort?: string
  permission_mode?: string
  plan_mode?: boolean
  goal_mode?: boolean
}

export const chatSessionApi = {
  list: (projectId: string, archived = false) =>
    request<{ sessions: ChatSessionSummary[] }>(
      `/chat-sessions?project_id=${encodeURIComponent(projectId)}&archived=${archived}`,
    ),
  setArchived: (sessionId: string, projectId: string, archived: boolean) =>
    request<ChatSessionSummary>(`/chat-sessions/${encodeURIComponent(sessionId)}/archive?project_id=${encodeURIComponent(projectId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ project_id: projectId, archived }),
    }),
  create: (input: ChatSessionCreateInput) =>
    request<ChatSessionDetail>(`/chat-sessions?project_id=${encodeURIComponent(input.project_id)}`, {
      method: 'POST',
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(20_000),
    }),
  get: (sessionId: string, projectId: string) =>
    request<ChatSessionDetail>(
      `/chat-sessions/${encodeURIComponent(sessionId)}?project_id=${encodeURIComponent(projectId)}`,
    ),
  messageEvents: (
    sessionId: string,
    messageId: string,
    projectId: string,
    cursor = 0,
    limit = FULL_PAGE_LIMIT,
  ) => request<ChatMessageEventsPage>(
    `/chat-sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/events`
    + `?project_id=${encodeURIComponent(projectId)}&cursor=${cursor}&limit=${limit}`,
  ),
  rename: (sessionId: string, projectId: string, title: string) =>
    request<ChatSessionSummary>(
      `/chat-sessions/${encodeURIComponent(sessionId)}?project_id=${encodeURIComponent(projectId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ project_id: projectId, title }),
      },
    ),
  updatePermissionMode: (
    sessionId: string,
    projectId: string,
    permissionMode: string,
  ) => request<ChatSessionSummary>(
    `/chat-sessions/${encodeURIComponent(sessionId)}/permission-mode?project_id=${encodeURIComponent(projectId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        project_id: projectId,
        permission_mode: permissionMode,
      }),
    },
  ),
  remove: (sessionId: string, projectId: string) =>
    request<{ deleted: boolean }>(
      `/chat-sessions/${encodeURIComponent(sessionId)}?project_id=${encodeURIComponent(projectId)}`,
      { method: 'DELETE' },
    ),
  fork: (sessionId: string, input: ChatSessionForkInput) =>
    request<ChatSessionDetail>(
      `/chat-sessions/${encodeURIComponent(sessionId)}/fork?project_id=${encodeURIComponent(input.project_id)}`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
  handoff: (sessionId: string, input: ChatSessionHandoffInput) =>
    request<ChatSessionDetail>(
      `/chat-sessions/${encodeURIComponent(sessionId)}/handoff?project_id=${encodeURIComponent(input.project_id)}`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
  chat: (
    sessionId: string,
    projectId: string,
    content: string,
    idempotencyKey: string,
    options: ChatMessageOptions = {},
  ) =>
    request<ChatAccepted>(`/chat-sessions/${encodeURIComponent(sessionId)}/chat?project_id=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({
        project_id: projectId,
        content,
        engine: options.engine || undefined,
        model: options.model || undefined,
        fast_model: options.fast_model || undefined,
        vision_model: options.vision_model || undefined,
        provider_id: options.provider_id || undefined,
        thinking_effort: options.thinking_effort || undefined,
        permission_mode: options.permission_mode || undefined,
        plan_mode: options.plan_mode || undefined,
        goal_mode: options.goal_mode || undefined,
      }),
    }),
  sendLiveMessage: (
    sessionId: string,
    projectId: string,
    content: string,
    pendingInsertIds: string[] = [],
  ) =>
    request<{ message_id: string; status: string; created_at: string }>(
      `/chat-sessions/${encodeURIComponent(sessionId)}/live-message?project_id=${encodeURIComponent(projectId)}`,
      {
        method: 'POST',
        body: JSON.stringify({
          project_id: projectId,
          content,
          pending_insert_ids: pendingInsertIds,
        }),
      },
    ),
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
  bulkDelete: (projectId: string, sessionIds: string[]) =>
    request<{ deleted: string[]; skipped: string[] }>(
      `/chat-sessions/bulk-delete?project_id=${encodeURIComponent(projectId)}`,
      {
        method: 'POST',
        body: JSON.stringify({ session_ids: sessionIds }),
      },
    ),
  quickButtons: (projectId: string) =>
    request<{ buttons: ChatQuickButton[] }>(
      `/chat-sessions/quick-buttons?project_id=${encodeURIComponent(projectId)}`,
    ),
  saveQuickButtons: (projectId: string, buttons: ChatQuickButton[]) =>
    request<{ buttons: ChatQuickButton[] }>(`/chat-sessions/quick-buttons?project_id=${encodeURIComponent(projectId)}`, {
      method: 'PUT',
      body: JSON.stringify({ project_id: projectId, buttons }),
    }),
  getSystemPrompt: (projectId: string) =>
    request<{ prompt: string; default_prompt: string }>(
      `/chat-sessions/system-prompt?project_id=${encodeURIComponent(projectId)}`,
    ),
  saveSystemPrompt: (projectId: string, prompt: string) =>
    request<{ prompt: string }>(`/chat-sessions/system-prompt?project_id=${encodeURIComponent(projectId)}`, {
      method: 'PUT',
      body: JSON.stringify({ project_id: projectId, prompt }),
    }),
  enhancePrompt: (projectId: string, prompt: string) =>
    request<{ prompt: string }>(`/chat-sessions/enhance-prompt?project_id=${encodeURIComponent(projectId)}`, {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId, prompt }),
    }),
}

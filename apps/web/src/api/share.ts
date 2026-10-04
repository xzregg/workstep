import { BASE, FULL_PAGE_LIMIT, fileDataUrl, request, shareRequest } from './transport'
import type { TaskStepState, TaskExecutionReport, TaskArtifact, FilePreview, ReviewRun, DirectoryBrowseResult } from './client'

// --- Public share API (no project context, session-token gated) ---

export interface ShareInfo {
  id: string
  task_id: string
  token: string
  title: string | null
  mode: 'read_only' | 'interactive'
  revoked: boolean
  has_password: boolean
  created_at: string
  revoked_at: string | null
}

export interface ShareMeta {
  token: string
  title: string | null
  mode: 'read_only' | 'interactive'
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
  coordinator_engine?: string | null
  coordinator_model?: string | null
  coordinator_fast_model?: string | null
  run_round?: number
  restart_from_step_key?: string | null
  recovered_at?: string | null
  recovered_count?: number
  state_version?: number
  workflow_id: string | null
  workflow: { id: string; name: string; steps: any } | null
  first_message_at?: string | null
  completed_at?: string | null
  duration_ms?: number | null
  total_tokens?: number | null
  creator_id?: string | null
  creator_name?: string | null
  creator_device_id?: string | null
  creator_device_name?: string | null
  scheduled_start_at?: string | null
  scheduled_start_state?: 'pending' | 'missed' | 'failed' | null
  scheduled_start_error?: string | null
  created_at: string
  updated_at: string
  steps: TaskStepState[]
}

export const shareApi = {
  gitRequest: <T,>(token: string, sessionToken: string, path: string, options?: RequestInit) =>
    shareRequest<T>(path.replace(/^\/git/, `/task-share/public/${encodeURIComponent(token)}/git`), sessionToken, options),
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
  executionReport: (token: string, sessionToken: string) =>
    shareRequest<TaskExecutionReport>(
      `/task-share/public/${encodeURIComponent(token)}/execution-report`,
      sessionToken,
    ),
  history: async (token: string, sessionToken: string, limit = FULL_PAGE_LIMIT, offset = 0) => {
    let messages: any[] = []
    while (messages.length < limit) {
      const pageLimit = Math.min(500, limit - messages.length)
      const page = await shareRequest<{ messages: any[] }>(
        `/task-share/public/${encodeURIComponent(token)}/history?limit=${pageLimit}&offset=${offset + messages.length}`,
        sessionToken,
      )
      // Pages select newest first, but each page is returned chronologically.
      messages = [...page.messages, ...messages]
      if (page.messages.length < pageLimit) break
    }
    return { messages, limit, offset }
  },
  messageEvents: (token: string, sessionToken: string, messageId: string, cursor = 0) =>
    shareRequest<{ events: any[]; complete: boolean; next_cursor: number | null }>(
      `/task-share/public/${encodeURIComponent(token)}/messages/${encodeURIComponent(messageId)}/events?cursor=${cursor}`,
      sessionToken,
    ),
  artifacts: (token: string, sessionToken: string) =>
    shareRequest<{ artifacts: TaskArtifact[]; artifact_directory: string }>(
      `/task-share/public/${encodeURIComponent(token)}/artifacts`,
      sessionToken,
    ),
  previewFile: (token: string, sessionToken: string, path: string) =>
    shareRequest<FilePreview>(
      `/task-share/public/${encodeURIComponent(token)}/file-preview?path=${encodeURIComponent(path)}`,
      sessionToken,
    ),
  browseGitWorkspace: (token: string, sessionToken: string, path: string, includeHidden = false) =>
    shareRequest<DirectoryBrowseResult>(
      `/task-share/public/${encodeURIComponent(token)}/workspace/browse?${new URLSearchParams({ path, ...(includeHidden ? { include_hidden: 'true' } : {}) })}`,
      sessionToken,
    ),
  fileUrl: (token: string, sessionToken: string, path: string) =>
    `${BASE}/task-share/public/${encodeURIComponent(token)}/files/${encodeURIComponent(sessionToken)}/${path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`,
  reviews: (token: string, sessionToken: string) =>
    shareRequest<{ reviews: ReviewRun[] }>(
      `/task-share/public/${encodeURIComponent(token)}/reviews`,
      sessionToken,
    ),
  uploadAttachment: async (
    token: string,
    sessionToken: string,
    file: File,
    prefix = '',
  ) => shareRequest<{ url: string; filename: string; size: number }>(
    `/task-share/public/${encodeURIComponent(token)}/upload/${file.type.startsWith('image/') ? 'image' : 'file'}`,
    sessionToken,
    {
      method: 'POST',
      body: JSON.stringify({
        filename: file.name,
        data_url: await fileDataUrl(file),
        prefix,
      }),
    },
  ),
  resolveAttachmentUrl: (token: string, sessionToken: string, src: string) => {
    const match = src.match(/^(?:[^/]+\/)?\.workstep\/uploads\/([^/?#]+)$/)
    if (!match) return src
    return `${BASE}/task-share/public/${encodeURIComponent(token)}/uploads/${encodeURIComponent(match[1])}?session=${encodeURIComponent(sessionToken)}`
  },
  sendStepMessage: (
    token: string,
    sessionToken: string,
    taskId: string,
    stepKey: string,
    content: string,
  ) =>
    shareRequest<{
      message_id: string
      step_key: string
      status: 'queued'
      sequence?: number
      created_at?: string
    }>(
      `/task-share/public/${encodeURIComponent(token)}/steps/${encodeURIComponent(stepKey)}/message`,
      sessionToken,
      {
        method: 'POST',
        body: JSON.stringify({ task_id: taskId, content }),
      },
    ),
  resumeStep: (
    token: string,
    sessionToken: string,
    stepKey: string,
    content: string,
  ) =>
    shareRequest<{
      message_id: string
      step_key: string
      run_id: string
      status: 'queued'
      sequence?: number
      created_at?: string
    }>(
      `/task-share/public/${encodeURIComponent(token)}/steps/${encodeURIComponent(stepKey)}/resume`,
      sessionToken,
      {
        method: 'POST',
        body: JSON.stringify({ content }),
      },
    ),
  cancelStep: (token: string, sessionToken: string, stepKey: string) =>
    shareRequest<{ cancelled: boolean }>(
      `/task-share/public/${encodeURIComponent(token)}/steps/${encodeURIComponent(stepKey)}/cancel`,
      sessionToken,
      { method: 'POST' },
    ),
  decideReview: (
    token: string,
    sessionToken: string,
    stepKey: string,
    reviewRunId: string,
    decision: 'approve' | 'reject' | 'force-approve' | 'terminate' | 'complete-task',
    comment?: string,
  ) =>
    shareRequest<{ decision: string; resumed: boolean; run_id: string | null }>(
      `/task-share/public/${encodeURIComponent(token)}/steps/${encodeURIComponent(stepKey)}/review/${encodeURIComponent(decision)}`,
      sessionToken,
      {
        method: 'POST',
        body: JSON.stringify({ review_run_id: reviewRunId, comment }),
      },
    ),
  respondInteraction: (
    token: string,
    sessionToken: string,
    interactionId: string,
    data: Record<string, unknown>,
  ) =>
    shareRequest<{ delivered: boolean }>(
      `/task-share/public/${encodeURIComponent(token)}/intervention/respond`,
      sessionToken,
      {
        method: 'POST',
        body: JSON.stringify({ intervention_id: interactionId, data }),
      },
    ),
  buildWsUrl: (sessionToken: string): string => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${window.location.host}/ws/share?session=${encodeURIComponent(sessionToken)}`
  },
}

export type SharedTaskApi = Omit<typeof shareApi, 'buildWsUrl'> & {
  gitWorkspaceEditable?: boolean
  gitAllowedActions?: readonly string[]
  buildWsUrl: (sessionToken: string) => string | null
  restoreSession?: (token: string) => Promise<{ session_token: string }>
}

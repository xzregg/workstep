import { gatewayFetch } from '../utils/gatewayWorkspacePath'
import { ApiError, fileDataUrl, singleFlight } from './transport'
import type { SharedTaskApi } from './share'

const base = (token: string) => `/api/public/shares/${encodeURIComponent(token)}`
const segment = encodeURIComponent
const gitReadPath = (action: string, data: Record<string, string> = {}) => `/git/read/${action}/${
  Array.from(new TextEncoder().encode(JSON.stringify(data)), byte => byte.toString(16).padStart(2, '0')).join('')
}`

async function read<T>(token: string, path: string, csrf = '', options?: RequestInit): Promise<T> {
  const run = async () => {
    const response = await gatewayFetch(base(token) + path, {
      ...options, credentials: 'same-origin', headers: {
        'Content-Type': 'application/json', ...(csrf ? { 'X-Share-CSRF': csrf } : {}),
        ...options?.headers,
      },
    })
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}))
      throw new ApiError(typeof detail.detail === 'string' ? detail.detail : `HTTP ${response.status}`, response.status)
    }
    return response.json() as Promise<T>
  }
  return !options?.method || options.method === 'GET'
    ? singleFlight(`GATEWAY SHARE ${token} ${csrf} ${path}`, run) : run()
}
const post = (body?: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body ?? {}) })

/** Gateway cookies stay server-owned; the session value is solely visitor CSRF. */
export const gatewayShareApi: SharedTaskApi = {
  taskOperation: <T,>(token: string, csrf: string, path: string, options?: RequestInit) =>
    read<T>(token, '/operation', csrf, post({ path, method: options?.method || 'GET',
      body: typeof options?.body === 'string' && options.body ? JSON.parse(options.body) : null,
      idempotency_key: new Headers(options?.headers).get('Idempotency-Key') })),
  confirmAction: (token, csrf, id, key, overwrite = false) => read(token, `/actions/${segment(id)}/confirm`, csrf, post({ idempotency_key: key, overwrite })),
  cancelAction: (token, csrf, id) => read(token, `/actions/${segment(id)}/cancel`, csrf, post()),
  gitWorkspaceEditable: false,
  gitAllowedActions: ['commit', 'switch', 'createBranch', 'deleteBranch', 'fetch', 'pull', 'push'],
  restoreSession: async token => {
    const session = await read<{ csrf_token: string }>(token, '/session')
    return { session_token: session.csrf_token }
  },
  meta: token => read(token, '/meta'),
  unlock: async (token, password) => {
    const session = await read<{ csrf_token: string }>(token, '/unlock', '', post({ password }))
    return { session_token: session.csrf_token }
  },
  task: (token, csrf) => read(token, '/task', csrf),
  executionReport: (token, csrf) => read(token, '/execution-report', csrf),
  history: async (token, csrf, limit = 100, offset = 0) => {
    const page = await read<{ messages: any[]; next_offset: number | null; interventions?: any[] }>(token,
      offset ? `/history/${offset}` : '/history', csrf)
    const messages = [...page.messages, ...(offset ? [] : page.interventions ?? []).map(item => ({
      id: `gateway-interaction:${item.interaction_id}`, role: 'assistant',
      step_key: item.step_key, content: '', channel: 'execution', run_status: 'running',
      created_at: item.request.created_at ?? new Date().toISOString(),
      events: [{ type: 'CUSTOM', name: 'workstep.interaction_request',
        value: { ...item.request, interaction_id: item.interaction_id } }],
    }))]
    return { ...page, messages, limit, offset }
  },
  messageEvents: (token, csrf, message, cursor = 0) => read(token, `/events/${segment(message)}/${cursor}`, csrf),
  artifacts: async (token, csrf) => {
    const result = await read<{ artifacts: any[]; input_snapshots?: any[] }>(token, '/artifacts', csrf)
    return { artifact_directory: '', input_snapshots: result.input_snapshots || [], artifacts: result.artifacts.map(artifact => ({
      ...artifact, path: `artifact:${artifact.id}`, is_dir: Boolean(artifact.is_dir),
    })) }
  },
  previewFile: (token, csrf, path) => {
    if (path.startsWith('workspace:') || /^artifact:[0-9a-f]{64}\//.test(path)) return read(token, gitReadPath('preview', { path }), csrf)
    if (!/^artifact:[0-9a-f]{64}$/.test(path)) return Promise.reject(new Error('文件不在分享范围内'))
    return read(token, `/artifacts/${path.slice(9)}/preview`, csrf)
  },
  fileUrl: (token, _csrf, path) => path.startsWith('workspace:') || /^artifact:[0-9a-f]{64}\//.test(path)
    ? base(token) + gitReadPath('content', { path }) : /^artifact:[0-9a-f]{64}$/.test(path)
    ? `${base(token)}/artifacts/${path.slice(9)}/content` : '',
  browseGitWorkspace: (token, csrf, path, _includeHidden) => read(token, gitReadPath('browse', { path: path || 'workspace:' }), csrf),
  reviews: (token, csrf) => read(token, '/reviews', csrf),
  uploadAttachment: async (token, csrf, file) => read(token, '/uploads', csrf,
    post({ filename: file.name, data_url: await fileDataUrl(file) })),
  resolveAttachmentUrl: (token, _csrf, src) => {
    const match = src.match(/^(?:[^/]+\/)?\.workstep\/uploads\/([^/?#]+)$/)
    return match ? `${base(token)}/uploads/${segment(match[1])}` : src
  },
  sendStepMessage: (token, csrf, _task, step, content) => read(token, `/steps/${segment(step)}/message`, csrf, post({ content })),
  resumeStep: (token, csrf, step, content) => read(token, `/steps/${segment(step)}/resume`, csrf, post({ content })),
  cancelStep: (token, csrf, step) => read(token, `/steps/${segment(step)}/cancel`, csrf, post()),
  decideReview: (token, csrf, step, review, decision, comment) => read(token,
    `/steps/${segment(step)}/review/${segment(decision.replaceAll('-', '_'))}`, csrf,
    post({ review_run_id: review, comment })),
  respondInteraction: (token, csrf, id, data) => read(token, `/interventions/${segment(id)}/respond`, csrf, post({ data })),
  gitRequest: (token, csrf, path, options) => {
    const method = options?.method ?? 'GET'
    if (path === '/git/repositories' && method === 'GET') return read(token, gitReadPath('repositories'), csrf)
    const parsed = new URL(path, 'http://localhost')
    const view = parsed.pathname.match(/^\/git\/worktrees\/([0-9a-f]{24})\/(history|changes|diff|blame|remotes)$/)
    if (view && method === 'GET') {
      const params = Object.fromEntries(parsed.searchParams)
      const allowed: Record<string, string[]> = { history: ['ref', 'offset'], changes: ['ref', 'commit'], diff: ['path', 'ref', 'commit'], blame: ['path', 'ref'], remotes: [] }
      if (Object.keys(params).some(key => !allowed[view[2]].includes(key))) return Promise.reject(new Error('Git 查询不在分享范围内'))
      return read(token, gitReadPath(view[2], { ...params, tree_id: view[1] }), csrf)
    }
    if (/^\/git\/projects\/[^/]+\/tasks\/[^/]+\/workspace$/.test(path)) {
      if (options?.method && options.method !== 'GET') return Promise.reject(new Error('分享不能更改任务工作区'))
      return read(token, '/git/workspace', csrf)
    }
    if (!/^\/git\/worktrees\/[0-9a-f]{24}\/(?:status|branches|branches\/delete|commit|switch|fetch|pull|push)$/.test(path)) {
      return Promise.reject(new Error('Git 请求不在分享范围内'))
    }
    return read(token, path, csrf, options)
  },
  buildWsUrl: (_csrf, token) => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${window.location.host}/ws/public/shares/${encodeURIComponent(token!)}`
  },
}

export const isGatewayPublicShare = () => typeof document !== 'undefined'
  && document.querySelector('meta[name="workstep-share-transport"]')?.getAttribute('content') === 'gateway'

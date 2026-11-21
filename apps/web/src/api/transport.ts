import { workspaceCatalogPath } from './workspaceScope'
import { isGatewayRemoteBrowser } from '../utils/gatewayRemote'
import { gatewayFetch, gatewayWorkspacePath } from '../utils/gatewayWorkspacePath'
/** REST API client for the WorkStep daemon. */

import { browserActorHeaders } from '../utils/browserActor'
import { localizeError, zhCNT } from '../i18n'
import { browserDiagnostics } from '../utils/browserDiagnostics'

export const BASE = gatewayWorkspacePath() + '/api'
/** Default page size for loading full event logs / message histories. */
export const FULL_PAGE_LIMIT = 30000

type TaskShareTransport = <T>(path: string, options?: RequestInit) => Promise<T>
let taskShareTransport: { scope: string; send: TaskShareTransport } | undefined
export function registerTaskShareTransport(scope: string, send: TaskShareTransport) {
  const registration = { scope, send }
  taskShareTransport = registration
  return () => { if (taskShareTransport === registration) taskShareTransport = undefined }
}

export class ApiError extends Error {
  status: number
  rawMessage: string

  constructor(message: string, status: number) {
    super(localizeError(message))
    this.name = 'ApiError'
    this.status = status
    this.rawMessage = message
  }
}

function errorDetailMessage(detail: unknown, status: number, translate = false): string {
  const text = translate ? localizeError : (value: string) => value
  if (typeof detail === 'string' && detail) return text(detail)
  if (Array.isArray(detail)) {
    return detail.map((item) => errorDetailMessage(item, status, translate)).join('; ') || `HTTP ${status}`
  }
  if (detail && typeof detail === 'object' && 'msg' in detail && typeof detail.msg === 'string') {
    if (translate && 'type' in detail && detail.type === 'value_error' && detail.msg.startsWith('Value error, ')) {
      return text(detail.msg.slice('Value error, '.length))
    }
    return detail.msg ? text(detail.msg) : `HTTP ${status}`
  }
  if (detail && typeof detail === 'object' && 'message' in detail && typeof detail.message === 'string') {
    return detail.message ? text(detail.message) : `HTTP ${status}`
  }
  return `HTTP ${status}`
}

function localizeFailure<T>(body: T): T {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  const result = body as Record<string, unknown>
  const failed = result.ok === false || result.saved === false || result.success === false
    || result.status === 'failed' || result.status === 'error'
  if (!failed && typeof result.error !== 'string') return body
  const fields = failed ? ['error', 'message', 'detail'] : ['error']
  return Object.assign({}, result, Object.fromEntries(fields
    .filter((field) => typeof result[field] === 'string')
    .map((field) => [field, localizeError(result[field] as string)]))) as T
}

async function readApiResponse<T>(res: Response, path: string): Promise<T> {
  if (res.headers.get('Content-Type')?.toLowerCase().includes('text/html')) {
    throw new ApiError(zhCNT('api.htmlResponse', { path: `${BASE}${path.split('?')[0]}` }), res.status)
  }
  if (!res.ok) {
    const result = await res.json().catch(() => ({ detail: res.statusText }))
    const detail = result?.detail ?? result?.error
    const error = new ApiError(errorDetailMessage(detail, res.status), res.status)
    if (detail && typeof detail === 'object') error.message = errorDetailMessage(detail, res.status, true)
    throw error
  }
  return localizeFailure(await res.json() as T)
}

export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  if (typeof window !== 'undefined' && window.location.pathname.startsWith('/share/')
    && !path.startsWith('/task-share/public/')) {
    if (!taskShareTransport) throw new ApiError('Share task transport is not available', 403)
    const { scope, send } = taskShareTransport
    return (options?.method || 'GET').toUpperCase() === 'GET' && !options?.signal
      ? singleFlight(`TASK SHARE ${scope} ${path}`, () => send<T>(path, options)) : send<T>(path, options)
  }
  if (isGatewayRemoteBrowser() && options?.body && typeof options.body === 'string') {
    let projectId = ''
    try { projectId = JSON.parse(options.body)?.project_id ?? '' } catch { /* Multipart/text is not a project body. */ }
    if (typeof projectId === 'string' && projectId) path = await workspaceCatalogPath(path, projectId)
  }
  if (isGatewayRemoteBrowser()) {
    const pathProject = path.match(/^\/(?:projects|skills\/projects|git\/projects)\/([^/?]+)/)?.[1]
    if (pathProject) path = await workspaceCatalogPath(path, decodeURIComponent(pathProject))
    else if (path === '/schedule/preview') path = await workspaceCatalogPath(path)
  }
  const run = async () => {
    try {
      const res = await gatewayFetch(`${BASE}${path}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...browserActorHeaders(),
          ...(options?.headers || {}),
        },
      })
      return await readApiResponse<T>(res, path)
    } catch (error) {
      if (!options?.signal?.aborted && !(error instanceof Error && error.name === 'AbortError')) {
        browserDiagnostics.recordRequestFailure(path, (options?.method || 'GET').toUpperCase(), error instanceof ApiError ? error.status : undefined, error)
      }
      throw error
    }
  }

  const method = (options?.method || 'GET').toUpperCase()
  return method === 'GET' && !options?.signal ? singleFlight(`GET ${path}`, run) : run()
}

// Dedupe concurrent reads without a caller-owned cancellation signal.
const inFlightReads = new Map<string, Promise<unknown>>()
export function singleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const pending = inFlightReads.get(key)
  if (pending) return pending as Promise<T>
  const promise = run().finally(() => {
    if (inFlightReads.get(key) === promise) inFlightReads.delete(key)
  })
  inFlightReads.set(key, promise)
  return promise
}

export async function fileDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export async function shareRequest<T>(
  path: string,
  sessionToken: string,
  options?: RequestInit,
): Promise<T> {
  const run = async () => {
    try {
      const res = await gatewayFetch(`${BASE}${path}`, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          'X-Share-Session': sessionToken,
          ...browserActorHeaders(),
          ...(options?.headers || {}),
        },
      })
      return await readApiResponse<T>(res, path)
    } catch (error) {
      if (!options?.signal?.aborted && !(error instanceof Error && error.name === 'AbortError')) {
        browserDiagnostics.recordRequestFailure(path, (options?.method || 'GET').toUpperCase(), error instanceof ApiError ? error.status : undefined, error)
      }
      throw error
    }
  }

  const method = (options?.method || 'GET').toUpperCase()
  return method === 'GET'
    ? singleFlight(`SHARE GET ${sessionToken} ${path}`, run)
    : run()
}

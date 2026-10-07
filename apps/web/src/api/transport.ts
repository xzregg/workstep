/** REST API client for the WorkStep daemon. */

import { browserActorHeaders } from '../utils/browserActor'
import { zhCNT } from '../i18n'

export const BASE = '/api'
/** Default page size for loading full event logs / message histories. */
export const FULL_PAGE_LIMIT = 30000

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

function errorDetailMessage(detail: unknown, status: number): string {
  if (typeof detail === 'string' && detail) return detail
  if (Array.isArray(detail)) {
    return detail.map((item) => errorDetailMessage(item, status)).join('; ') || `HTTP ${status}`
  }
  if (detail && typeof detail === 'object' && 'msg' in detail && typeof detail.msg === 'string') {
    return detail.msg || `HTTP ${status}`
  }
  return `HTTP ${status}`
}

async function readApiResponse<T>(res: Response, path: string): Promise<T> {
  if (res.headers.get('Content-Type')?.toLowerCase().includes('text/html')) {
    throw new ApiError(zhCNT('api.htmlResponse', { path: `${BASE}${path.split('?')[0]}` }), res.status)
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ detail: res.statusText }))
    throw new ApiError(errorDetailMessage(detail.detail, res.status), res.status)
  }
  return res.json() as Promise<T>
}

export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const run = async () => {
    const res = await fetch(`${BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...browserActorHeaders(),
        ...(options?.headers || {}),
      },
    })
    return readApiResponse<T>(res, path)
  }

  const method = (options?.method || 'GET').toUpperCase()
  return method === 'GET' ? singleFlight(`GET ${path}`, run) : run()
}

// Dedupe concurrent in-flight reads: React StrictMode double-mounts effects in
// dev, so mount-time fetches would otherwise fire twice (first result discarded).
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
    const res = await fetch(`${BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Share-Session': sessionToken,
        ...browserActorHeaders(),
        ...(options?.headers || {}),
      },
    })
    return readApiResponse<T>(res, path)
  }

  const method = (options?.method || 'GET').toUpperCase()
  return method === 'GET'
    ? singleFlight(`SHARE GET ${sessionToken} ${path}`, run)
    : run()
}

import { useEffect, useState } from 'react'

export const invitationTokenPattern = /^[A-Za-z0-9_-]{43}$/

export function useInvitationSession() {
  const [session, setSession] = useState<{ csrf_token: string } | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'login' | 'error'>('loading')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')
    void fetch('/api/auth/session', { signal: controller.signal }).then(async response => {
      if (response.status === 401) { if (!controller.signal.aborted) setStatus('login'); return }
      if (!response.ok) throw Error('会话加载失败。')
      const data = await response.json()
      if (!controller.signal.aborted) { setSession(data); setStatus('ready') }
    }).catch(reason => { if (reason?.name !== 'AbortError') setStatus('error') })
    return () => controller.abort()
  }, [revision])
  return { session, status, retry: () => setRevision(value => value + 1) }
}

export async function invitationResponse(response: Response) {
  if (response.ok) return response.status === 204 ? {} : response.json()
  let message = ''
  try { message = (await response.json()).error?.message ?? '' } catch { /* Status fallback. */ }
  const messages: Record<string, string> = {
    'Only the device owner can invite project users': '只有设备主人可以生成项目邀请。',
    'Project invitations disabled by administrator': '管理员已禁止通过邀请加入这个项目。',
    'Project authorization revoked; administrator approval required': '你的项目授权已撤销，需要管理员重新授权。',
    'Project invitation owner changed': '设备主人已变更，请重新获取项目邀请。',
    'Account unavailable': '账号当前不可用，请联系管理员处理账号状态。',
  }
  throw Error(messages[message] ?? ({
    401: '登录已失效，请重新登录。', 403: '没有权限执行此操作。',
    404: '项目或邀请不存在，项目可能已取消发布。',
    410: '邀请已暂停、撤销或过期，请联系分享者。', 409: '当前状态不允许此操作。',
    422: '请检查访问级别和过期时间，过期时间必须晚于当前时间。',
  } as Record<number, string>)[response.status] ?? '网关暂时不可用，请重试。')
}

export function invitationHeaders(csrf: string) {
  return { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
}

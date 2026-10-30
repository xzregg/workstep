import { useEffect, useState } from 'react'

/** Keep session failures independent from list errors so refreshing data cannot hide them. */
export function useAdminSession() {
  const [csrf, setCsrf] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(''); setCsrf('')
    void fetch('/api/auth/session', { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(response.status === 401
          ? '登录状态已失效，请重新登录。' : '登录状态加载失败，请重试。')
        const data = await response.json()
        if (!data.csrf_token) throw new Error('登录状态加载失败，请重试。')
        if (!controller.signal.aborted) setCsrf(data.csrf_token)
      }).catch(reason => {
        if (!controller.signal.aborted) setError(reason instanceof Error && reason.message.startsWith('登录状态')
          ? reason.message : '登录状态加载失败，请重试。')
      }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [revision])
  return { csrf, loading, error, retry: () => setRevision(value => value + 1) }
}

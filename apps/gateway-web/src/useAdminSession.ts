import { useEffect, useState } from 'react'

export const expiredSessionMessage = 'Your session has expired. Sign in again.'
const sessionLoadError = 'Could not load your session. Try again.'

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
          ? expiredSessionMessage : sessionLoadError)
        const data = await response.json()
        if (!data.csrf_token) throw new Error(sessionLoadError)
        if (!controller.signal.aborted) setCsrf(data.csrf_token)
      }).catch(reason => {
        if (!controller.signal.aborted) setError(reason instanceof Error && reason.message === expiredSessionMessage
          ? expiredSessionMessage : sessionLoadError)
      }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [revision])
  return { csrf, loading, error, retry: () => setRevision(value => value + 1) }
}

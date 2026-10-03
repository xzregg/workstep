import { useEffect, useState } from 'react'
import { AdminProviderAssignments } from './AdminProviderAssignments'

type ProviderChoice = { id: string; name: string; enabled: boolean }

export function AdminScopedProviderAssignmentsPage() {
  const [providers, setProviders] = useState<ProviderChoice[]>([])
  const [providerId, setProviderId] = useState('')
  const [csrf, setCsrf] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    void Promise.all(['/api/auth/session', '/api/admin/providers/assignment-catalog'].map(async path => {
      const response = await fetch(path, { credentials: 'same-origin', signal: controller.signal })
      if (!response.ok) throw new Error('供应商目录加载失败')
      return response.json()
    })).then(([session, catalog]) => {
      if (controller.signal.aborted) return
      setCsrf(session.csrf_token); setProviders(catalog.providers)
      setProviderId(current => catalog.providers.some((row: ProviderChoice) => row.id === current)
        ? current : catalog.providers[0]?.id ?? '')
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason.message)
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [revision])
  const provider = providers.find(row => row.id === providerId)
  return <section className="gateway-admin-page">
    <h2>供应商分配</h2>
    {loading && <p role="status"><span className="gateway-spinner" aria-hidden="true" />正在加载供应商…</p>}
    {error && <p role="alert">{error}<button type="button" onClick={() => setRevision(value => value + 1)}>重试</button></p>}
    <label htmlFor="scoped-provider-choice">供应商</label>
    <select id="scoped-provider-choice" value={providerId} disabled={loading}
      onChange={event => setProviderId(event.target.value)}>
      {providers.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
    </select>
    {provider && csrf && !loading && !error && <AdminProviderAssignments key={provider.id}
      providerId={provider.id} enabled={provider.enabled} csrf={csrf} onChanged={() => {}} />}
  </section>
}

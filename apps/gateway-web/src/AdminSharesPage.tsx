import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

type Share = {
  id: string; title: string; created_by: string; device_name: string
  project_name: string; task_id: string; mode: string; visit_count: number
  last_seen_at: string | null; created_at: string; expires_at: string | null
  status: 'active' | 'paused' | 'revoked' | 'expired'
}
type Listing = { total: number; shares: Share[] }
const statusLabel = { active: '有效', paused: '已暂停', revoked: '已撤销', expired: '已过期' }

export function AdminSharesPage() {
  const [csrfToken, setCsrfToken] = useState('')
  const [listing, setListing] = useState<Listing | null>(null)
  const [status, setStatus] = useState('')
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [revokeTarget, setRevokeTarget] = useState<Share | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/auth/session', { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('管理员会话已失效。')
        const data: { csrf_token: string } = await response.json()
        if (!controller.signal.aborted) setCsrfToken(data.csrf_token)
      }).catch(reason => { if (reason?.name !== 'AbortError') setError('管理员会话已失效。') })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    const params = new URLSearchParams({ offset: String(offset), limit: '20' })
    if (status) params.set('status', status)
    if (submittedQuery) params.set('q', submittedQuery)
    void fetch(`/api/admin/shares?${params}`, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('分享列表加载失败。')
        const data: Listing = await response.json()
        if (!controller.signal.aborted) setListing(data)
      }).catch(reason => {
        if (reason?.name !== 'AbortError') setError('分享列表加载失败。')
      }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [status, submittedQuery, offset, revision])

  async function change(share: Share, action: 'pause' | 'resume' | 'revoke') {
    if (busy || !csrfToken) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/admin/shares/${encodeURIComponent(share.id)}/${action}`, {
        method: 'POST', headers: { 'X-CSRF-Token': csrfToken },
      })
      if (!response.ok) throw new Error('分享状态更新失败。')
      setRevokeTarget(null)
      setRevision(value => value + 1)
    } catch { setError('分享状态更新失败。') }
    finally { setBusy(false) }
  }

  return <section className="gateway-admin-page">
    <span className="gateway-auth-eyebrow">WORKSTEP GATEWAY · ADMIN</span>
    <div className="gateway-admin-toolbar"><h2>平台分享管理</h2><Link to="/admin">返回管理概览</Link></div>
    <form className="gateway-share-filters" onSubmit={event => {
      event.preventDefault(); setOffset(0); setSubmittedQuery(query.trim())
    }}>
      <label htmlFor="gateway-share-status">分享状态</label>
      <select id="gateway-share-status" value={status} onChange={event => {
        setStatus(event.target.value); setOffset(0)
      }}>
        <option value="">全部状态</option><option value="active">有效</option>
        <option value="paused">已暂停</option><option value="expired">已过期</option>
        <option value="revoked">已撤销</option>
      </select>
      <label htmlFor="gateway-share-search">分享标题</label>
      <input id="gateway-share-search" value={query} onChange={event => setQuery(event.target.value)} />
      <button type="submit">搜索</button>
    </form>
    {error && <p className="gateway-auth-error" role="alert">{error} <button type="button"
      onClick={() => setRevision(value => value + 1)}>重试</button></p>}
    {loading && <p role="status">正在加载分享…</p>}
    {!loading && listing && <>
      <p>共 {listing.total} 个分享</p>
      {listing.shares.length === 0 ? <p>没有符合条件的分享。</p> : <ul className="gateway-share-admin-list">
        {listing.shares.map(share => <li key={share.id}>
          <div className="gateway-share-admin-info">
            <strong>{share.title || share.task_id}</strong>
            <span>{statusLabel[share.status]} · {share.mode === 'interactive' ? '互动' : '只读'} · {share.visit_count} 次访问</span>
            <span>{share.created_by} · {share.device_name} / {share.project_name} · 任务 {share.task_id}</span>
            <span>创建 {new Date(share.created_at).toLocaleString()} · 最后访问 {
              share.last_seen_at ? new Date(share.last_seen_at).toLocaleString() : '暂无'} · 过期 {
              share.expires_at ? new Date(share.expires_at).toLocaleString() : '未设置'}</span>
          </div>
          <div className="gateway-share-admin-actions">
            {share.status === 'active' && <button type="button" disabled={busy}
              onClick={() => void change(share, 'pause')}>暂停</button>}
            {share.status === 'paused' && <button type="button" disabled={busy}
              onClick={() => void change(share, 'resume')}>恢复</button>}
            {share.status !== 'revoked' && <button type="button" disabled={busy}
              onClick={() => setRevokeTarget(share)}>撤销</button>}
          </div>
        </li>)}
      </ul>}
      <div className="gateway-share-pagination">
        <button type="button" disabled={offset === 0 || loading}
          onClick={() => setOffset(value => Math.max(0, value - 20))}>上一页</button>
        <button type="button" disabled={offset + 20 >= listing.total || loading}
          onClick={() => setOffset(value => value + 20)}>下一页</button>
      </div>
    </>}
    {revokeTarget && <GatewayConfirmDialog title="确认撤销分享"
      message={`撤销「${revokeTarget.title || revokeTarget.task_id}」后访客将无法访问。`}
      confirmLabel="确认撤销" busy={busy}
      onConfirm={() => void change(revokeTarget, 'revoke')}
      onCancel={() => setRevokeTarget(null)} />}
  </section>
}

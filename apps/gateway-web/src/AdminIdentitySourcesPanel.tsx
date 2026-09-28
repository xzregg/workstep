import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

type Source = { id: string; provider: string; tenant_id: string; client_id: string;
  enabled: boolean; callback_configured: boolean; created_at: string }

function ReconcileDialog({ source, csrf, onComplete, onClose }: {
  source: Source; csrf: string; onComplete: () => void; onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function confirm() {
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/admin/identity-sources/${encodeURIComponent(source.id)}/reconcile`, {
        method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf },
      })
      if (!response.ok) throw new Error(response.status === 502 ? '身份源暂不可用，请稍后重试。' : '同步失败，请重试。')
      onComplete()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '同步失败。') }
    finally { setBusy(false) }
  }
  return <GatewayConfirmDialog title="手动对账" message={`从 ${source.provider} · ${source.tenant_id} 重新读取完整目录？`}
    confirmLabel="开始对账" busy={busy} onConfirm={() => void confirm()} onCancel={onClose}>
    <p>同步会更新部门和成员；第三方已删除的条目将标记为已删除。</p>
    {error && <p className="gateway-auth-error" role="alert">{error}</p>}
  </GatewayConfirmDialog>
}

export function AdminIdentitySourcesPanel({ onSourceChange, onReconciled }: {
  onSourceChange: (sourceId: string) => void; onReconciled: () => void
}) {
  const [csrf, setCsrf] = useState('')
  const [sources, setSources] = useState<Source[]>([])
  const [total, setTotal] = useState(0)
  const [qDraft, setQDraft] = useState('')
  const [filters, setFilters] = useState({ q: '', provider: '', status: '', page: 1, sort: 'created_at', direction: 'desc' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [authError, setAuthError] = useState('')
  const [revision, setRevision] = useState(0)
  const [reconcile, setReconcile] = useState<Source | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/auth/session', { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('无法加载操作凭据。')
        const session = await response.json()
        if (!controller.signal.aborted) setCsrf(session.csrf_token)
      }).catch(reason => { if (reason?.name !== 'AbortError') setAuthError('无法加载操作凭据。') })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({ sort: filters.sort, direction: filters.direction,
      page: String(filters.page), page_size: '25' })
    if (filters.q) params.set('q', filters.q)
    if (filters.provider) params.set('provider', filters.provider)
    if (filters.status) params.set('status', filters.status)
    setLoading(true); setError('')
    void fetch(`/api/admin/identity-sources?${params}`, { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('身份源加载失败。')
        const data = await response.json()
        if (!controller.signal.aborted) { setSources(data.sources ?? []); setTotal(data.total ?? 0) }
      }).catch(reason => {
        if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '身份源加载失败。')
      }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [filters, revision])

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setFilters(current => ({ ...current, q: qDraft.trim(), page: 1 }))
  }

  return <section className="gateway-org-sources">
    <h3>企业身份源</h3>
    <form className="gateway-admin-search" onSubmit={search}>
      <label htmlFor="org-source-search">搜索身份源</label>
      <input id="org-source-search" value={qDraft} onChange={event => setQDraft(event.target.value)}
        placeholder="租户或应用 ID" /><button type="submit">搜索</button>
    </form>
    <div className="gateway-admin-filters">
      <select aria-label="身份源类型" value={filters.provider} onChange={event => setFilters(current => (
        { ...current, provider: event.target.value, page: 1 }))}>
        <option value="">全部类型</option><option value="dingtalk">钉钉</option><option value="wecom">企业微信</option>
      </select>
      <select aria-label="身份源状态" value={filters.status} onChange={event => setFilters(current => (
        { ...current, status: event.target.value, page: 1 }))}>
        <option value="">全部状态</option><option value="enabled">已启用</option><option value="disabled">已停用</option>
      </select>
      <select aria-label="身份源排序" value={filters.sort} onChange={event => setFilters(current => (
        { ...current, sort: event.target.value, page: 1 }))}>
        <option value="created_at">创建时间</option><option value="tenant_id">租户 ID</option>
      </select>
      <select aria-label="身份源排序方向" value={filters.direction} onChange={event => setFilters(current => (
        { ...current, direction: event.target.value, page: 1 }))}>
        <option value="desc">降序</option><option value="asc">升序</option>
      </select>
    </div>
    {loading && <p role="status">正在加载身份源…</p>}
    {authError && <p role="alert" className="gateway-auth-error">{authError}</p>}
    {error && <p role="alert" className="gateway-auth-error">{error} <button type="button"
      onClick={() => setRevision(value => value + 1)}>重试</button></p>}
    {!loading && !error && sources.length === 0 && <p>没有符合条件的身份源。</p>}
    {!loading && !error && <ul className="gateway-device-list">{sources.map(source => <li key={source.id}>
      <div><strong>{source.provider === 'wecom' ? '企业微信' : '钉钉'} · {source.tenant_id}</strong>
        <p>{source.enabled ? '已启用' : '已停用'} · {source.callback_configured ? '已配置回调' : '未配置回调'}</p></div>
      <div className="gateway-device-actions"><button type="button" onClick={() => onSourceChange(source.id)}>查看目录</button>
        {source.enabled && <button type="button" disabled={!csrf} onClick={() => setReconcile(source)}>手动对账</button>}</div>
    </li>)}</ul>}
    <div className="gateway-admin-pagination"><span>共 {total} 个身份源 · 第 {filters.page}/{Math.max(1, Math.ceil(total / 25))} 页</span>
      <button type="button" disabled={filters.page <= 1 || loading} onClick={() => setFilters(current => (
        { ...current, page: current.page - 1 }))}>上一页</button>
      <button type="button" disabled={filters.page >= Math.ceil(total / 25) || loading} onClick={() => setFilters(current => (
        { ...current, page: current.page + 1 }))}>下一页</button>
    </div>
    {reconcile && <ReconcileDialog source={reconcile} csrf={csrf} onClose={() => setReconcile(null)}
      onComplete={() => { setReconcile(null); setRevision(value => value + 1); onReconciled() }} />}
  </section>
}

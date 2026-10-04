import { AdminRecordTable, AdminRecordRow } from './AdminRecordTable'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AdminProviderApplications } from './AdminProviderApplications'
import { AdminProviderAssignments } from './AdminProviderAssignments'
import { AdminProviderTestPanel } from './AdminProviderTestPanel'
import { AdminProviderDisableDialog, AdminProviderEditorDialog } from './AdminProviderEditorDialog'
import type { ManagedProvider } from './AdminProviderEditorDialog'

type Provider = ManagedProvider & { model_count: number; price_version: string | null;
  assignment_users: number; assignment_devices: number; target_devices: number;
  application: { applied: number; pending: number; failed: number; offline: number } }
type Filters = { q: string; enabled: string; sort: string; direction: string; page: number }

export function AdminProvidersPage() {
  const [csrf, setCsrf] = useState('')
  const [providers, setProviders] = useState<Provider[]>([])
  const [total, setTotal] = useState(0)
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<Filters>({ q: '', enabled: '', sort: 'name',
    direction: 'asc', page: 1 })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [showApplications, setShowApplications] = useState(false)
  const [edit, setEdit] = useState<Provider | 'new' | null>(null)
  const [disable, setDisable] = useState<Provider | null>(null)
  const [assignmentsFor, setAssignmentsFor] = useState<Provider | null>(null)
  const [testFor, setTestFor] = useState<Provider | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/auth/session', { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('登录状态已失效，请重新登录。')
        const data = await response.json()
        if (!controller.signal.aborted) setCsrf(data.csrf_token)
      }).catch(reason => {
        if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '登录状态加载失败。')
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({ q: filters.q, sort: filters.sort,
      direction: filters.direction, page: String(filters.page), page_size: '25' })
    if (filters.enabled) params.set('enabled', filters.enabled)
    setLoading(true); setError('')
    void fetch(`/api/admin/providers?${params}`, { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(response.status === 403
          ? '当前账号没有供应商管理权限。' : '供应商列表加载失败。')
        const data = await response.json()
        if (!controller.signal.aborted) { setProviders(data.providers ?? []); setTotal(data.total ?? 0) }
      }).catch(reason => {
        if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '供应商列表加载失败。')
      }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [filters, revision])

  return <section className="gateway-admin-page">
    <span className="gateway-auth-eyebrow">WORKSTEP 平台 · ADMIN</span>
    <div className="gateway-admin-toolbar"><h2>供应商管理</h2><Link to="/admin">返回管理概览</Link></div>
    <p>供应商密钥只在创建和轮换时提交；列表不返回密钥。</p>
    {csrf && <button type="button" onClick={() => setEdit('new')}>创建供应商</button>}
    <form className="gateway-admin-search" onSubmit={event => {
      event.preventDefault(); setFilters(current => ({ ...current, q: query.trim(), page: 1 }))
    }}><label htmlFor="provider-search">搜索名称或类型</label>
      <input id="provider-search" value={query} onChange={event => setQuery(event.target.value)} />
      <button type="submit">搜索</button></form>
    <div className="gateway-admin-filters"><label htmlFor="provider-enabled">状态</label>
      <select id="provider-enabled" value={filters.enabled} onChange={event => setFilters(current => (
        { ...current, enabled: event.target.value, page: 1 }))}>
        <option value="">全部</option><option value="true">已启用</option><option value="false">已停用</option>
      </select>
      <label htmlFor="provider-sort">排序</label>
      <select id="provider-sort" value={filters.sort} onChange={event => setFilters(current => (
        { ...current, sort: event.target.value, page: 1 }))}>
        <option value="name">名称</option><option value="created_at">创建时间</option></select>
      <select aria-label="供应商排序方向" value={filters.direction} onChange={event => setFilters(current => (
        { ...current, direction: event.target.value, page: 1 }))}>
        <option value="asc">升序</option><option value="desc">降序</option></select>
    </div>
    {loading && <p role="status">正在加载供应商…</p>}
    {error && <p role="alert" className="gateway-auth-error">{error} <button type="button"
      onClick={() => setRevision(value => value + 1)}>重试</button></p>}
    {!loading && !error && providers.length === 0 && <p>当前条件下没有供应商。</p>}
    <AdminRecordTable>{providers.map(provider => <AdminRecordRow key={provider.id}>
      <div><strong>{provider.name}</strong><p>{provider.type} · {provider.protocols.join('、')} · {
        provider.enabled ? '已启用' : '已停用'} · 配置版本 {provider.revision}</p>
        <p>{provider.model_count} 个模型 · 价格版本 {provider.price_version ?? '未设置'} · 用户授权 {
          provider.assignment_users} · PC 授权 {provider.assignment_devices}</p>
        <p>目标 PC {provider.target_devices} 台 · 已应用 {provider.application.applied} · 等待同步 {
          provider.application.pending} · 失败 {provider.application.failed} · 离线 {
          provider.application.offline}</p></div>
        {csrf && <div className="gateway-device-actions"><button type="button"
          onClick={() => setEdit(provider)}>编辑 / 轮换凭据</button>
          <button type="button" onClick={() => setAssignmentsFor(provider)}>管理分配</button>
          {provider.enabled && <button type="button" onClick={() => setTestFor(provider)}>测试连接</button>}
          {provider.enabled && <button type="button" onClick={() => setDisable(provider)}>停用</button>}</div>}
    </AdminRecordRow>)}</AdminRecordTable>
    <div className="gateway-admin-pagination"><span>共 {total} 个供应商 · 第 {filters.page}/{
      Math.max(1, Math.ceil(total / 25))} 页</span>
      <button type="button" disabled={filters.page <= 1 || loading}
        onClick={() => setFilters(current => ({ ...current, page: current.page - 1 }))}>上一页</button>
      <button type="button" disabled={filters.page >= Math.ceil(total / 25) || loading}
        onClick={() => setFilters(current => ({ ...current, page: current.page + 1 }))}>下一页</button></div>
    <button type="button" onClick={() => setShowApplications(value => !value)}>{
      showApplications ? '收起 PC 应用状态' : '查看 PC 应用状态'}</button>
    {showApplications && <AdminProviderApplications />}
    {assignmentsFor && csrf && <AdminProviderAssignments key={assignmentsFor.id}
      providerId={assignmentsFor.id} enabled={assignmentsFor.enabled} csrf={csrf}
      onChanged={() => setRevision(value => value + 1)} />}
    {testFor && csrf && <AdminProviderTestPanel key={testFor.id} providerId={testFor.id}
      providerName={testFor.name} csrf={csrf} onClose={() => setTestFor(null)} />}
    {edit && csrf && <AdminProviderEditorDialog key={edit === 'new' ? 'new' : edit.id}
      provider={edit === 'new' ? undefined : edit} csrf={csrf} onClose={() => setEdit(null)}
      onSaved={() => { setEdit(null); setRevision(value => value + 1) }} />}
    {disable && csrf && <AdminProviderDisableDialog provider={disable} csrf={csrf}
      onClose={() => setDisable(null)} onSaved={() => {
        if (assignmentsFor?.id === disable.id) setAssignmentsFor(null)
        setDisable(null); setRevision(value => value + 1)
      }} />}
  </section>
}

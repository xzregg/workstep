import { useEffect, useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

type Assignment = { id: string; subject_type: 'user' | 'device'; subject_id: string;
  subject_name: string | null }
type Target = { id: string; name?: string; display_name?: string; username?: string }

function AssignmentActionDialog({ providerId, csrf, assignment, onClose, onSaved }: {
  providerId: string; csrf: string; assignment?: Assignment; onClose: () => void; onSaved: () => void
}) {
  const [kind, setKind] = useState<'user' | 'device'>('user')
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [targets, setTargets] = useState<Target[]>([])
  const [targetId, setTargetId] = useState('')
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [discard, setDiscard] = useState(false)

  useEffect(() => {
    if (assignment) return
    const controller = new AbortController()
    const params = new URLSearchParams({ q: search, status: 'active',
      sort: kind === 'user' ? 'username' : 'name',
      direction: 'asc', page: String(page), page_size: '25' })
    setLoading(true); setError('')
    void fetch(`/api/admin/${kind === 'user' ? 'users' : 'devices'}?${params}`, {
      credentials: 'same-origin', signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error('授权对象加载失败。')
      const data = await response.json()
      if (!controller.signal.aborted) {
        setTargets(kind === 'user' ? data.users ?? [] : data.devices ?? [])
        setTotal(data.total ?? 0)
      }
    }).catch(reason => {
      if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '授权对象加载失败。')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [assignment, kind, search, page, revision])

  const dirty = !!(targetId || query || password || kind !== 'user')
  async function submit() {
    setBusy(true); setError('')
    try {
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
      const step = await fetch('/api/auth/step-up', { method: 'POST', credentials: 'same-origin', headers,
        body: JSON.stringify({ password }) })
      if (!step.ok) throw new Error('密码验证失败。')
      const subject_type = assignment?.subject_type ?? kind
      const subject_id = assignment?.subject_id ?? targetId
      const response = await fetch(`/api/admin/providers/${encodeURIComponent(providerId)}/${
        assignment ? 'assign/revoke' : 'assign'}`, {
        method: 'POST', credentials: 'same-origin', headers,
        body: JSON.stringify({ subject_type, subject_id }),
      })
      if (!response.ok) throw new Error('供应商授权操作失败，请检查对象状态。')
      onSaved()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '供应商授权操作失败。') }
    finally { setBusy(false) }
  }

  return <>
    <GatewayConfirmDialog title={assignment ? '撤销供应商授权' : '分配供应商'}
      message={assignment ? `撤销 ${assignment.subject_name ?? assignment.subject_id} 的供应商使用权。`
        : '仅向选定用户或 PC 分配该供应商；设备配置会按新的版本同步。'}
      confirmLabel={assignment ? '撤销授权' : '确认分配'} busy={busy}
      disabled={!password || (!assignment && (!targetId || loading))}
      onConfirm={() => void submit()}
      onCancel={() => assignment || !dirty ? onClose() : setDiscard(true)}>
      {!assignment && <>
        <label htmlFor="provider-assignment-kind">对象类型</label>
        <select id="provider-assignment-kind" value={kind} onChange={event => {
          setKind(event.target.value as 'user' | 'device'); setTargetId(''); setSearch(''); setQuery(''); setPage(1)
        }}><option value="user">用户</option><option value="device">PC</option></select>
        <form className="gateway-admin-search" onSubmit={event => {
          event.preventDefault(); setTargetId(''); setPage(1); setSearch(query.trim())
        }}><label htmlFor="provider-assignment-search">搜索对象</label>
          <input id="provider-assignment-search" value={query} onChange={event => setQuery(event.target.value)} />
          <button type="submit">搜索</button></form>
        <label htmlFor="provider-assignment-target">授权对象</label>
        <select id="provider-assignment-target" value={targetId} onChange={event => setTargetId(event.target.value)}>
          <option value="">请选择</option>{targets.map(target => <option key={target.id} value={target.id}>{
            kind === 'user' ? `${target.display_name ?? target.username ?? target.id}（${target.username ?? target.id}）`
              : target.name ?? target.id}</option>)}</select>
        <div className="gateway-admin-pagination"><span>共 {total} 个对象 · 第 {page}/{
          Math.max(1, Math.ceil(total / 25))} 页</span>
          <button type="button" disabled={page <= 1 || loading} onClick={() => {
            setTargetId(''); setPage(value => value - 1)
          }}>上一页</button>
          <button type="button" disabled={page >= Math.ceil(total / 25) || loading}
            onClick={() => { setTargetId(''); setPage(value => value + 1) }}>下一页</button></div>
        {loading && <p role="status">正在加载对象…</p>}
      </>}
      <label htmlFor="provider-assignment-password">输入管理员密码确认</label>
      <input id="provider-assignment-password" type="password" autoComplete="current-password"
        value={password} onChange={event => setPassword(event.target.value)} />
      {error && <p role="alert" className="gateway-auth-error">{error} {!assignment &&
        <button type="button" onClick={() => setRevision(value => value + 1)}>重试加载</button>}</p>}
    </GatewayConfirmDialog>
    {discard && <GatewayConfirmDialog title="放弃供应商授权修改" message="当前授权选择有未保存内容。"
      confirmLabel="放弃并关闭" onConfirm={onClose} onCancel={() => setDiscard(false)} />}
  </>
}

export function AdminProviderAssignments({ providerId, enabled, csrf, onChanged }: {
  providerId: string; enabled: boolean; csrf: string; onChanged: () => void
}) {
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [total, setTotal] = useState(0)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [edit, setEdit] = useState<'new' | Assignment | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({ q: search, page: String(page), page_size: '25' })
    setLoading(true); setError('')
    void fetch(`/api/admin/providers/${encodeURIComponent(providerId)}/assignments?${params}`, {
      credentials: 'same-origin', signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error('供应商授权加载失败。')
      const data = await response.json()
      if (!controller.signal.aborted) { setAssignments(data.assignments ?? []); setTotal(data.total ?? 0) }
    }).catch(reason => {
      if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '供应商授权加载失败。')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [providerId, search, page, revision])

  function saved() { setEdit(null); setRevision(value => value + 1); onChanged() }
  return <section className="gateway-project-grants">
    <div className="gateway-admin-toolbar"><h3>用户与 PC 授权</h3>
      <button type="button" disabled={!enabled} onClick={() => setEdit('new')}>新增分配</button></div>
    <form className="gateway-admin-search" onSubmit={event => {
      event.preventDefault(); setPage(1); setSearch(query.trim())
    }}><label htmlFor="provider-assignment-list-search">搜索授权</label>
      <input id="provider-assignment-list-search" value={query}
        onChange={event => setQuery(event.target.value)} />
      <button type="submit">搜索</button></form>
    {loading && <p role="status">正在加载授权…</p>}
    {error && <p role="alert" className="gateway-auth-error">{error} <button type="button"
      onClick={() => setRevision(value => value + 1)}>重试</button></p>}
    {!loading && !error && assignments.length === 0 && <p>当前条件下没有授权。</p>}
    <ul className="gateway-device-list">{assignments.map(assignment => <li key={assignment.id}>
      <div><strong>{assignment.subject_name ?? assignment.subject_id}</strong><p>{
        assignment.subject_type === 'user' ? '用户' : 'PC'}</p></div>
      <button type="button" onClick={() => setEdit(assignment)}>撤销</button>
    </li>)}</ul>
    <div className="gateway-admin-pagination"><span>共 {total} 项授权 · 第 {page}/{
      Math.max(1, Math.ceil(total / 25))} 页</span>
      <button type="button" disabled={page <= 1 || loading} onClick={() => setPage(value => value - 1)}>上一页</button>
      <button type="button" disabled={page >= Math.ceil(total / 25) || loading}
        onClick={() => setPage(value => value + 1)}>下一页</button></div>
    {edit && <AssignmentActionDialog providerId={providerId} csrf={csrf}
      assignment={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} onSaved={saved} />}
  </section>
}

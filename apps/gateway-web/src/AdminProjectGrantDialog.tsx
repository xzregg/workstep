import { useEffect, useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

export type ProjectGrant = { id: string; subject_type: 'user' | 'group'; subject_id: string;
  subject_name: string; access_level: 'read' | 'edit' }
type Subject = { id: string; name: string }

export function AdminProjectGrantDialog({ projectId, grant, csrf, onClose, onSaved }: {
  projectId: string; grant?: ProjectGrant; csrf: string; onClose: () => void; onSaved: () => void
}) {
  const [subjectType, setSubjectType] = useState<'user' | 'group'>(grant?.subject_type ?? 'user')
  const [subjectId, setSubjectId] = useState(grant?.subject_id ?? '')
  const [level, setLevel] = useState<'read' | 'edit'>(grant?.access_level ?? 'read')
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [subjectPage, setSubjectPage] = useState(1)
  const [subjectTotal, setSubjectTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [discard, setDiscard] = useState(false)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    if (grant) return
    const controller = new AbortController()
    const params = new URLSearchParams({ subject_type: subjectType, q: search,
      page: String(subjectPage), page_size: '25' })
    setLoading(true); setError('')
    void fetch(`/api/admin/project-grant-subjects?${params}`, {
      credentials: 'same-origin', signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error('授权对象加载失败。')
      const data = await response.json()
      if (!controller.signal.aborted) { setSubjects(data.subjects ?? []); setSubjectTotal(data.total ?? 0) }
    }).catch(reason => {
      if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '授权对象加载失败。')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [grant, subjectType, search, subjectPage, revision])

  const dirty = subjectId !== (grant?.subject_id ?? '') || level !== (grant?.access_level ?? 'read') || !!password
  async function save() {
    setBusy(true); setError('')
    try {
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
      const step = await fetch('/api/auth/step-up', { method: 'POST', credentials: 'same-origin', headers,
        body: JSON.stringify({ password }) })
      if (!step.ok) throw new Error('密码验证失败。')
      const response = await fetch(`/api/admin/projects/${encodeURIComponent(projectId)}/grants`, {
        method: 'POST', credentials: 'same-origin', headers,
        body: JSON.stringify({ subject_type: subjectType, subject_id: subjectId, access_level: level }),
      })
      if (!response.ok) throw new Error('保存项目授权失败，请检查对象状态。')
      onSaved()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存项目授权失败。') }
    finally { setBusy(false) }
  }
  function close() { if (dirty) setDiscard(true); else onClose() }

  return <>
    <GatewayConfirmDialog title={grant ? '调整项目授权' : '授予项目访问'}
      message="只授权已发布项目的远程访问；授权不会开放宿主 PC 的全部项目。"
      confirmLabel="保存授权" busy={busy} disabled={!subjectId || !password || loading}
      onConfirm={() => void save()} onCancel={close}>
      {grant ? <p>授权对象：{grant.subject_type === 'user' ? '用户' : '用户组'} · {grant.subject_name}</p> : <>
        <label htmlFor="project-grant-type">对象类型</label>
        <select id="project-grant-type" value={subjectType} onChange={event => {
          setSubjectType(event.target.value as 'user' | 'group'); setSubjectId(''); setSearch(''); setQuery(''); setSubjectPage(1)
        }}><option value="user">用户</option><option value="group">用户组</option></select>
        <form className="gateway-admin-search" onSubmit={event => {
          event.preventDefault(); setSubjectId(''); setSubjectPage(1); setSearch(query.trim())
        }}>
          <label htmlFor="project-grant-search">搜索授权对象</label>
          <input id="project-grant-search" value={query} onChange={event => setQuery(event.target.value)} />
          <button type="submit">搜索</button>
        </form>
        <label htmlFor="project-grant-subject">授权对象</label>
        <select id="project-grant-subject" value={subjectId} onChange={event => setSubjectId(event.target.value)}>
          <option value="">请选择</option>{subjects.map(subject =>
            <option key={subject.id} value={subject.id}>{subject.name}</option>)}</select>
        <div className="gateway-admin-pagination"><span>共 {subjectTotal} 个对象 · 第 {subjectPage}/{
          Math.max(1, Math.ceil(subjectTotal / 25))} 页</span>
          <button type="button" disabled={subjectPage <= 1 || loading} onClick={() => {
            setSubjectId(''); setSubjectPage(value => value - 1)
          }}>上一页</button>
          <button type="button" disabled={subjectPage >= Math.ceil(subjectTotal / 25) || loading}
            onClick={() => { setSubjectId(''); setSubjectPage(value => value + 1) }}>下一页</button></div>
        {loading && <p role="status">正在加载授权对象…</p>}
        {error && <button type="button" onClick={() => setRevision(value => value + 1)}>重试加载</button>}
      </>}
      <label htmlFor="project-grant-level">访问级别</label>
      <select id="project-grant-level" value={level} onChange={event => setLevel(event.target.value as 'read' | 'edit')}>
        <option value="read">只读</option><option value="edit">可编辑</option>
      </select>
      <label htmlFor="project-grant-password">输入管理员密码确认</label>
      <input id="project-grant-password" type="password" autoComplete="current-password" value={password}
        onChange={event => setPassword(event.target.value)} />
      {error && <p role="alert" className="gateway-auth-error">{error}</p>}
    </GatewayConfirmDialog>
    {discard && <GatewayConfirmDialog title="放弃项目授权修改" message="当前授权表单有未保存内容。"
      confirmLabel="放弃并关闭" onConfirm={onClose} onCancel={() => setDiscard(false)} />}
  </>
}

export function AdminProjectRevokeDialog({ projectId, grant, csrf, onClose, onSaved }: {
  projectId: string; grant: ProjectGrant; csrf: string; onClose: () => void; onSaved: () => void
}) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function revoke() {
    setBusy(true); setError('')
    try {
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
      const step = await fetch('/api/auth/step-up', { method: 'POST', credentials: 'same-origin', headers,
        body: JSON.stringify({ password }) })
      if (!step.ok) throw new Error('密码验证失败。')
      const response = await fetch(`/api/admin/projects/${encodeURIComponent(projectId)}/grants/${grant.subject_type}/${encodeURIComponent(grant.subject_id)}`, {
        method: 'DELETE', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf },
      })
      if (!response.ok) throw new Error('撤销项目授权失败。')
      onSaved()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '撤销项目授权失败。') }
    finally { setBusy(false) }
  }
  return <GatewayConfirmDialog title="撤销项目授权" message={`确认撤销 ${grant.subject_name} 的项目访问？`}
    confirmLabel="撤销授权" busy={busy} disabled={!password} onConfirm={() => void revoke()} onCancel={onClose}>
    <label htmlFor="project-revoke-password">输入管理员密码确认</label>
    <input id="project-revoke-password" type="password" autoComplete="current-password" value={password}
      onChange={event => setPassword(event.target.value)} />
    {error && <p role="alert" className="gateway-auth-error">{error}</p>}
  </GatewayConfirmDialog>
}

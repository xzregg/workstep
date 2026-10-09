import { PasswordConfirmation, confirmStepUp, useStepUpPassword } from './PasswordConfirmation'
import { useEffect, useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

type Assignment = { id: string; subjectType: 'user' | 'group'; subjectId: string;
  subjectName: string; effect: 'allow' | 'deny' }
type Subject = { id: string; name: string }

function CapabilityDialog({ projectId, csrf, assignment, onClose, onSaved }: {
  projectId: string; csrf: string; assignment?: Assignment; onClose: () => void; onSaved: () => void
}) {
  const [subjectType, setSubjectType] = useState<'user' | 'group'>(assignment?.subjectType ?? 'user')
  const [subjectId, setSubjectId] = useState(assignment?.subjectId ?? '')
  const [effect, setEffect] = useState<'allow' | 'deny'>(assignment?.effect ?? 'allow')
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const { password, setPassword, passwordRequired, passwordReady } = useStepUpPassword()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [discard, setDiscard] = useState(false)

  useEffect(() => {
    if (assignment) return
    const controller = new AbortController()
    const params = new URLSearchParams({ subject_type: subjectType, q: search,
      page: String(page), page_size: '25' })
    setLoading(true); setError('')
    void fetch(`/api/admin/project-grant-subjects?${params}`, {
      credentials: 'same-origin', signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error('对象加载失败。')
      const data = await response.json()
      if (!controller.signal.aborted) { setSubjects(data.subjects ?? []); setTotal(data.total ?? 0) }
    }).catch(reason => {
      if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '对象加载失败。')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [assignment, subjectType, search, page])

  async function save() {
    setBusy(true); setError('')
    try {
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
      const step = await confirmStepUp(csrf, password, passwordRequired)
      if (!step.ok) throw new Error('密码验证失败。')
      const url = subjectType === 'user'
        ? `/api/admin/capabilities/${encodeURIComponent(subjectId)}`
        : `/api/admin/projects/${encodeURIComponent(projectId)}/task-create-groups/${encodeURIComponent(subjectId)}`
      const body = subjectType === 'user'
        ? { capability: 'task.create', scope_type: 'project', scope_id: projectId, effect }
        : { effect }
      const response = await fetch(url, { method: 'POST', credentials: 'same-origin', headers,
        body: JSON.stringify(body) })
      if (!response.ok) throw new Error('保存任务创建能力失败。')
      onSaved()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存任务创建能力失败。') }
    finally { setBusy(false) }
  }
  const dirty = subjectId !== (assignment?.subjectId ?? '') || effect !== (assignment?.effect ?? 'allow') || !!password
  return <>
    <GatewayConfirmDialog title={assignment ? '调整任务创建能力' : '授予任务创建能力'}
      message="项目访问还需要单独的可编辑授权；任务创建能力本身不开放项目内容。"
      confirmLabel="保存能力" busy={busy} disabled={!subjectId || !passwordReady || loading}
      onConfirm={() => void save()} onCancel={() => dirty ? setDiscard(true) : onClose()}>
      {assignment ? <p>对象：{assignment.subjectType === 'user' ? '用户' : '用户组'} · {assignment.subjectName}</p> : <>
        <label htmlFor="task-create-type">对象类型</label>
        <select id="task-create-type" value={subjectType} onChange={event => {
          setSubjectType(event.target.value as 'user' | 'group'); setSubjectId(''); setPage(1); setSearch(''); setQuery('')
        }}><option value="user">用户</option><option value="group">用户组</option></select>
        <form className="gateway-admin-search" onSubmit={event => {
          event.preventDefault(); setSubjectId(''); setPage(1); setSearch(query.trim())
        }}><label htmlFor="task-create-search">搜索对象</label>
          <input id="task-create-search" value={query} onChange={event => setQuery(event.target.value)} />
          <button type="submit">搜索</button></form>
        <label htmlFor="task-create-subject">能力对象</label>
        <select id="task-create-subject" value={subjectId} onChange={event => setSubjectId(event.target.value)}>
          <option value="">请选择</option>{subjects.map(subject =>
            <option key={subject.id} value={subject.id}>{subject.name}</option>)}</select>
        <div className="gateway-admin-pagination"><span>共 {total} 个对象 · 第 {page}/{
          Math.max(1, Math.ceil(total / 25))} 页</span>
          <button type="button" disabled={page <= 1 || loading} onClick={() => { setSubjectId(''); setPage(value => value - 1) }}>上一页</button>
          <button type="button" disabled={page >= Math.ceil(total / 25) || loading}
            onClick={() => { setSubjectId(''); setPage(value => value + 1) }}>下一页</button></div>
        {loading && <p role="status">正在加载能力对象…</p>}
      </>}
      <label htmlFor="task-create-effect">效果</label>
      <select id="task-create-effect" value={effect} onChange={event => setEffect(event.target.value as 'allow' | 'deny')}>
        <option value="allow">允许创建</option><option value="deny">禁止创建</option></select>
      <PasswordConfirmation id="task-create-password" label="输入管理员密码确认" value={password} onChange={setPassword} />
      {error && <p role="alert" className="gateway-auth-error">{error}</p>}
    </GatewayConfirmDialog>
    {discard && <GatewayConfirmDialog title="放弃任务能力修改" message="当前表单有未保存内容。"
      confirmLabel="放弃并关闭" onConfirm={onClose} onCancel={() => setDiscard(false)} />}
  </>
}

function RevokeCapabilityDialog({ projectId, csrf, assignment, onClose, onSaved }: {
  projectId: string; csrf: string; assignment: Assignment; onClose: () => void; onSaved: () => void
}) {
  const { password, setPassword, passwordRequired, passwordReady } = useStepUpPassword()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function revoke() {
    setBusy(true); setError('')
    try {
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
      const step = await confirmStepUp(csrf, password, passwordRequired)
      if (!step.ok) throw new Error('密码验证失败。')
      const url = assignment.subjectType === 'user'
        ? `/api/admin/capabilities/${encodeURIComponent(assignment.subjectId)}/revoke`
        : `/api/admin/projects/${encodeURIComponent(projectId)}/task-create-groups/${encodeURIComponent(assignment.subjectId)}`
      const response = await fetch(url, assignment.subjectType === 'user'
        ? { method: 'POST', credentials: 'same-origin', headers,
          body: JSON.stringify({ capability: 'task.create', scope_type: 'project', scope_id: projectId }) }
        : { method: 'DELETE', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf } })
      if (!response.ok) throw new Error('撤销任务创建能力失败。')
      onSaved()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '撤销任务创建能力失败。') }
    finally { setBusy(false) }
  }
  return <GatewayConfirmDialog title="撤销任务创建能力" message={`确认撤销 ${assignment.subjectName} 的项目任务创建规则？`}
    confirmLabel="撤销规则" busy={busy} disabled={!passwordReady} onConfirm={() => void revoke()} onCancel={onClose}>
    <PasswordConfirmation id="task-create-revoke-password" label="输入管理员密码确认" value={password} onChange={setPassword} />
    {error && <p role="alert" className="gateway-auth-error">{error}</p>}
  </GatewayConfirmDialog>
}

export function AdminProjectTaskCreatePanel({ projectId, csrf }: { projectId: string; csrf: string }) {
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [edit, setEdit] = useState<Assignment | 'new' | null>(null)
  const [revoke, setRevoke] = useState<Assignment | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    void Promise.all([
      fetch(`/api/admin/projects/${encodeURIComponent(projectId)}/task-create-users`, {
        credentials: 'same-origin', signal: controller.signal }),
      fetch(`/api/admin/projects/${encodeURIComponent(projectId)}/task-create-groups`, {
        credentials: 'same-origin', signal: controller.signal }),
    ]).then(async ([users, groups]) => {
      if (!users.ok || !groups.ok) throw new Error('任务创建能力加载失败。')
      const [userData, groupData] = await Promise.all([users.json(), groups.json()])
      if (!controller.signal.aborted) setAssignments([
        ...(userData.assignments ?? []).map((row: { id: string; user_id: string; username: string; effect: 'allow' | 'deny' }) =>
          ({ id: row.id, subjectType: 'user' as const, subjectId: row.user_id,
            subjectName: row.username, effect: row.effect })),
        ...(groupData.assignments ?? []).map((row: { id: string; group_id: string; group_name: string; effect: 'allow' | 'deny' }) =>
          ({ id: row.id, subjectType: 'group' as const, subjectId: row.group_id,
            subjectName: row.group_name, effect: row.effect })),
      ])
    }).catch(reason => {
      if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '任务创建能力加载失败。')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [projectId, revision])
  function saved() { setEdit(null); setRevoke(null); setRevision(value => value + 1) }
  return <section className="gateway-project-grants">
    <div className="gateway-admin-toolbar"><h3>项目任务创建能力</h3>
      <button type="button" onClick={() => setEdit('new')}>配置能力</button></div>
    <p>需要同时具有项目可编辑授权。显式禁止规则优先于允许规则。</p>
    {loading && <p role="status">正在加载任务创建规则…</p>}
    {error && <p role="alert" className="gateway-auth-error">{error} <button type="button"
      onClick={() => setRevision(value => value + 1)}>重试</button></p>}
    {!loading && !error && assignments.length === 0 && <p>暂无项目任务创建规则。</p>}
    <ul className="gateway-device-list">{assignments.map(assignment => <li key={assignment.id}>
      <div><strong>{assignment.subjectName}</strong><p>{assignment.subjectType === 'user' ? '用户' : '用户组'} · {
        assignment.effect === 'allow' ? '允许创建' : '禁止创建'}</p></div>
      <div className="gateway-device-actions"><button type="button" onClick={() => setEdit(assignment)}>调整能力</button>
        <button type="button" onClick={() => setRevoke(assignment)}>撤销规则</button></div>
    </li>)}</ul>
    {edit && <CapabilityDialog key={edit === 'new' ? 'new' : edit.id} projectId={projectId} csrf={csrf}
      assignment={edit === 'new' ? undefined : edit} onClose={() => setEdit(null)} onSaved={saved} />}
    {revoke && <RevokeCapabilityDialog projectId={projectId} csrf={csrf} assignment={revoke}
      onClose={() => setRevoke(null)} onSaved={saved} />}
  </section>
}

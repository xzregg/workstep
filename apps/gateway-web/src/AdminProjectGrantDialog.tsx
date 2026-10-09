import { GatewayModal } from './GatewayModal'
import { PasswordConfirmation, confirmStepUp, useStepUpPassword } from './PasswordConfirmation'
import { useEffect, useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

export type ProjectGrant = { id: string; subject_type: 'user' | 'group'; subject_id: string;
  subject_name: string; access_level: 'read' | 'edit' }
type Subject = { id: string; name: string }

export function AdminProjectGrantDialog({ projectId, deviceId, grant, csrf, name, onClose, onSaved }: {
  projectId?: string; deviceId?: string; grant?: ProjectGrant; csrf: string; name?: string; onClose: () => void; onSaved: () => void
}) {
  const [subjectType, setSubjectType] = useState<'user' | 'group'>(grant?.subject_type ?? 'user')
  const [subjectId, setSubjectId] = useState(grant?.subject_id ?? '')
  const [subjectName, setSubjectName] = useState(grant?.subject_name ?? '')
  const [level, setLevel] = useState<'read' | 'edit'>(grant?.access_level ?? (deviceId ? 'edit' : 'read'))
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [subjectPage, setSubjectPage] = useState(1)
  const [subjectTotal, setSubjectTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const { password, setPassword, passwordRequired, passwordReady } = useStepUpPassword()
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

  const dirty = subjectId !== (grant?.subject_id ?? '') || level !== (grant?.access_level ?? (deviceId ? 'edit' : 'read')) || !!password
  async function save() {
    if (busy || !subjectId || !passwordReady || loading) return
    setBusy(true); setError('')
    try {
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
      const step = await confirmStepUp(csrf, password, passwordRequired)
      if (!step.ok) throw new Error('密码验证失败。')
      const response = await fetch(`/api/admin/${deviceId ? 'devices' : 'projects'}/${encodeURIComponent(deviceId ?? projectId!)}/grants`, {
        method: 'POST', credentials: 'same-origin', headers,
        body: JSON.stringify({ subject_type: subjectType, subject_id: subjectId, access_level: level }),
      })
      if (!response.ok) throw new Error('保存授权失败，请检查对象状态。')
      onSaved()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存授权失败。') }
    finally { setBusy(false) }
  }
  function close() { if (busy) return; if (dirty) setDiscard(true); else onClose() }

  return <>
    <GatewayModal title={deviceId ? '授予设备访问' : grant ? '调整项目授权' : '授予项目访问'}
      onClose={close} footer={<>
        <button type="button" className="gateway-dialog-cancel" disabled={busy} onClick={close}>取消</button>
        <button type="button" disabled={busy || !subjectId || !passwordReady || loading} onClick={() => void save()}>
          {busy ? <><span className="gateway-spinner" /> 保存中…</> : '保存授权'}</button>
      </>}>
      <div className="gateway-grant-editor">
      {name && <p className="gateway-grant-target">{deviceId ? '设备' : '项目'}：<strong>{name}</strong></p>}
      <p>{deviceId ? '授权后可操作这台 WorkStep 及其中的全部项目。' : '只授权已发布项目的远程访问；授权不会开放宿主 PC 的全部项目。'}</p>
      {grant ? <p>授权对象：{grant.subject_type === 'user' ? '用户' : '用户组'} · {grant.subject_name}</p> : <>
        <label htmlFor="project-grant-type">对象类型</label>
        <select id="project-grant-type" disabled={busy} value={subjectType} onChange={event => {
          setSubjectType(event.target.value as 'user' | 'group'); setSubjectId(''); setSubjectName(''); setSubjects([]); setLoading(true); setSearch(''); setQuery(''); setSubjectPage(1)
        }}><option value="user">用户</option><option value="group">用户组</option></select>
        <form className="gateway-admin-search" onSubmit={event => {
          event.preventDefault(); setSubjectPage(1); setSearch(query.trim())
        }}>
          <label htmlFor="project-grant-search">搜索授权对象</label>
          <input id="project-grant-search" disabled={busy} value={query} onChange={event => setQuery(event.target.value)} />
          <button type="submit" disabled={busy}>搜索</button>
        </form>
        <fieldset className="gateway-grant-subjects" disabled={loading || busy}>
          <legend>授权对象</legend>
          {!loading && subjects.map(subject => <label key={subject.id} className="gateway-grant-subject">
            <input type="radio" name="project-grant-subject" checked={subjectId === subject.id}
              onChange={() => { setSubjectId(subject.id); setSubjectName(subject.name) }} />
            <span>{subject.name}</span>
          </label>)}
          {!loading && !error && subjects.length === 0 && <p>没有匹配的{subjectType === 'user' ? '用户' : '用户组'}，请尝试其他关键词。</p>}
        </fieldset>
        <div className="gateway-admin-pagination"><span>共 {subjectTotal} 个对象 · 第 {subjectPage}/{
          Math.max(1, Math.ceil(subjectTotal / 25))} 页</span>
          {subjectTotal > 25 && <><button type="button" disabled={subjectPage <= 1 || loading || busy} onClick={() => {
            setSubjectPage(value => value - 1)
          }}>上一页</button>
          <button type="button" disabled={subjectPage >= Math.ceil(subjectTotal / 25) || loading || busy}
            onClick={() => setSubjectPage(value => value + 1)}>下一页</button></>}</div>
        {loading && <p role="status"><span className="gateway-spinner"/> 正在加载授权对象…</p>}
        {error && <button type="button" onClick={() => setRevision(value => value + 1)}>重试加载</button>}
      </>}
      <div className="gateway-grant-permission"><label htmlFor="project-grant-level">访问级别</label>
      <select id="project-grant-level" disabled={busy} value={level} onChange={event => setLevel(event.target.value as 'read' | 'edit')}>
        {!deviceId && <option value="read">只读</option>}<option value="edit">可编辑</option>
      </select>
      <p>{deviceId ? '可操作这台设备及其中全部项目。' : level === 'read' ? '允许查看此项目的内容，不能编辑。' : '允许查看和编辑此项目的内容。'}</p></div>
      <p className="gateway-grant-summary" aria-live="polite">{subjectId ? `已选择：${subjectName} · ${level === 'read' ? '只读' : '可编辑'}` : '请选择一个授权对象'}</p>
      <PasswordConfirmation id="project-grant-password" label="输入管理员密码确认" value={password} onChange={setPassword} disabled={busy} />
      {error && <p role="alert" className="gateway-auth-error">{error}</p>}
      </div>
      {discard && <GatewayConfirmDialog title="放弃项目授权修改" message="当前授权表单有未保存内容。"
      confirmLabel="放弃并关闭" onConfirm={onClose} onCancel={() => setDiscard(false)} />}
    </GatewayModal>
  </>
}

export function AdminProjectRevokeDialog({ projectId, deviceId, grant, csrf, onClose, onSaved }: {
  projectId?: string; deviceId?: string; grant: ProjectGrant; csrf: string; onClose: () => void; onSaved: () => void
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
      const response = await fetch(`/api/admin/${deviceId ? 'devices' : 'projects'}/${encodeURIComponent(deviceId ?? projectId!)}/grants/${grant.subject_type}/${encodeURIComponent(grant.subject_id)}`, {
        method: 'DELETE', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf },
      })
      if (!response.ok) throw new Error('撤销授权失败。')
      onSaved()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '撤销授权失败。') }
    finally { setBusy(false) }
  }
  return <GatewayConfirmDialog title={deviceId ? '撤销设备授权' : '撤销项目授权'} message={`确认撤销 ${grant.subject_name} 的${deviceId ? '设备' : '项目'}访问？${deviceId ? '' : '撤销后将禁止该用户通过邀请重新加入，需管理员重新授权。'}`}
    confirmLabel="撤销授权" busy={busy} disabled={!passwordReady} onConfirm={() => void revoke()} onCancel={onClose}>
    <PasswordConfirmation id="project-revoke-password" label="输入管理员密码确认" value={password} onChange={setPassword} />
    {error && <p role="alert" className="gateway-auth-error">{error}</p>}
  </GatewayConfirmDialog>
}

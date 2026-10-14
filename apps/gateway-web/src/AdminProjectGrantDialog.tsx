import { GrantSubjectPicker } from './GrantSubjectPicker'
import { GatewayModal } from './GatewayModal'
import { PasswordConfirmation, confirmStepUp, useStepUpPassword } from './PasswordConfirmation'
import { useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

export type ProjectGrant = { id: string; subject_type: 'user' | 'group'; subject_id: string;
  subject_name: string; access_level: 'read' | 'edit' }
type Subject = { id: string; name: string }

export function AdminProjectGrantDialog({ projectId, deviceId, grant, csrf, name, onClose, onSaved }: {
  projectId?: string; deviceId?: string; grant?: ProjectGrant; csrf: string; name?: string; onClose: () => void; onSaved: () => void
}) {
  const [subjectType, setSubjectType] = useState<'user' | 'group'>(grant?.subject_type ?? 'user')
  const [selectedSubjects, setSelectedSubjects] = useState<Subject[]>(grant ? [{ id: grant.subject_id, name: grant.subject_name }] : [])
  const [completed, setCompleted] = useState<string[]>([])
  const [level, setLevel] = useState<'read' | 'edit'>(grant?.access_level ?? (deviceId ? 'edit' : 'read'))
  const { password, setPassword, passwordRequired, passwordReady } = useStepUpPassword()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [discard, setDiscard] = useState(false)

  const locked = busy || completed.length > 0
  const dirty = (!grant && selectedSubjects.length > 0) || level !== (grant?.access_level ?? (deviceId ? 'edit' : 'read')) || !!password
  async function save() {
    if (busy || !selectedSubjects.length || !passwordReady) return
    setBusy(true); setError('')
    try {
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
      const step = await confirmStepUp(csrf, password, passwordRequired)
      if (!step.ok) throw new Error('密码验证失败。')
      for (const subject of selectedSubjects.filter(subject => !completed.includes(subject.id))) {
        const response = await fetch(`/api/admin/${deviceId ? 'devices' : 'projects'}/${encodeURIComponent(deviceId ?? projectId!)}/grants`, {
          method: 'POST', credentials: 'same-origin', headers,
          body: JSON.stringify({ subject_type: subjectType, subject_id: subject.id, access_level: level }),
        })
        if (!response.ok) throw new Error(`保存 ${subject.name} 的授权失败，请重试。`)
        setCompleted(values => [...values, subject.id])
      }
      onSaved()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存授权失败。') }
    finally { setBusy(false) }
  }
  function close() { if (busy) return; if (dirty) setDiscard(true); else onClose() }

  return <>
    <GatewayModal title={deviceId ? '授予设备访问' : grant ? '调整项目授权' : '授予项目访问'}
      onClose={close} footer={<>
        <button type="button" className="gateway-dialog-cancel" disabled={busy} onClick={close}>取消</button>
        <button type="button" disabled={busy || !selectedSubjects.length || !passwordReady} onClick={() => void save()}>
          {busy ? <><span className="gateway-spinner" /> 保存中…</> : completed.length ? '重试未成功对象' : '保存授权'}</button>
      </>}>
      <div className="gateway-grant-editor">
      {name && <p className="gateway-grant-target">{deviceId ? '设备' : '项目'}：<strong>{name}</strong></p>}
      <p>{deviceId ? '授权后可操作这台 WorkStep 及其中的全部项目。' : '只授权已发布项目的远程访问；授权不会开放宿主 PC 的全部项目。'}</p>
      {grant ? <p>授权对象：{grant.subject_type === 'user' ? '用户' : '用户组'} · {grant.subject_name}</p> : <>
        <label htmlFor="project-grant-type">对象类型</label>
        <select id="project-grant-type" disabled={locked} value={subjectType} onChange={event => {
          setSubjectType(event.target.value as 'user' | 'group'); setSelectedSubjects([])
        }}><option value="user">用户</option><option value="group">用户组</option></select>
        <GrantSubjectPicker key={subjectType} subjectType={subjectType} selected={selectedSubjects}
          onChange={setSelectedSubjects} disabled={locked} />
      </>}
      <fieldset className="gateway-grant-permission" disabled={locked || !selectedSubjects.length}><legend>访问级别</legend>
        <div className="gateway-grant-level-options">
          {!deviceId && <label><input type="radio" name="grant-access-level" value="read" checked={level === 'read'} onChange={() => setLevel('read')} />只读</label>}
          <label><input type="radio" name="grant-access-level" value="edit" checked={level === 'edit'} onChange={() => setLevel('edit')} />可编辑</label>
        </div>
        <p>{deviceId ? '可操作这台设备及其中全部项目。' : level === 'read' ? '允许查看此项目的内容，不能编辑。' : '允许查看和编辑此项目的内容。'}</p>
      </fieldset>
      <p className="gateway-grant-summary" aria-live="polite">{selectedSubjects.length ? `已选择：${selectedSubjects.map(subject => subject.name).join('、')} · ${level === 'read' ? '只读' : '可编辑'}` : '请选择授权对象'}</p>
      {completed.length > 0 && <p role="status">已保存 {completed.length} 个对象，重试仅保存未成功的对象。</p>}
      <PasswordConfirmation id="project-grant-password" label="输入管理员密码确认" value={password} onChange={setPassword} disabled={busy} />
      {error && <p role="alert" className="gateway-auth-error">{error}</p>}
      </div>
      {discard && <GatewayConfirmDialog title="放弃项目授权修改" message={completed.length ? `已保存 ${completed.length} 个对象的授权；关闭不会撤销这些授权，确定放弃其余修改？` : "当前授权表单有未保存内容。"}
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

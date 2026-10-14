import { useEffect, useState } from 'react'
import { AdminRecordTable, AdminRecordRow } from './AdminRecordTable'
import { AdminProjectGrantDialog, AdminProjectRevokeDialog } from './AdminProjectGrantDialog'
import type { ProjectGrant } from './AdminProjectGrantDialog'
import { ProjectInvitationRecords } from './ProjectInvitationRecords'

export function AdminAccessGrants({ id, name, kind = 'projects', csrf, onChanged, canConfigurePermissions = false }: { id: string; name: string; kind?: 'projects' | 'devices'; csrf: string; onChanged: () => void; canConfigurePermissions?: boolean }) {
  const [grants, setGrants] = useState<ProjectGrant[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [edit, setEdit] = useState<ProjectGrant | 'new' | null>(null)
  const [revoke, setRevoke] = useState<ProjectGrant | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    void fetch(`/api/admin/${kind}/${encodeURIComponent(id)}/grants`, {
      credentials: 'same-origin', signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error('授权加载失败。')
      const data = await response.json()
      if (!controller.signal.aborted) setGrants(data.grants ?? [])
    }).catch(reason => {
      if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '授权加载失败。')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [id, kind, revision])

  function permissionUrl(grant?: ProjectGrant) {
    const params = new URLSearchParams({ scope_type: 'project', scope_id: id, scope_name: name, assign: '1' })
    if (grant) { params.set('subject_type', grant.subject_type); params.set('subject_id', grant.subject_id); params.set('subject_name', grant.subject_name) }
    return `/admin/permissions?${params}`
  }
  function saved() { setEdit(null); setRevoke(null); setRevision(value => value + 1); onChanged() }
  return <section className="gateway-project-grants">
    <div className="gateway-admin-toolbar"><h3>{name} · 访问授权</h3>
      <div className="gateway-device-actions">{kind === 'projects' && canConfigurePermissions && <a href={permissionUrl()}>配置项目权限</a>}
      <button type="button" onClick={() => setEdit('new')}>新增授权</button></div></div>
    {kind === 'projects' && canConfigurePermissions && <p>访问授权控制只读或可编辑；任务、流程、对话、文件与 Git 等操作统一在“配置项目权限”中分配。</p>}
    {loading && <p role="status"><span className="gateway-spinner"/> 正在加载授权…</p>}
    {error && <p role="alert" className="gateway-auth-error">{error} <button type="button"
      onClick={() => setRevision(value => value + 1)}>重试</button></p>}
    {!loading && !error && grants.length === 0 && <p>尚无访问授权。</p>}
    <AdminRecordTable>{grants.map(grant => <AdminRecordRow key={grant.id}>
      <div><strong>{grant.subject_name}</strong><p>{grant.subject_type === 'user' ? '用户' : '用户组'} · {
        grant.access_level === 'edit' ? '可编辑' : '只读'}</p></div>
      <div className="gateway-device-actions">{kind === 'projects' && canConfigurePermissions && <a href={permissionUrl(grant)} aria-label={`配置${grant.subject_name}的项目权限`}>项目权限</a>}
        <button type="button" onClick={() => setEdit(grant)}>调整</button>
        <button type="button" onClick={() => setRevoke(grant)}>撤销</button></div>
    </AdminRecordRow>)}</AdminRecordTable>
    {kind === 'projects' && <ProjectInvitationRecords projectId={id} csrf={csrf} admin revision={revision} onChanged={saved} />}
    {edit && <AdminProjectGrantDialog name={name} key={edit === 'new' ? 'new' : edit.id} projectId={kind === 'projects' ? id : undefined} deviceId={kind === 'devices' ? id : undefined}
      grant={edit === 'new' ? undefined : edit} csrf={csrf} onClose={() => setEdit(null)} onSaved={saved} />}
    {revoke && <AdminProjectRevokeDialog grant={revoke} projectId={kind === 'projects' ? id : undefined} deviceId={kind === 'devices' ? id : undefined} csrf={csrf}
      onClose={() => setRevoke(null)} onSaved={saved} />}
  </section>
}

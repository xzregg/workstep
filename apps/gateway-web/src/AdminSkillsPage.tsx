import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AdminSkillActionDialog } from './AdminSkillActionDialog'
import type { SkillAction } from './AdminSkillActionDialog'

type Skill = { id: string; name: string; slug: string; description: string; status: string }
type Version = { id: string; version: string; status: string; digest: string;
  file_count: number; total_size: number }
type Group = { id: string; name: string }
type Grant = { skill_id: string; name: string; skill_version_id: string;
  version: string; status: string }
type Application = { project_id: string; project_name: string; device_id: string;
  device_name: string; desired_revision: number; applied_revision: number | null;
  status: string; last_error_code: string | null }

async function read<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', signal })
  if (!response.ok) throw new Error(response.status === 403
    ? '当前账号没有 Skill 管理权限。' : 'Skill 管理数据加载失败。')
  return response.json() as Promise<T>
}

const statusNames: Record<string, string> = {
  pending_review: '待审核', approved: '已批准', revoked: '已撤销',
}

export function AdminSkillsPage() {
  const [csrf, setCsrf] = useState('')
  const [skills, setSkills] = useState<Skill[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [applications, setApplications] = useState<Application[]>([])
  const [skillId, setSkillId] = useState('')
  const [groupId, setGroupId] = useState('')
  const [versions, setVersions] = useState<Version[]>([])
  const [grants, setGrants] = useState<Grant[]>([])
  const [grantVersionId, setGrantVersionId] = useState('')
  const [revision, setRevision] = useState(0)
  const [action, setAction] = useState<SkillAction | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    void read<{ csrf_token: string }>('/api/auth/session', controller.signal)
      .then(result => { if (!controller.signal.aborted) setCsrf(result.csrf_token) })
      .catch(reason => { if (!controller.signal.aborted) setError(String(reason)) })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void Promise.all([
      read<{ skills: Skill[] }>('/api/admin/skills', controller.signal),
      read<{ groups: Group[] }>('/api/admin/groups', controller.signal),
      read<{ projects: Application[] }>('/api/admin/skills/applications', controller.signal),
    ]).then(([catalog, groupList, states]) => {
      if (controller.signal.aborted) return
      setSkills(catalog.skills); setGroups(groupList.groups); setApplications(states.projects)
      setError('')
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '加载失败。')
    })
    return () => controller.abort()
  }, [revision])

  useEffect(() => {
    if (!skillId) return
    const controller = new AbortController()
    void read<{ versions: Version[] }>(`/api/admin/skills/${skillId}/versions`,
      controller.signal).then(result => {
      if (controller.signal.aborted) return
      setVersions(result.versions)
      setGrantVersionId(current => result.versions.some(item =>
        item.id === current && item.status === 'approved') ? current :
        result.versions.find(item => item.status === 'approved')?.id ?? '')
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '版本加载失败。')
    })
    return () => controller.abort()
  }, [skillId, revision])

  useEffect(() => {
    if (!groupId) return
    const controller = new AbortController()
    void read<{ skills: Grant[] }>(`/api/admin/groups/${groupId}/skills`,
      controller.signal).then(result => {
      if (!controller.signal.aborted) setGrants(result.skills)
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '授权加载失败。')
    })
    return () => controller.abort()
  }, [groupId, revision])

  function changed(createdId?: string) {
    if (createdId) setSkillId(createdId)
    setAction(null)
    setRevision(value => value + 1)
  }

  return <section className="gateway-admin-page">
    <span className="gateway-auth-eyebrow">WORKSTEP 平台 · ADMIN</span>
    <div className="gateway-admin-toolbar"><h2>平台 Skill 管理</h2><Link to="/admin">返回管理概览</Link></div>
    <p>版本上传后需单独审核；只有已批准版本可授权用户组。撤销版本会使相关项目分配失效。</p>
    {error && <p role="alert" className="gateway-auth-error">{error} <button type="button"
      onClick={() => setRevision(value => value + 1)}>重试</button></p>}
    <section className="gateway-overview-card">
      <div className="gateway-admin-toolbar"><h3>Skill 目录</h3>
        <button type="button" disabled={!csrf} onClick={() => setAction({ kind: 'create' })}>创建 Skill</button></div>
      <label>Skill<select value={skillId} onChange={event => {
        setSkillId(event.target.value); setVersions([]); setGrantVersionId('')
      }}><option value="">选择 Skill</option>{skills.map(skill =>
        <option key={skill.id} value={skill.id}>{skill.name}</option>)}</select></label>
      {skillId && <div className="gateway-admin-toolbar"><h3>不可变版本</h3>
        <button type="button" disabled={!csrf} onClick={() => setAction({ kind: 'upload', skillId })}>
          上传版本</button></div>}
      {skillId && (versions.length === 0 ? <p>尚无版本。</p> : <ul>{versions.map(version =>
        <li key={version.id}>{version.version} · {statusNames[version.status] ?? version.status}
          {' · '}文件 {version.file_count} 个 · 摘要 {version.digest.slice(0, 12)}
          {version.status === 'pending_review' && <button type="button" disabled={!csrf}
            onClick={() => setAction({ kind: 'approve', skillId, versionId: version.id,
              version: version.version })}>批准版本 {version.version}</button>}
          {version.status === 'approved' && <button type="button" disabled={!csrf}
            onClick={() => setAction({ kind: 'revoke', skillId, versionId: version.id,
              version: version.version })}>撤销版本 {version.version}</button>}
        </li>)}</ul>)}
    </section>
    <section className="gateway-overview-card">
      <h3>用户组授权</h3>
      <label>用户组<select value={groupId} onChange={event => {
        setGroupId(event.target.value); setGrants([])
      }}><option value="">选择用户组</option>{groups.map(group =>
        <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
      <label>授权版本<select value={grantVersionId} disabled={!skillId}
        onChange={event => setGrantVersionId(event.target.value)}>
        <option value="">选择已批准版本</option>{versions.filter(item => item.status === 'approved')
          .map(version => <option key={version.id} value={version.id}>{version.version}</option>)}</select></label>
      <button type="button" disabled={!csrf || !groupId || !grantVersionId}
        onClick={() => setAction({ kind: 'grant', groupId, versionId: grantVersionId })}>
        授权用户组</button>
      {groupId && (grants.length === 0 ? <p>本组尚无 Skill 授权。</p> : <ul>{grants.map(grant =>
        <li key={grant.skill_id}>{grant.name} · {grant.version} · 已授权{' '}
          <button type="button" disabled={!csrf} onClick={() => setAction({
            kind: 'revoke_grant', groupId, skillId: grant.skill_id, name: grant.name,
          })}>撤销组授权 {grant.name}</button></li>)}</ul>)}
    </section>
    <section className="gateway-overview-card"><h3>设备应用状态</h3>
      {applications.length === 0 ? <p>尚无待同步的项目。</p> : <ul>{applications.map(item =>
        <li key={item.project_id}>{item.project_name} · {item.device_name} · 期望修订 {
          item.desired_revision} · 已应用修订 {item.applied_revision ?? '待同步'} · {item.status}
          {item.last_error_code && ` · 错误 ${item.last_error_code}`}</li>)}</ul>}
    </section>
    {action && <AdminSkillActionDialog action={action} csrf={csrf}
      onDone={changed} onClose={() => setAction(null)} />}
  </section>
}

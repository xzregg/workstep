import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'
import { GroupMembersPanel } from './GroupMembersPanel'

type Group = { id: string; name: string }
type Project = { id: string; name: string }
type Skill = { skill_id: string; name: string; skill_version_id: string; version: string }
type ProjectSkills = { desired_revision: number; applied_revision: number | null;
  status: string; last_error_code: string | null; skills: Skill[] }

async function loadJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', signal })
  if (!response.ok) throw new Error(response.status === 403
    ? '当前账号无权管理该用户组。' : '用户组 Skill 数据加载失败。')
  return response.json() as Promise<T>
}

export function GroupSkillsPage() {
  const [csrf, setCsrf] = useState('')
  const [groups, setGroups] = useState<Group[]>([])
  const [groupId, setGroupId] = useState('')
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState('')
  const [available, setAvailable] = useState<Skill[]>([])
  const [versionId, setVersionId] = useState('')
  const [assignment, setAssignment] = useState<ProjectSkills | null>(null)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [revoke, setRevoke] = useState<Skill | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void Promise.all([
      loadJson<{ groups: Group[] }>('/api/groups', controller.signal),
      loadJson<{ csrf_token: string }>('/api/auth/session', controller.signal),
    ]).then(([listing, session]) => {
      if (controller.signal.aborted) return
      setGroups(listing.groups); setCsrf(session.csrf_token)
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '加载失败。')
    })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!groupId) return
    const controller = new AbortController()
    void Promise.all([
      loadJson<{ projects: Project[] }>(`/api/groups/${groupId}/projects`, controller.signal),
      loadJson<{ skills: Skill[] }>(`/api/groups/${groupId}/skills`, controller.signal),
    ]).then(([linked, catalog]) => {
      if (controller.signal.aborted) return
      setProjects(linked.projects); setAvailable(catalog.skills)
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '加载失败。')
    })
    return () => controller.abort()
  }, [groupId])

  useEffect(() => {
    if (!groupId || !projectId) return
    const controller = new AbortController()
    void loadJson<ProjectSkills>(`/api/groups/${groupId}/projects/${projectId}/skills`,
      controller.signal).then(data => {
      if (!controller.signal.aborted) setAssignment(data)
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '加载失败。')
    })
    return () => controller.abort()
  }, [groupId, projectId, revision])

  async function write(method: 'POST' | 'DELETE', skillId?: string) {
    if (!groupId || !projectId || !csrf || busy) return
    setBusy(true); setError('')
    const url = `/api/groups/${groupId}/projects/${projectId}/skills`
      + (skillId ? `/${skillId}` : '')
    try {
      const response = await fetch(url, { method, credentials: 'same-origin', headers: {
        'Content-Type': 'application/json', 'X-CSRF-Token': csrf,
      }, body: method === 'POST' ? JSON.stringify({ skill_version_id: versionId }) : undefined })
      if (!response.ok) throw new Error(response.status === 409
        ? '版本冲突：请检查其他用户组对该项目的分配。' : '项目 Skill 操作失败。')
      setRevoke(null)
      setRevision(value => value + 1)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '项目 Skill 操作失败。')
    } finally { setBusy(false) }
  }

  return <section className="gateway-admin-page">
    <span className="gateway-auth-eyebrow">WORKSTEP GATEWAY · SKILLS</span>
    <div className="gateway-admin-toolbar"><h2>用户组 Skill 分配</h2><Link to="/">返回工作台</Link></div>
    <p>只可为本组关联项目分配已获授权的固定版本。撤销本组来源不会删除其他组仍在使用的版本。</p>
    <div className="gateway-usage-filters">
      <label>用户组<select value={groupId} onChange={event => {
        setGroupId(event.target.value); setProjectId(''); setVersionId('')
        setProjects([]); setAvailable([]); setAssignment(null); setError('')
      }}><option value="">选择用户组</option>{groups.map(group =>
        <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
      <label>项目<select value={projectId} disabled={!groupId} onChange={event => {
        setProjectId(event.target.value); setAssignment(null); setError('')
      }}><option value="">选择关联项目</option>{projects.map(project =>
        <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <label>可用 Skill 版本<select value={versionId} disabled={!projectId}
        onChange={event => setVersionId(event.target.value)}><option value="">选择已授权版本</option>
        {available.map(skill => <option key={skill.skill_version_id} value={skill.skill_version_id}>
          {skill.name} · {skill.version}</option>)}</select></label>
      <button type="button" disabled={!csrf || !projectId || !versionId || busy}
        onClick={() => void write('POST')}>分配 Skill</button>
    </div>
    {groups.length === 0 && !error && <p>当前账号没有可管理的用户组。</p>}
    {groupId && projects.length === 0 && !error && <p>本组尚无关联项目。</p>}
    {groupId && available.length === 0 && !error && <p>本组尚无已授权 Skill。</p>}
    {busy && <p role="status"><span className="gateway-spinner" aria-hidden="true" /> 正在保存 Skill 分配…</p>}
    {error && <p role="alert" className="gateway-auth-error">{error}</p>}
    {assignment && <section className="gateway-overview-card">
      <h3>项目已分配 Skill</h3>
      <p>期望修订 {assignment.desired_revision} · 已应用修订 {
        assignment.applied_revision ?? '待同步'} · 状态 {assignment.status}</p>
      {assignment.last_error_code && <p role="alert">应用错误：{assignment.last_error_code}</p>}
      {assignment.skills.length === 0 ? <p>当前用户组尚未分配 Skill。</p> :
        <ul>{assignment.skills.map(skill => <li key={skill.skill_id}>
          {skill.name} · {skill.version} · 来源：当前用户组{' '}
          <button type="button" disabled={busy} onClick={() => setRevoke(skill)}>
            撤销{skill.name}</button>
        </li>)}</ul>}
    </section>}
    {groupId && <GroupMembersPanel key={groupId} groupId={groupId} csrf={csrf} />}
    {revoke && <GatewayConfirmDialog title="撤销项目 Skill"
      message={`确认撤销本组对“${revoke.name}”的分配？其他有效用户组的分配仍会保留。`}
      confirmLabel="确认撤销" busy={busy} onCancel={() => setRevoke(null)}
      onConfirm={() => void write('DELETE', revoke.skill_id)} />}
  </section>
}

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AdminGroupCreateDialog } from './AdminGroupCreateDialog'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

type Group = { id: string; name: string; slug: string; source_type: string }
type Project = { id: string; name: string; device_name?: string; access_mode?: string }
type User = { id: string; username: string; display_name: string }
type Member = { user_id: string; username: string; display_name: string;
  role: string; source: string }
type Removal = { kind: 'project'; item: Project } | { kind: 'member'; item: Member }

async function read<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', signal })
  if (!response.ok) throw new Error(response.status === 403
    ? '当前账号没有用户组管理权限。' : '用户组数据加载失败。')
  return response.json() as Promise<T>
}

export function AdminGroupsPage() {
  const [csrf, setCsrf] = useState('')
  const [groups, setGroups] = useState<Group[]>([])
  const [groupId, setGroupId] = useState('')
  const [projects, setProjects] = useState<Project[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [projectQuery, setProjectQuery] = useState('')
  const [projectMatches, setProjectMatches] = useState<Project[]>([])
  const [userQuery, setUserQuery] = useState('')
  const [userMatches, setUserMatches] = useState<User[]>([])
  const [memberRole, setMemberRole] = useState<'member' | 'leader'>('member')
  const [revision, setRevision] = useState(0)
  const [createOpen, setCreateOpen] = useState(false)
  const [remove, setRemove] = useState<Removal | null>(null)
  const [busy, setBusy] = useState(false)
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
    void read<{ groups: Group[] }>('/api/groups', controller.signal)
      .then(result => { if (!controller.signal.aborted) setGroups(result.groups) })
      .catch(reason => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '加载失败。')
      })
    return () => controller.abort()
  }, [revision])

  useEffect(() => {
    if (!groupId) return
    const controller = new AbortController()
    void Promise.all([
      read<{ projects: Project[] }>(`/api/groups/${groupId}/projects`, controller.signal),
      read<{ members: Member[] }>(`/api/groups/${groupId}/members`, controller.signal),
    ]).then(([linked, listing]) => {
      if (controller.signal.aborted) return
      setProjects(linked.projects); setMembers(listing.members)
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '加载失败。')
    })
    return () => controller.abort()
  }, [groupId, revision])

  async function searchProjects() {
    try {
      const result = await read<{ projects: Project[] }>(
        `/api/groups/linkable-projects?${new URLSearchParams({ q: projectQuery.trim(), page_size: '25' })}`)
      setProjectMatches(result.projects); setError('')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '项目搜索失败。') }
  }

  async function searchUsers() {
    try {
      const result = await read<{ users: User[] }>(
        `/api/admin/users?${new URLSearchParams({ q: userQuery.trim(), status: 'active', page_size: '25' })}`)
      setUserMatches(result.users); setError('')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '用户搜索失败。') }
  }

  async function write(url: string, method: 'POST' | 'DELETE', body?: Record<string, string>) {
    if (!csrf || busy) return
    setBusy(true); setError('')
    try {
      const response = await fetch(url, { method, credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: body ? JSON.stringify(body) : undefined })
      if (!response.ok) throw new Error(response.status === 409
        ? '用户组操作冲突，请刷新后重试。' : '用户组操作失败。')
      setRemove(null)
      setRevision(value => value + 1)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '用户组操作失败。')
    } finally { setBusy(false) }
  }

  return <section className="gateway-admin-page">
    <span className="gateway-auth-eyebrow">WORKSTEP 平台 · ADMIN</span>
    <div className="gateway-admin-toolbar"><h2>用户组管理</h2><Link to="/admin">返回管理概览</Link></div>
    <p>项目关联仅用于 Skill 策略，不授予项目内容读取或整台电脑访问权。</p>
    <div className="gateway-admin-toolbar"><label>用户组<select value={groupId} onChange={event => {
      setGroupId(event.target.value); setProjects([]); setMembers([])
      setProjectMatches([]); setUserMatches([]); setError('')
    }}><option value="">选择用户组</option>{groups.map(group =>
      <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
      <button type="button" disabled={!csrf} onClick={() => setCreateOpen(true)}>创建用户组</button></div>
    {error && <p role="alert" className="gateway-auth-error">{error} <button type="button"
      onClick={() => setRevision(value => value + 1)}>重试</button></p>}
    {busy && <p role="status"><span className="gateway-spinner" aria-hidden="true" /> 正在更新用户组…</p>}
    {groupId && <>
      <section className="gateway-overview-card"><h3>关联项目</h3>
        <form className="gateway-admin-search" onSubmit={event => {
          event.preventDefault(); void searchProjects()
        }}><label>搜索项目<input value={projectQuery} maxLength={128}
          onChange={event => setProjectQuery(event.target.value)} /></label>
          <button type="submit">查找项目</button></form>
        {projectMatches.length > 0 && <ul>{projectMatches.map(project => <li key={project.id}>
          {project.name} · {project.device_name} · {project.access_mode === 'policy_only'
            ? '仅 Skill 策略' : '已发布'}{' '}
          <button type="button" disabled={busy || projects.some(item => item.id === project.id)}
            onClick={() => void write(`/api/groups/${groupId}/projects`, 'POST',
              { project_id: project.id })}>关联{project.name}</button></li>)}</ul>}
        {projects.length === 0 ? <p>尚无关联项目。</p> : <ul>{projects.map(project =>
          <li key={project.id}>{project.name} · 已关联{' '}
            <button type="button" disabled={busy} onClick={() => setRemove({ kind: 'project', item: project })}>
              取消关联{project.name}</button></li>)}</ul>}
      </section>
      <section className="gateway-overview-card"><h3>成员与组长</h3>
        <form className="gateway-admin-search" onSubmit={event => {
          event.preventDefault(); void searchUsers()
        }}><label>搜索用户<input value={userQuery} maxLength={128}
          onChange={event => setUserQuery(event.target.value)} /></label>
          <button type="submit">查找用户</button></form>
        <label>成员角色<select value={memberRole} onChange={event =>
          setMemberRole(event.target.value as 'member' | 'leader')}>
          <option value="member">普通成员</option><option value="leader">组长</option></select></label>
        {userMatches.length > 0 && <ul>{userMatches.map(user => <li key={user.id}>
          {user.username} · {user.display_name}{' '}
          <button type="button" disabled={busy} onClick={() => void write(
            `/api/groups/${groupId}/members`, 'POST',
            { user_id: user.id, role: memberRole },
          )}>添加 {user.username} 为{memberRole === 'leader' ? '组长' : '成员'}</button></li>)}</ul>}
        {members.length === 0 ? <p>尚无成员。</p> : <ul>{members.map(member =>
          <li key={member.user_id}>{member.username} · {member.role === 'leader' ? '组长' : '成员'}
            {member.source === 'manual' && <button type="button" disabled={busy}
              onClick={() => setRemove({ kind: 'member', item: member })}>
              移除 {member.username}</button>}</li>)}</ul>}
      </section>
    </>}
    {createOpen && <AdminGroupCreateDialog csrf={csrf} onClose={() => setCreateOpen(false)}
      onDone={id => { setCreateOpen(false); setGroupId(id); setRevision(value => value + 1) }} />}
    {remove && <GatewayConfirmDialog title={remove.kind === 'project' ? '取消项目关联' : '移除成员'}
      message={remove.kind === 'project' ? '关联取消后，本组来源的项目 Skill 分配会撤销。'
        : '确认移除这位用户的组成员身份？'}
      confirmLabel={remove.kind === 'project' ? '确认取消关联' : '确认移除'} busy={busy}
      onCancel={() => setRemove(null)} onConfirm={() => void write(remove.kind === 'project'
        ? `/api/groups/${groupId}/projects/${remove.item.id}`
        : `/api/groups/${groupId}/members/${remove.item.user_id}`, 'DELETE')} />}
  </section>
}

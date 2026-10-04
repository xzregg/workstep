import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'

type Department = { id: string; source_id: string; provider: string; tenant_id: string;
  external_id: string; display_name: string; parent_external_id: string | null;
  active: boolean; direct_members: number; child_count: number }
type Member = { id: string; user_id: string; subject: string; display_name: string;
  username: string; user_status: string }

function DepartmentNode({ department, selectedId, select, revision }: {
  department: Department; selectedId: string | undefined; select: (department: Department) => void; revision: number
}) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<Department[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!expanded) return
    const controller = new AbortController()
    const params = new URLSearchParams({ parent_id: department.id, page: String(page), page_size: '25' })
    setLoading(true); setError('')
    void fetch(`/api/admin/org/departments?${params}`, { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(response.status === 403 ? '当前权限无法查看子部门。' : '子部门加载失败。')
        const data = await response.json()
        if (!controller.signal.aborted) { setChildren(data.departments ?? []); setTotal(data.total ?? 0) }
      }).catch(reason => {
        if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '子部门加载失败。')
      }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [department.id, expanded, page, retry, revision])
  return <li>
    <div className="gateway-org-node">
      {department.child_count > 0 && <button type="button" className="gateway-org-expand"
        aria-label={`${expanded ? '收起' : '展开'} ${department.display_name} 子部门`} aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}>{expanded ? '▾' : '▸'}</button>}
      <button type="button" className={selectedId === department.id ? 'gateway-org-selected' : ''}
        onClick={() => select(department)}>
        <strong>{department.display_name}</strong>
        <span>{department.provider === 'wecom' ? '企业微信' : '钉钉'} · 直属成员 {department.direct_members} · {
          department.active ? '有效' : '第三方已删除'}</span>
      </button>
    </div>
    {expanded && <div className="gateway-org-children">
      {loading && <p role="status">正在加载子部门…</p>}
      {error && <p role="alert">{error} <button type="button" onClick={() => setRetry(value => value + 1)}>重试</button></p>}
      {!loading && !error && children.length === 0 && <p>没有可见子部门。</p>}
      {!error && children.length > 0 && <ul className="gateway-org-department-list">{children.map(child =>
        <DepartmentNode key={child.id} department={child} selectedId={selectedId} select={select} revision={revision} />
      )}</ul>}
      {total > 25 && <div className="gateway-admin-pagination"><span>第 {page}/{Math.ceil(total / 25)} 页</span>
        <button type="button" disabled={page <= 1 || loading} onClick={() => setPage(value => value - 1)}>上一页</button>
        <button type="button" disabled={page >= Math.ceil(total / 25) || loading}
          onClick={() => setPage(value => value + 1)}>下一页</button></div>}
    </div>}
  </li>
}

export function AdminOrganizationDirectory({ sourceId, revision, superAdmin }: {
  sourceId: string; revision: number; superAdmin: boolean
}) {
  const [departments, setDepartments] = useState<Department[]>([])
  const [departmentTotal, setDepartmentTotal] = useState(0)
  const [departmentQuery, setDepartmentQuery] = useState('')
  const [departmentFilters, setDepartmentFilters] = useState({ q: '', status: 'active', sort: 'display_name',
    direction: 'asc', page: 1 })
  const [departmentLoading, setDepartmentLoading] = useState(false)
  const [departmentError, setDepartmentError] = useState('')
  const [departmentRevision, setDepartmentRevision] = useState(0)
  const [selected, setSelected] = useState<Department | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [memberTotal, setMemberTotal] = useState(0)
  const [memberQuery, setMemberQuery] = useState('')
  const [memberFilters, setMemberFilters] = useState({ q: '', sort: 'display_name', direction: 'asc', page: 1 })
  const [memberLoading, setMemberLoading] = useState(false)
  const [memberError, setMemberError] = useState('')
  const [memberRevision, setMemberRevision] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({ status: departmentFilters.status, sort: departmentFilters.sort,
      direction: departmentFilters.direction, page: String(departmentFilters.page), page_size: '25' })
    if (!departmentFilters.q) params.set('roots_only', 'true')
    if (sourceId) params.set('source_id', sourceId)
    if (departmentFilters.q) params.set('q', departmentFilters.q)
    setDepartmentLoading(true); setDepartmentError('')
    void fetch(`/api/admin/org/departments?${params}`, { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(response.status === 403 ? '当前权限无法查看组织目录。' : '部门列表加载失败。')
        const data = await response.json()
        if (!controller.signal.aborted) { setDepartments(data.departments ?? []); setDepartmentTotal(data.total ?? 0) }
      }).catch(reason => {
        if (reason?.name !== 'AbortError') setDepartmentError(reason instanceof Error ? reason.message : '部门列表加载失败。')
      }).finally(() => { if (!controller.signal.aborted) setDepartmentLoading(false) })
    return () => controller.abort()
  }, [sourceId, departmentFilters, revision, departmentRevision])

  useEffect(() => {
    if (!selected) return
    const controller = new AbortController()
    const params = new URLSearchParams({ sort: memberFilters.sort, direction: memberFilters.direction,
      page: String(memberFilters.page), page_size: '25' })
    if (memberFilters.q) params.set('q', memberFilters.q)
    setMemberLoading(true); setMemberError('')
    void fetch(`/api/admin/org/departments/${encodeURIComponent(selected.id)}/members?${params}`, {
      credentials: 'same-origin', signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error(response.status === 403 ? '当前权限无法查看该部门。' : '成员列表加载失败。')
      const data = await response.json()
      if (!controller.signal.aborted) { setMembers(data.members ?? []); setMemberTotal(data.total ?? 0) }
    }).catch(reason => {
      if (reason?.name !== 'AbortError') setMemberError(reason instanceof Error ? reason.message : '成员列表加载失败。')
    }).finally(() => { if (!controller.signal.aborted) setMemberLoading(false) })
    return () => controller.abort()
  }, [selected, memberFilters, revision, memberRevision])

  function searchDepartments(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setDepartmentFilters(current => ({ ...current, q: departmentQuery.trim(), page: 1 }))
  }
  function searchMembers(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMemberFilters(current => ({ ...current, q: memberQuery.trim(), page: 1 }))
  }

  return <div className="gateway-org-directory">
    <section className="gateway-org-departments">
      <h3>部门目录</h3>
      <form className="gateway-admin-search" onSubmit={searchDepartments}>
        <label htmlFor="org-department-search">搜索部门</label>
        <input id="org-department-search" value={departmentQuery} onChange={event => setDepartmentQuery(event.target.value)}
          placeholder="部门名称或外部 ID" /><button type="submit">搜索</button>
      </form>
      <div className="gateway-admin-filters">
        {superAdmin && <select aria-label="部门状态" value={departmentFilters.status}
          onChange={event => setDepartmentFilters(current => ({ ...current, status: event.target.value, page: 1 }))}>
          <option value="active">有效</option><option value="deleted">第三方已删除</option><option value="all">全部</option>
        </select>}
        <select aria-label="部门排序" value={departmentFilters.sort}
          onChange={event => setDepartmentFilters(current => ({ ...current, sort: event.target.value, page: 1 }))}>
          <option value="display_name">部门名称</option><option value="external_id">外部 ID</option>
        </select>
        <select aria-label="部门排序方向" value={departmentFilters.direction}
          onChange={event => setDepartmentFilters(current => ({ ...current, direction: event.target.value, page: 1 }))}>
          <option value="asc">升序</option><option value="desc">降序</option>
        </select>
      </div>
      {departmentLoading && <p role="status">正在加载部门…</p>}
      {departmentError && <p role="alert" className="gateway-auth-error">{departmentError} <button type="button"
        onClick={() => setDepartmentRevision(value => value + 1)}>重试</button></p>}
      {!departmentLoading && !departmentError && departments.length === 0 && <p>当前条件下没有部门。</p>}
      {!departmentLoading && !departmentError && <ul className="gateway-org-department-list">{departments.map(department =>
        <DepartmentNode key={department.id} department={department} selectedId={selected?.id}
          select={value => { setSelected(value); setMemberFilters(current => ({ ...current, page: 1 })) }}
          revision={revision} />
      )}</ul>}
      <div className="gateway-admin-pagination"><span>共 {departmentTotal} 个部门 · 第 {departmentFilters.page}/{
        Math.max(1, Math.ceil(departmentTotal / 25))} 页</span>
        <button type="button" disabled={departmentFilters.page <= 1 || departmentLoading}
          onClick={() => setDepartmentFilters(current => ({ ...current, page: current.page - 1 }))}>上一页</button>
        <button type="button" disabled={departmentFilters.page >= Math.ceil(departmentTotal / 25) || departmentLoading}
          onClick={() => setDepartmentFilters(current => ({ ...current, page: current.page + 1 }))}>下一页</button>
      </div>
    </section>
    <section className="gateway-org-members">
      <h3>{selected ? `${selected.display_name} · 直属成员` : '直属成员'}</h3>
      {!selected && <p>选择左侧部门查看成员。</p>}
      {selected && <>
        <p>第三方目录字段只读；本地角色和授权在用户管理中配置。</p>
        <form className="gateway-admin-search" onSubmit={searchMembers}>
          <label htmlFor="org-member-search">搜索成员</label>
          <input id="org-member-search" value={memberQuery} onChange={event => setMemberQuery(event.target.value)}
            placeholder="用户名或显示名称" /><button type="submit">搜索</button>
        </form>
        <div className="gateway-admin-filters">
          <select aria-label="成员排序" value={memberFilters.sort}
            onChange={event => setMemberFilters(current => ({ ...current, sort: event.target.value, page: 1 }))}>
            <option value="display_name">显示名称</option><option value="username">用户名</option>
          </select>
          <select aria-label="成员排序方向" value={memberFilters.direction}
            onChange={event => setMemberFilters(current => ({ ...current, direction: event.target.value, page: 1 }))}>
            <option value="asc">升序</option><option value="desc">降序</option>
          </select>
        </div>
        {memberLoading && <p role="status">正在加载成员…</p>}
        {memberError && <p role="alert" className="gateway-auth-error">{memberError} <button type="button"
          onClick={() => setMemberRevision(value => value + 1)}>重试</button></p>}
        {!memberLoading && !memberError && members.length === 0 && <p>该部门当前没有直属成员。</p>}
        {!memberLoading && !memberError && <ul className="gateway-device-list">{members.map(member => <li key={member.id}>
          <div><strong>{member.display_name}</strong><p>{member.username} · {member.user_status}</p></div>
        </li>)}</ul>}
        <div className="gateway-admin-pagination"><span>共 {memberTotal} 位成员 · 第 {memberFilters.page}/{
          Math.max(1, Math.ceil(memberTotal / 25))} 页</span>
          <button type="button" disabled={memberFilters.page <= 1 || memberLoading}
            onClick={() => setMemberFilters(current => ({ ...current, page: current.page - 1 }))}>上一页</button>
          <button type="button" disabled={memberFilters.page >= Math.ceil(memberTotal / 25) || memberLoading}
            onClick={() => setMemberFilters(current => ({ ...current, page: current.page + 1 }))}>下一页</button>
        </div>
      </>}
    </section>
  </div>
}

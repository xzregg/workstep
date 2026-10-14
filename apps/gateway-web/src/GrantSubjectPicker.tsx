import { useEffect, useId, useState } from 'react'
import { AdminUserGroupTree } from './AdminUserGroupTree'

export type GrantSubject = { id: string; name: string }
export function GrantSubjectPicker({ subjectType, selected, onChange, disabled = false }: {
 subjectType: 'user' | 'group'; selected: GrantSubject[]; onChange: (subjects: GrantSubject[]) => void; disabled?: boolean
}) {
 const searchId = useId()
 const [groupId, setGroupId] = useState('')
 const [query, setQuery] = useState('')
 const [search, setSearch] = useState('')
 const [subjects, setSubjects] = useState<GrantSubject[]>([])
 const [page, setPage] = useState(1)
 const [total, setTotal] = useState(0)
 const [loading, setLoading] = useState(true)
 const [error, setError] = useState('')
 const [revision, setRevision] = useState(0)
 useEffect(() => {
  const controller = new AbortController()
  const params = new URLSearchParams({ subject_type: subjectType, q: search, page: String(page), page_size: '25' })
  if (subjectType === 'user' && groupId) params.set('group_id', groupId)
  setLoading(true); setError('')
  void fetch(`/api/admin/project-grant-subjects?${params}`, { credentials: 'same-origin', signal: controller.signal })
   .then(async response => {
    if (!response.ok) throw Error('授权对象加载失败。')
    const data = await response.json()
    if (!controller.signal.aborted) { setSubjects(data.subjects ?? []); setTotal(data.total ?? 0) }
   }).catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
   .finally(() => { if (!controller.signal.aborted) setLoading(false) })
  return () => controller.abort()
 }, [subjectType, groupId, search, page, revision])
 return <div className="gateway-grant-picker">
  {subjectType === 'user' && <fieldset disabled={disabled} className="gateway-grant-groups">
   <AdminUserGroupTree selected={groupId} onSelect={id => { setGroupId(id); setPage(1) }} />
  </fieldset>}
  <div className="gateway-grant-members">
   <form className="gateway-admin-search" onSubmit={event => { event.preventDefault(); setPage(1); setSearch(query.trim()) }}>
    <label htmlFor={searchId}>搜索授权对象</label>
    <input id={searchId} placeholder={subjectType === 'user' ? '搜索成员姓名或账号' : '搜索用户组名称'} disabled={disabled}
     value={query} onChange={event => setQuery(event.target.value)} />
    <button type="submit" disabled={disabled || loading}>搜索</button>
   </form>
   <fieldset className="gateway-grant-subjects" disabled={disabled || loading}>
    <legend>{subjectType === 'user' ? '授权对象 · 用户组成员' : '授权对象 · 用户组'}</legend>
    {!loading && subjects.map(subject => <label key={subject.id} className="gateway-grant-subject">
     <input type="checkbox" checked={selected.some(item => item.id === subject.id)} onChange={() => onChange(
      selected.some(item => item.id === subject.id) ? selected.filter(item => item.id !== subject.id) : [...selected, subject])} />
     <span>{subject.name}</span>
    </label>)}
    {!loading && !error && !subjects.length && <p>没有匹配的{subjectType === 'user' ? '用户' : '用户组'}，请尝试其他关键词。</p>}
   </fieldset>
   <div className="gateway-admin-pagination"><span>共 {total} 个对象 · 第 {page}/{Math.max(1, Math.ceil(total / 25))} 页</span>
    {total > 25 && <><button type="button" disabled={disabled || loading || page === 1} onClick={() => setPage(value => value - 1)}>上一页</button>
     <button type="button" disabled={disabled || loading || page * 25 >= total} onClick={() => setPage(value => value + 1)}>下一页</button></>}
   </div>
   {loading && <p role="status"><span className="gateway-spinner" /> 正在加载授权对象…</p>}
   {error && <p role="alert">{error} <button type="button" onClick={() => setRevision(value => value + 1)}>重试加载</button></p>}
  </div>
 </div>
}

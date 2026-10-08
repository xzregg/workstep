import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { subtreeIds, TreeCheckbox } from './TreeSelection'

export type UserGroupNode = { id: string; name: string; parent_id: string | null; source_type: string; member_count: number }
export function AdminUserGroupTree({ selected, onSelect, revision = 0, endpoint = '/api/admin/user-groups/tree', allUsers = true, checked, onCheck }: {
 selected: string; onSelect: (id: string) => void; revision?: number; endpoint?: string; allUsers?: boolean
 checked?: string[]; onCheck?: (ids: string[]) => void
}) {
 const [groups, setGroups] = useState<UserGroupNode[]>([])
 const [error, setError] = useState('')
 const [loading, setLoading] = useState(true)
 const [retry, setRetry] = useState(0)
 const [query, setQuery] = useState('')
 useEffect(() => {
  const controller = new AbortController(); setLoading(true); setError('')
  void fetch(endpoint, { signal: controller.signal, credentials: 'same-origin' }).then(async response => {
   if (!response.ok) throw Error('用户组加载失败。')
   const result = await response.json()
   if (!controller.signal.aborted) setGroups(result.groups ?? [])
  }).catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
   .finally(() => { if (!controller.signal.aborted) setLoading(false) })
  return () => controller.abort()
 }, [endpoint, revision, retry])
 const ids = new Set(groups.map(group => group.id))
 const visible = (node: UserGroupNode, seen = new Set<string>()): boolean => {
  if (seen.has(node.id)) return false
  seen.add(node.id)
  return !query || node.name.includes(query) || groups.some(child => child.parent_id === node.id && visible(child, new Set(seen)))
 }
 const descendants = (id: string) => subtreeIds(groups, id)
 function toggle(id: string, value: boolean) {
  const selection = new Set(checked)
  for (const child of descendants(id)) { if (value) selection.add(child); else selection.delete(child) }
  let parent = groups.find(node => node.id === id)?.parent_id
  const seen = new Set<string>([id])
  while (parent && !seen.has(parent)) {
   seen.add(parent)
   if (descendants(parent).filter(child => child !== parent).every(child => selection.has(child))) selection.add(parent)
   else selection.delete(parent)
   parent = groups.find(node => node.id === parent)?.parent_id
  }
  onCheck?.([...selection])
 }
 const branch = (nodes: UserGroupNode[], seen = new Set<string>()): ReactNode => nodes.filter(node => !seen.has(node.id) && visible(node)).map(node => {
  const next = new Set(seen).add(node.id); const children = groups.filter(child => child.parent_id === node.id && !next.has(child.id))
  const button = <div className="gateway-tree-row">{onCheck && <TreeCheckbox label={`选择用户组${node.name}`} checked={checked?.includes(node.id) ?? false} partial={!checked?.includes(node.id) && descendants(node.id).some(id => checked?.includes(id))} onChange={value => toggle(node.id, value)} disabled={loading || !!error} />}
   <button type="button" title={node.name} className={selected === node.id ? 'gateway-group-selected' : ''} onClick={() => onSelect(node.id)}><span>{node.name}</span><small>{node.member_count ?? ''}</small></button></div>
  return <li role="treeitem" aria-selected={selected === node.id} key={node.id}>{children.length ? <details open><summary>{button}</summary><ul role="group">{branch(children, next)}</ul></details> : button}</li>
 })
 return <aside className="gateway-user-group-tree" aria-label="用户组树">
  <h3>用户组</h3><input aria-label="搜索用户组" placeholder="搜索用户组" value={query} onChange={event => setQuery(event.target.value)} />
  {loading && <p role="status"><span className="gateway-spinner" /> 加载用户组…</p>}
  {error && <p role="alert">{error}<button type="button" onClick={() => setRetry(value => value+1)}>重试</button></p>}
  <div className="gateway-tree-scroll"><ul role="tree" aria-label="用户组">{allUsers && <li role="treeitem" aria-selected={!selected}><button type="button" className={!selected ? 'gateway-group-selected' : ''} onClick={() => onSelect('')}>全部用户</button></li>}{branch(groups.filter(node => !node.parent_id || !ids.has(node.parent_id)))}</ul></div>
  {!loading && !error && !groups.length && <p>尚无用户组，可创建或同步组织。</p>}
 </aside>
}


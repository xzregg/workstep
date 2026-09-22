import { useState } from 'react'
import Icon from '../../components/Icon'
import type { Worktree } from './gitPrototypeModel'

// Inline branch controls: browsing, checkout and worktree navigation are distinct actions.
export default function GitBranchSwitcher({ current, trees, branches, dirty, busy, onSwitch, onLocate, onClose }: {
  current: Worktree; trees: Worktree[]; branches: string[]; dirty: boolean; busy: boolean;
  onSwitch: (branch: string) => void; onLocate: (id: string) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState('')
  const visible = branches.filter(branch => branch.toLowerCase().includes(query.toLowerCase()))
  return <section className="gp-branch-picker" aria-label="切换分支">
    <div className="gp-branch-picker-heading"><div><strong>切换当前目录的分支</strong><p>{current.path}</p></div><span className="gp-grow" /><button aria-label="收起分支列表" onClick={onClose}><Icon name="x" size={16} /></button></div>
    <label className="gp-search"><Icon name="search" size={14} /><input autoFocus placeholder="搜索分支" aria-label="搜索分支" value={query} onChange={e => setQuery(e.target.value)} /></label>
    {dirty && <p className="gp-branch-notice"><Icon name="bookmark" size={14} />当前目录有未提交修改。请先提交后再切换；定位其他 Worktree 不受影响。</p>}
    <div className="gp-branch-options">{visible.map(branch => {
      const occupied = trees.find(tree => tree.repo === current.repo && tree.branch === branch)
      const active = current.branch === branch
      return <div className={`gp-branch-option ${active ? 'current' : ''}`} key={branch}><Icon name="git-fork" size={16} /><div><strong>{branch}</strong><small>{active ? '当前分支' : occupied ? `已在 ${occupied.path} 检出` : '本地分支 · 尚未检出'}</small></div><span className="gp-grow" />{active ? <span className="gp-branch-current"><Icon name="check" size={14} />当前</span> : occupied ? <button disabled={busy} onClick={() => onLocate(occupied.id)}>定位工作目录<Icon name="chevron-right" size={13} /></button> : <button className="gp-branch-checkout" disabled={busy || dirty} onClick={() => onSwitch(branch)}>切换到此分支</button>}</div>
    })}{!visible.length && <p className="gp-tree-empty">没有匹配的分支</p>}</div>
    <footer>模拟切换 · 只更新此原型中的分支状态</footer>
  </section>
}

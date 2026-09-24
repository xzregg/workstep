import { useEffect, useState } from 'react'
import { gitApi, type GitBranch, type GitRepository, type GitDiscovery } from '../../api/git'
import { useI18n } from '../../i18n'
import Icon from '../Icon'
import Button from '../Button'
import { useGitStore } from '../../stores/gitStore'
import GitBranchStatus from './GitBranchStatus'

function Repository({ repo, selected, branch, query, relative, open, onToggle, onSelect }: { repo: GitRepository; selected?: string; branch?: string; query: string; relative: string; open: boolean; onToggle: () => void; onSelect: (id: string, ref?: string) => void }) {
  const { t } = useI18n()
  const referenceVersion = useGitStore(s => s.referenceVersion)
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [error, setError] = useState('')
  const directory = repo.worktrees.find(w => w.available)
  useEffect(() => {
    let current = true
    if (directory) gitApi.branches(directory.id).then(r => { if (current) { setBranches(r.branches); setError('') } }).catch(e => { if (current) setError(e.message) })
    return () => { current = false }
  }, [repo, directory?.id, referenceVersion])
  const matches = !query || `${repo.name} ${relative} ${repo.worktrees.map(w => `${w.path} ${w.branch}`).join(' ')}`.toLowerCase().includes(query.toLowerCase())
  if (!matches) return null
  const expanded = open || !!query
  return <section className="git-repository"><button className="git-repository-title" onClick={() => { if (!window.getSelection()?.toString()) onToggle() }} aria-expanded={expanded}><Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={13} /><Icon name="folder-open" size={15} /><strong>{relative === '.' ? repo.name : relative}</strong></button>
    {expanded && <>{repo.worktrees.map(w => <button key={w.id} className={`git-tree-item ${selected === w.id && !branch ? 'selected' : ''}`} title={w.path} disabled={!w.available || w.prunable} onClick={() => { if (!window.getSelection()?.toString()) onSelect(w.id) }}><Icon name={w.main ? 'folder' : 'git-fork'} size={15} /><span><strong>{w.branch || t('git.detached')}</strong><small>{w.main ? t('git.main') : t('git.worktree')} · {w.path}</small></span>{branches.find(b => b.name === w.branch) && <GitBranchStatus branch={branches.find(b => b.name === w.branch)!} />}{!w.available && <small>{t('git.missing')}</small>}</button>)}
      {error && <p className="git-danger">{error}</p>}
    </>}
  </section>
}

export default function GitRepositoryTree({ data, selected, branch, width, onSelect }: { data: GitDiscovery; selected?: string; branch?: string; width?: number; onSelect: (id: string, ref?: string) => void }) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [openDefault, setOpenDefault] = useState(true)
  const [openExceptions, setOpenExceptions] = useState<Set<string>>(new Set())
  const isOpen = (id: string) => openExceptions.has(id) ? !openDefault : openDefault
  const allClosed = data.repositories.length > 0 && data.repositories.every(repo => !isOpen(repo.id))
  function toggleRepository(id: string) {
    setOpenExceptions(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }
  function toggleAll() { setOpenDefault(allClosed); setOpenExceptions(new Set()) }
  return <aside className="git-tree" style={width ? { width, flexBasis: width } : undefined}><div className="git-tree-tools"><label className="git-search"><Icon name="search" size={14} /><input aria-label={t('git.search')} placeholder={t('git.search')} value={query} onChange={e => setQuery(e.target.value)} /></label><Button size="sm" disabled={!data.repositories.length} onClick={toggleAll}>{allClosed ? t('git.expandAll') : t('git.collapseAll')}</Button></div><div className="git-tree-scroll">
    {data.projects.map(p => <div key={p.id}><h3 title={p.path}>{p.name}</h3>{data.repositories.filter(r => r.projects.some(m => m.id === p.id)).map(r => <Repository key={r.id} repo={r} selected={selected} branch={branch} query={query} relative={r.projects.find(m => m.id === p.id)!.relative_path} open={isOpen(r.id)} onToggle={() => toggleRepository(r.id)} onSelect={onSelect} />)}</div>)}
    {!data.repositories.length && <p className="git-muted">{t('git.emptyHint')}</p>}
  </div><footer>{t('git.depth', { depth: data.depth })}<small>{t('git.browseHint')}</small></footer></aside>
}

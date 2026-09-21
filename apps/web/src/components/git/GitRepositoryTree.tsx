import { useEffect, useState } from 'react'
import { gitApi, type GitBranch, type GitRepository, type GitDiscovery } from '../../api/git'
import { useI18n } from '../../i18n'
import Icon from '../Icon'
import { useGitStore } from '../../stores/gitStore'
import GitBranchStatus from './GitBranchStatus'

function Repository({ repo, selected, branch, query, relative, onSelect }: { repo: GitRepository; selected?: string; branch?: string; query: string; relative: string; onSelect: (id: string, ref?: string) => void }) {
  const { t } = useI18n()
  const referenceVersion = useGitStore(s => s.referenceVersion)
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [error, setError] = useState('')
  const [open, setOpen] = useState(true)
  const directory = repo.worktrees.find(w => w.available)
  useEffect(() => {
    let current = true
    if (directory) gitApi.branches(directory.id).then(r => { if (current) { setBranches(r.branches); setError('') } }).catch(e => { if (current) setError(e.message) })
    return () => { current = false }
  }, [repo, directory?.id, referenceVersion])
  const matches = !query || `${repo.name} ${relative} ${repo.worktrees.map(w => `${w.path} ${w.branch}`).join(' ')} ${branches.map(b => b.name).join(' ')}`.toLowerCase().includes(query.toLowerCase())
  if (!matches) return null
  const other = branches.filter(b => !b.worktree_id)
  return <section className="git-repository"><button className="git-repository-title" onClick={() => setOpen(!open)} aria-expanded={open}><Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} /><Icon name="folder-open" size={15} /><strong>{relative === '.' ? repo.name : relative}</strong></button>
    {(open || query) && <>{repo.worktrees.map(w => <button key={w.id} className={`git-tree-item ${selected === w.id && !branch ? 'selected' : ''}`} title={w.path} disabled={!w.available || w.prunable} onClick={() => onSelect(w.id)}><Icon name={w.main ? 'folder' : 'git-fork'} size={15} /><span><strong>{w.branch || t('git.detached')}</strong><small>{w.main ? t('git.main') : t('git.worktree')} · {w.path}</small></span>{branches.find(b => b.name === w.branch) && <GitBranchStatus branch={branches.find(b => b.name === w.branch)!} />}{!w.available && <small>{t('git.missing')}</small>}</button>)}
      {!!other.length && <div className="git-tree-label">{t('git.branches')}</div>}{directory && other.map(b => <button className={`git-tree-item ${branch === b.name && repo.worktrees.some(w => w.id === selected) ? 'selected' : ''}`} key={b.name} onClick={() => onSelect(repo.worktrees.some(w => w.id === selected) ? selected! : directory.id, b.name)}><Icon name="git-fork" size={15} /><span>{b.name}<small>{t('git.browse')}</small></span><GitBranchStatus branch={b} /></button>)}
      {error && <p className="git-danger">{error}</p>}
    </>}
  </section>
}

export default function GitRepositoryTree({ data, selected, branch, onSelect }: { data: GitDiscovery; selected?: string; branch?: string; onSelect: (id: string, ref?: string) => void }) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  return <aside className="git-tree"><label className="git-search"><Icon name="search" size={14} /><input aria-label={t('git.search')} placeholder={t('git.search')} value={query} onChange={e => setQuery(e.target.value)} /></label><div className="git-tree-scroll">
    {data.projects.map(p => <div key={p.id}><h3 title={p.path}>{p.name}</h3>{data.repositories.filter(r => r.projects.some(m => m.id === p.id)).map(r => <Repository key={r.id} repo={r} selected={selected} branch={branch} query={query} relative={r.projects.find(m => m.id === p.id)!.relative_path} onSelect={onSelect} />)}</div>)}
    {!data.repositories.length && <p className="git-muted">{t('git.emptyHint')}</p>}
  </div><footer>{t('git.depth', { depth: data.depth })}<small>{t('git.browseHint')}</small></footer></aside>
}

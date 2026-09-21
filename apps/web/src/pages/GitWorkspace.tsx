import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useGitStore } from '../stores/gitStore'
import { useUserSettingsStore } from '../stores/userSettingsStore'
import { useProjectStore } from '../stores/projectStore'
import { useI18n } from '../i18n'
import GitRepositoryTree from '../components/git/GitRepositoryTree'
import GitWorktreePanel from '../components/git/GitWorktreePanel'
import GitScanSettings from './GitScanSettings'
import Icon from '../components/Icon'
import Button from '../components/Button'
import '../components/git/git.css'

export default function GitWorkspace() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const { data, scanning, job, error, scan } = useGitStore()
  const depth = useUserSettingsStore(s => s.gitScanDepth)
  const loaded = useUserSettingsStore(s => s.loaded)
  const load = useUserSettingsStore(s => s.load)
  const projects = useProjectStore(s => s.projects)
  const projectKey = projects.map(p => `${p.id}:${p.path}`).join('|')
  const [settings, setSettings] = useState(false)
  const [treeOpen, setTreeOpen] = useState(false)
  useEffect(() => { void load() }, [load])
  useEffect(() => { if (loaded) void scan(`${depth}:${projectKey}`) }, [scan, depth, loaded, projectKey])
  const projectId = params.get('project_id') || ''
  const preferred = data?.repositories.find(r => r.projects.some(p => p.id === projectId))
  const selected = params.get('worktree') || preferred?.worktrees.find(w => w.available)?.id || data?.repositories.flatMap(r => r.worktrees).find(w => w.available)?.id
  const valid = data?.repositories.some(r => r.worktrees.some(w => w.id === selected && w.available))
  const branch = params.get('ref') || undefined
  function select(id: string, ref?: string) { setParams({ project_id: projectId, worktree: id, ...(ref ? { ref } : {}) }, { replace: true }); setTreeOpen(false); setSettings(false) }
  const project = projects.find(p => p.id === projectId)
  return <div className={`git-page ${treeOpen ? 'tree-open' : ''}`}>
    <header className="git-page-header"><Button size="sm" onClick={() => navigate(project ? `/tasks?project=${encodeURIComponent(project.name)}` : '/tasks')}><Icon name="chevron-right" style={{ transform: 'rotate(180deg)' }} size={15} />{t('git.back')}</Button><h1>{t('git.title')}</h1><Button className="git-mobile-tree" size="sm" onClick={() => setTreeOpen(!treeOpen)}>{t('git.repositories')}</Button><span className="git-grow" />{scanning && <small>{job?.completed_projects || 0} / {job?.total_projects || 0}</small>}<Button size="sm" loading={scanning} onClick={() => void scan()}>{scanning ? t('git.scanning') : t('git.scan')}</Button><Button size="sm" onClick={() => setSettings(!settings)} aria-expanded={settings}><Icon name="settings" size={14} />{t('git.settings')}</Button></header>
    {error && <div className="git-error" role="alert">{error}<Button size="sm" onClick={() => void scan()}>{t('git.retry')}</Button></div>}
    {!!data?.errors.length && <details className="git-scan-errors"><summary>{t('git.scanError')} ({data.errors.length})</summary>{data.errors.map((e, i) => <p key={i}>{e.path}: {e.message}</p>)}</details>}
    <div className="git-page-body">{data && <GitRepositoryTree data={data} selected={selected} branch={branch} onSelect={select} />}{settings ? <main className="git-settings"><GitScanSettings /></main> : selected && valid ? <GitWorktreePanel key={`${selected}:${branch || ''}`} id={selected} branch={branch} onLocate={select} onChanged={scan} /> : <main className="git-empty"><Icon name={scanning ? 'loader-circle' : 'git-fork'} className={scanning ? 'git-spin' : ''} size={30} /><h2>{scanning ? t('git.scanning') : t('git.empty')}</h2><p>{t('git.emptyHint')}</p><Button onClick={() => setSettings(true)}>{t('git.settings')}</Button></main>}</div>
  </div>
}

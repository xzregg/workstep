import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { gitApi } from '../api/git'
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

export function scopeGitDiscovery(data: NonNullable<ReturnType<typeof useGitStore.getState>['data']>, projectId: string) {
  if (!projectId) return data
  const projects = data.projects.filter(project => project.id === projectId)
  const roots = projects.map(project => project.path.replace(/\/$/, '') + '/')
  return {
    ...data,
    projects,
    repositories: data.repositories.filter(repo => repo.projects.some(project => project.id === projectId)),
    errors: data.errors.filter(error => roots.some(root => error.path === root.slice(0, -1) || error.path.startsWith(root))),
  }
}

export function clampGitTreeWidth(width: number, viewportWidth = window.innerWidth) {
  return Math.round(Math.min(Math.max(width, 230), Math.max(230, viewportWidth * .42)))
}

export function gitReturnTarget(returnTo: unknown, projectName?: string) {
  if (typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//')) return returnTo
  return projectName ? `/tasks?project=${encodeURIComponent(projectName)}` : '/tasks'
}

export default function GitWorkspace() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const { data, scanning, job, error, scan } = useGitStore()
  const depth = useUserSettingsStore(s => s.gitScanDepth)
  const loaded = useUserSettingsStore(s => s.loaded)
  const load = useUserSettingsStore(s => s.load)
  const projects = useProjectStore(s => s.projects)
  const projectKey = projects.map(p => `${p.id}:${p.path}`).join('|')
  const [settings, setSettings] = useState(false)
  const [treeOpen, setTreeOpen] = useState(false)
  const [treeWidth, setTreeWidth] = useState(280)
  const [initializing, setInitializing] = useState(false)
  const [initializeError, setInitializeError] = useState('')
  const resizeStart = useRef<{ x: number; width: number } | null>(null)
  useEffect(() => { void load() }, [load])
  useEffect(() => { if (loaded) void scan(`${depth}:${projectKey}`) }, [scan, depth, loaded, projectKey])
  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (resizeStart.current) setTreeWidth(clampGitTreeWidth(resizeStart.current.width + event.clientX - resizeStart.current.x))
    }
    const stop = () => { resizeStart.current = null }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop) }
  }, [])
  const projectId = params.get('project_id') || ''
  const scopedData = data ? scopeGitDiscovery(data, projectId) : null
  const preferred = scopedData?.repositories[0]
  const selected = params.get('worktree') || preferred?.worktrees.find(w => w.available)?.id || scopedData?.repositories.flatMap(r => r.worktrees).find(w => w.available)?.id
  const valid = scopedData?.repositories.some(r => r.worktrees.some(w => w.id === selected && w.available))
  const branch = params.get('ref') || undefined
  function select(id: string, ref?: string) { setParams({ project_id: projectId, worktree: id, ...(ref ? { ref } : {}) }, { replace: true, state: location.state }); setTreeOpen(false); setSettings(false) }
  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault()
    resizeStart.current = { x: event.clientX, width: treeWidth }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function resizeWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault(); setTreeWidth(width => clampGitTreeWidth(width + (event.key === 'ArrowLeft' ? -16 : 16)))
    } else if (event.key === 'Home') { event.preventDefault(); setTreeWidth(230) }
  }
  const project = projects.find(p => p.id === projectId)
  const canInitialize = !!project && !!scopedData && !scopedData.repositories.length && !scanning
  const returnTo = (location.state as { returnTo?: unknown } | null)?.returnTo
  async function initializeRepository() {
    if (!canInitialize || initializing) return
    setInitializing(true); setInitializeError('')
    try {
      await gitApi.initialize(projectId)
      await scan(`initialize:${projectId}:${Date.now()}`)
    } catch (reason) { setInitializeError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setInitializing(false) }
  }
  return <div className={`git-page ${treeOpen ? 'tree-open' : ''}`}>
    <header className="git-page-header"><Button className="git-back-button" size="sm" aria-label={t('git.back')} title={t('git.back')} onClick={() => navigate(gitReturnTarget(returnTo, project?.name), { replace: true })}><Icon name="chevron-right" style={{ transform: 'rotate(180deg)' }} size={15} /><span>{t('git.back')}</span></Button><h1>{t('git.title')}</h1><Button className="git-mobile-tree" size="sm" onClick={() => setTreeOpen(!treeOpen)}>{t('git.repositories')}</Button><span className="git-grow" />{scanning && <small>{job?.completed_projects || 0} / {job?.total_projects || 0}</small>}<Button size="sm" loading={scanning} onClick={() => void scan()}>{scanning ? t('git.scanning') : t('git.scan')}</Button><Button className="git-settings-toggle" size="sm" aria-label={t('git.settings')} title={t('git.settings')} onClick={() => setSettings(!settings)} aria-expanded={settings}><Icon name="settings" size={14} /><span>{t('git.settings')}</span></Button></header>
    {error && <div className="git-error" role="alert">{error}<Button size="sm" onClick={() => void scan()}>{t('git.retry')}</Button></div>}
    {!!scopedData?.errors.length && <details className="git-scan-errors"><summary>{t('git.scanError')} ({scopedData.errors.length})</summary>{scopedData.errors.map((e, i) => <p key={i}>{e.path}: {e.message}</p>)}</details>}
    <div className="git-page-body">{scopedData && <><GitRepositoryTree data={scopedData} selected={selected} branch={branch} width={treeWidth} onSelect={select} /><div className="git-tree-resizer" role="separator" aria-orientation="vertical" aria-label={t('git.resizeTree')} aria-valuemin={230} aria-valuemax={clampGitTreeWidth(Number.MAX_SAFE_INTEGER)} aria-valuenow={treeWidth} tabIndex={0} onPointerDown={startResize} onDoubleClick={() => setTreeWidth(280)} onKeyDown={resizeWithKeyboard} /></>}{settings ? <main className="git-settings"><GitScanSettings /></main> : selected && valid ? <GitWorktreePanel key={`${selected}:${branch || ''}`} id={selected} branch={branch} onLocate={select} onChanged={scan} /> : <main className="git-empty"><Icon name={scanning || initializing ? 'loader-circle' : 'git-fork'} className={scanning || initializing ? 'git-spin' : ''} size={30} /><h2>{scanning ? t('git.scanning') : initializing ? t('git.initializing') : t('git.empty')}</h2><p>{canInitialize || initializing ? t('git.initializeHint') : t('git.emptyHint')}</p>{initializeError && <p className="git-danger" role="alert">{initializeError}</p>}<div className="git-empty-actions">{(canInitialize || initializing) && <Button variant="primary" loading={initializing} disabled={scanning} onClick={() => void initializeRepository()}>{initializing ? t('git.initializing') : t('git.initialize')}</Button>}<Button disabled={initializing} onClick={() => setSettings(true)}>{t('git.settings')}</Button></div></main>}</div>
  </div>
}

import { useGitApi, useReadOnlyGit, useGitActionAllowed } from './GitApiContext'
import { useEffect, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { type GitStatus, type GitFile } from '../../api/git'
import { useI18n } from '../../i18n'
import Button from '../Button'
import ConfirmDialog from '../ConfirmDialog'
import Icon from '../Icon'
import { usePanelGitWrites } from './gitPanelWrites'

type Draft = { message: string; selected: string[] }
const emptyDraft: Draft = { message: '', selected: [] }
const useDrafts = create<{ drafts: Record<string, Draft>; update: (id: string, draft: Draft) => void }>(set => ({ drafts: {}, update: (id, draft) => set(s => ({ drafts: { ...s.drafts, [id]: draft } })) }))

function fileTone(file: GitFile) {
  const status = file.worktree_status.trim() || file.index_status.trim()
  if (file.conflict || status === 'D') return 'deleted'
  if (file.untracked || status === 'A') return 'added'
  return 'modified'
}

export function GitFileList({ files, selected, onToggle, onDiff, onDiscard, onIgnore, actions }: { actions?: ReactNode; files: GitFile[]; selected?: string[]; onToggle?: (file: GitFile) => void; onDiff: (path: string) => void; onDiscard?: (file: GitFile) => void; onIgnore?: (file: GitFile) => void }) {
  const { t } = useI18n()
  const [collapseDefault, setCollapseDefault] = useState(false)
  const [exceptions, setExceptions] = useState<Set<string>>(new Set())
  const isClosed = (folder: string) => exceptions.has(folder) ? !collapseDefault : collapseDefault
  function toggleFolder(folder: string) { setExceptions(current => { const next = new Set(current); if (next.has(folder)) next.delete(folder); else next.add(folder); return next }) }
  const groups = new Map<string, GitFile[]>()
  for (const file of files) {
    const folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '.'
    groups.set(folder, [...(groups.get(folder) || []), file])
  }
  const allClosed = groups.size > 0 && [...groups.keys()].every(isClosed)
  return <div className="git-file-browser"><div className="git-file-toolbar"><strong>{t('git.files')} <span>{files.length}</span></strong><Button size="sm" disabled={!files.length} onClick={() => { setCollapseDefault(!allClosed); setExceptions(new Set()) }}>{allClosed ? t('git.expandAll') : t('git.collapseAll')}</Button>{actions}</div><div className="git-file-list">{[...groups].map(([folder, items]) => <section key={folder}>
    <button type="button" className="git-folder" aria-expanded={!isClosed(folder)} onClick={() => { if (!window.getSelection()?.toString()) toggleFolder(folder) }}><Icon name={isClosed(folder) ? 'chevron-right' : 'chevron-down'} size={12} /><Icon name="folder" size={13} /><span>{folder}</span><small>{items.length}</small></button>
    {!isClosed(folder) && items.map(file => <div className={`git-file git-file--${fileTone(file)}`} key={file.path}>
      {onToggle && <input type="checkbox" aria-label={file.path} checked={selected?.includes(file.path) || false} disabled={file.conflict || file.submodule} onChange={() => onToggle(file)} />}
      <button className="git-file-open" onClick={() => { if (!window.getSelection()?.toString()) onDiff(file.path) }} title={file.old_path ? `${file.old_path} → ${file.path}` : file.path}><Icon name="file" size={15} /><span>{file.path.split('/').at(-1)}</span>
        {file.conflict ? <small className="git-danger">{t('git.conflict')}</small> : file.submodule ? <small>{t('git.submodule')}</small> : file.untracked ? <small>{t('git.untracked')}</small> : file.staged ? <small>{t('git.staged')}</small> : null}
        <code className={file.untracked ? 'git-added' : 'git-modified'}>{file.untracked ? 'A' : (file.worktree_status.trim() || file.index_status)}</code>
      </button>
      {(onDiscard || (onIgnore && file.untracked)) && <span className="git-file-actions">
        {onDiscard && !file.conflict && !file.submodule && <button type="button" className="git-file-action" aria-label={`${t('git.discard')} ${file.path}`} title={t('git.discard')} onClick={() => onDiscard(file)}><Icon name="undo-2" size={14} /></button>}
        {onIgnore && file.untracked && !file.submodule && <button type="button" className="git-file-action" aria-label={`${t('git.ignore')} ${file.path}`} title={t('git.ignore')} onClick={() => onIgnore(file)}><Icon name="bookmark" size={14} /></button>}
      </span>}
    </div>)}
  </section>)}{!files.length && <div className="git-empty"><Icon name="check" size={28} /><p>{t('git.fileEmpty')}</p></div>}</div></div>
}

export default function GitChanges({ status, onRefresh, onDiff }: { status: GitStatus; onRefresh: () => Promise<void>; onDiff: (path: string) => void }) {
  const gitApi = useGitApi()
  const writes = usePanelGitWrites()
  const readOnly = useReadOnlyGit()
  const can = useGitActionAllowed()
  const { t } = useI18n()
  const saved = useDrafts(s => s.drafts[status.id])
  const draft = saved || { message: '', selected: status.files.filter(f => !f.untracked && !f.conflict && !f.submodule).map(f => f.path) }
  const update = useDrafts(s => s.update)
  const [busy, setBusy] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [notice, setNotice] = useState('')
  const [discarding, setDiscarding] = useState<GitFile | null>(null)
  const available = status.files.filter(f => !f.conflict && !f.submodule)
  useEffect(() => {
    if (!useDrafts.getState().drafts[status.id]) update(status.id, { message: '', selected: status.files.filter(f => !f.untracked && !f.conflict && !f.submodule).map(f => f.path) })
  }, [status.id, status.files, update])
  const selected = available.filter(f => draft.selected.includes(f.path)).map(f => f.path)
  const blocked = !!status.operation || status.files.some(f => f.conflict)
  function toggle(file: GitFile) {
    update(status.id, { ...draft, selected: selected.includes(file.path) ? selected.filter(p => p !== file.path) : [...selected, file.path] })
  }
  async function commit() {
    if (busy || writes.busy || blocked || !selected.length || !draft.message.trim()) return
    setBusy(true); setNotice('')
    try {
      const result = await writes.run(async () => {
        try { return await gitApi.commit(status.id, selected, draft.message.trim(), status.snapshot) }
        finally { await onRefresh() }
      })
      update(status.id, emptyDraft)
      setNotice(t('git.commitSuccess', { hash: result.head.slice(0, 8) }))
    } catch (error) { setNotice(String(error instanceof Error ? error.message : error)) }
    finally { setBusy(false) }
  }
  async function discard() {
    if (!discarding || busy || writes.busy) return
    setBusy(true); setNotice('')
    try {
      await writes.run(async () => {
        try { await gitApi.discard(status.id, discarding.path, status.snapshot) }
        finally { await onRefresh() }
      })
      setNotice(t('git.discardSuccess', { name: discarding.path }))
      setDiscarding(null)
    } catch (error) { setNotice(String(error instanceof Error ? error.message : error)) }
    finally { setBusy(false) }
  }
  async function ignore(file: GitFile) {
    if (busy || writes.busy) return
    setBusy(true); setNotice('')
    try {
      await writes.run(async () => {
        try { await gitApi.ignore(status.id, file.path, status.snapshot) }
        finally { await onRefresh() }
      })
      setNotice(t('git.ignoreSuccess', { name: file.path }))
    } catch (error) { setNotice(String(error instanceof Error ? error.message : error)) }
    finally { setBusy(false) }
  }
  async function generateMessage() {
    if (generating || busy || blocked || !selected.length) return
    setGenerating(true); setNotice('')
    try {
      const result = await gitApi.generateCommitMessage(status.id, selected, status.snapshot)
      update(status.id, { ...draft, message: result.message })
      setNotice(t('git.generateCommitSuccess'))
    } catch (error) { setNotice(String(error instanceof Error ? error.message : error)) }
    finally { setGenerating(false) }
  }
  return <div className="git-changes">
    <fieldset disabled={busy || generating || writes.busy} className="git-files-fieldset"><GitFileList files={status.files} selected={readOnly ? undefined : selected} onToggle={readOnly ? undefined : toggle} onDiff={onDiff} onDiscard={!can('discard') ? undefined : setDiscarding} onIgnore={!can('ignore') ? undefined : file => void ignore(file)} actions={readOnly ? undefined : <><Button size="sm" disabled={busy || generating} onClick={() => update(status.id, { ...draft, selected: available.map(f => f.path) })}>{t('git.selectAll')}</Button><Button size="sm" disabled={busy || generating} onClick={() => update(status.id, { ...draft, selected: [] })}>{t('git.clear')}</Button></>} /></fieldset>
    {!readOnly && <div className="git-commit-form"><div className="git-message-header"><label htmlFor={`git-message-${status.id}`}>{t('git.message')}</label></div><textarea id={`git-message-${status.id}`} value={draft.message} disabled={busy || generating} placeholder={t('git.messageHint')} onChange={e => update(status.id, { ...draft, message: e.target.value })} />
      <p className="git-commit-hint">{t('git.commitHint')}</p>{blocked && <p className="git-danger">{t('git.blocked')}</p>}
      {notice && <p role="status" className="git-notice">{notice}</p>}
      <div className="git-commit-actions"><Button data-commit variant="primary" loading={busy} disabled={writes.busy || generating || !draft.message.trim() || !selected.length || blocked} onClick={() => void commit()}>{busy ? t('git.committing') : t('git.commit', { count: selected.length })}</Button>{can('generateCommitMessage') && <Button size="sm" loading={generating} disabled={busy || blocked || !selected.length} onClick={() => void generateMessage()}><Icon name="sparkles" size={14} />{generating ? t('git.generatingCommit') : t('git.generateCommit')}</Button>}</div>
    </div>}
    <ConfirmDialog open={!!discarding} title={t('git.discardTitle')} message={discarding ? t(discarding.untracked ? 'git.discardUntrackedConfirm' : 'git.discardConfirm', { name: discarding.path }) : ''} confirmText={t('git.discard')} danger loading={busy} confirmDisabled={writes.busy} onConfirm={() => void discard()} onCancel={() => !busy && setDiscarding(null)} />
  </div>
}

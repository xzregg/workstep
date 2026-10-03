import { useGitApi, useReadOnlyGit, useGitActionAllowed } from './GitApiContext'
import ResizablePanel from '../ResizablePanel'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { type BlameLine, type Comparison, type GitDiff, type GitStatus } from '../../api/git'
import { useI18n } from '../../i18n'
import { useOverlay } from '../../hooks/useOverlay'
import { changedBlocks, expandHunks, parseGitPatch, restoreDiffBlock, type DiffBlock, type DiffHunk, type DiffLine } from './gitDiff'
import Icon from '../Icon'
import Button from '../Button'
import ConfirmDialog from '../ConfirmDialog'
import GitCodeEditor, { type GitCodeEditorHandle } from './GitCodeEditor'
import MarqueeText from '../MarqueeText'
import { usePanelGitWrites } from './gitPanelWrites'

export default function GitDiffDialog({ id, files, path, comparison, onSelect, onSaved, onClose }: { id: string; files: string[]; path: string; comparison: Comparison; onSelect: (path: string) => void; onSaved?: () => Promise<void>; onClose: () => void }) {
  const gitApi = useGitApi()
  const writes = usePanelGitWrites()
  const readOnly = useReadOnlyGit()
  const can = useGitActionAllowed()
  const { t } = useI18n()
  const dialog = useRef<HTMLDivElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const commitPopoverRef = useRef<HTMLDivElement>(null)
  const [data, setData] = useState<GitDiff | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [split, setSplit] = useState(true)
  const [fullFile, setFullFile] = useState(false)
  const [showBlame, setShowBlame] = useState(false)
  const [blame, setBlame] = useState<{ before: BlameLine[]; after: BlameLine[] }>({ before: [], after: [] })
  const [leftWidth, setLeftWidth] = useState(50)
  const content = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const beforeEditor = useRef<GitCodeEditorHandle>(null)
  const afterEditor = useRef<GitCodeEditorHandle>(null)
  const [blameLoading, setBlameLoading] = useState(false)
  const [retry, setRetry] = useState(0)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [restoringBlock, setRestoringBlock] = useState<string | null>(null)
  const [undoing, setUndoing] = useState(false)
  const [appliedBlocks, setAppliedBlocks] = useState<{ id: string; path: string; previous: string; applied: string; snapshot: string }[]>([])
  const [pendingExit, setPendingExit] = useState<'editor' | 'dialog' | null>(null)
  const [editLines, setEditLines] = useState({ before: 1, after: 1 })
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [commitPopover, setCommitPopover] = useState<{ commit: BlameLine; x: number; y: number } | null>(null)
  const dirty = editing && !!data && draft !== data.after
  const lastApplied = appliedBlocks.at(-1)
  const syncFromBefore = useCallback((scrollTop: number) => afterEditor.current?.setScrollTop(scrollTop), [])
  const syncFromAfter = useCallback((scrollTop: number) => beforeEditor.current?.setScrollTop(scrollTop), [])
  function requestClose() { if (dirty) setPendingExit('dialog'); else onClose() }
  useOverlay(true, requestClose, dialog)
  useEffect(() => { setAppliedBlocks([]) }, [id, path])
  useEffect(() => {
    let current = true
    setLoading(true); setData(null); setError(''); setBlame({ before: [], after: [] }); setEditing(false); setContextMenu(null); setCommitPopover(null)
    gitApi.diff(id, path, { ref: comparison.ref, commit: comparison.commit }).then(r => { if (current) { setData(r); setDraft(r.after) } }).catch(e => { if (current) setError(e.message) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [id, path, comparison.ref, comparison.commit, retry])
  useEffect(() => {
    let current = true
    setBlameLoading(false)
    if (!showBlame || !data) return
    setBlameLoading(true)
    Promise.all([
      data.base ? gitApi.blame(id, data.old_path, data.base) : Promise.resolve({ lines: [] }),
      data.target ? gitApi.blame(id, data.path, data.target) : Promise.resolve({ lines: [] }),
    ]).then(([before, after]) => { if (current) setBlame({ before: before.lines, after: after.lines }) }).catch(e => { if (current) setError(e.message) }).finally(() => { if (current) setBlameLoading(false) })
    return () => { current = false }
  }, [showBlame, id, data])
  useEffect(() => {
    if (!contextMenu) return
    const closeOutside = (event: MouseEvent) => {
      if (!contextMenuRef.current?.contains(event.target as Node)) setContextMenu(null)
    }
    const closeOnScroll = () => setContextMenu(null)
    document.addEventListener('mousedown', closeOutside)
    window.addEventListener('resize', closeOnScroll)
    window.addEventListener('scroll', closeOnScroll, true)
    return () => {
      document.removeEventListener('mousedown', closeOutside)
      window.removeEventListener('resize', closeOnScroll)
      window.removeEventListener('scroll', closeOnScroll, true)
    }
  }, [contextMenu])
  useEffect(() => {
    if (!commitPopover) return
    const closeOutside = (event: MouseEvent) => {
      if (!commitPopoverRef.current?.contains(event.target as Node)) setCommitPopover(null)
    }
    const closeOnScroll = () => setCommitPopover(null)
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setCommitPopover(null) }
    }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', closeOnEscape, true)
    window.addEventListener('resize', closeOnScroll)
    window.addEventListener('scroll', closeOnScroll, true)
    return () => {
      document.removeEventListener('mousedown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape, true)
      window.removeEventListener('resize', closeOnScroll)
      window.removeEventListener('scroll', closeOnScroll, true)
    }
  }, [commitPopover])
  const hunks = useMemo(() => parseGitPatch(data?.patch || ''), [data?.patch])
  const viewHunks = useMemo(() => fullFile && data ? [expandHunks(data.before, data.after, hunks)] : hunks, [fullFile, data, hunks])
  const authors = useMemo(() => ({ before: new Map(blame.before.map(line => [line.line, line])), after: new Map(blame.after.map(line => [line.line, line])) }), [blame])
  const index = files.indexOf(path)
  const editable = !readOnly && can('saveFile') && !comparison.ref && !comparison.commit && !!data?.snapshot && !data.binary && !data.truncated && !data.submodule
  async function persistContent(content: string, snapshot: string, expectedContent?: string): Promise<GitStatus | null> {
    if (saving || writes.busy) return null
    setSaving(true); setError('')
    try {
      const status = await writes.run(async () => {
        const value = expectedContent === undefined
          ? await gitApi.saveFile(id, path, content, snapshot)
          : await gitApi.saveFile(id, path, content, snapshot, expectedContent)
        setEditing(false)
        setRetry(current => current + 1)
        try { await onSaved?.() } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
        return value
      })
      return status
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return null }
    finally { setSaving(false) }
  }
  async function save() {
    if (dirty && data?.snapshot && await persistContent(draft, data.snapshot)) setAppliedBlocks([])
  }
  async function applyBlock(hunk: DiffHunk, block: DiffBlock, key: string) {
    if (!editable || !data || saving) return
    const content = restoreDiffBlock(data.after, hunk, block, data.before)
    if (content === null) { setError(t('git.staleDiff')); return }
    setRestoringBlock(key)
    try {
      const status = await persistContent(content, data.snapshot!)
      if (status?.snapshot) setAppliedBlocks(entries => [...entries, { id, path, previous: data.after, applied: content, snapshot: status.snapshot }])
    }
    finally { setRestoringBlock(null) }
  }
  async function undoAppliedBlock() {
    if (!lastApplied || lastApplied.id !== id || lastApplied.path !== path || saving) return
    setUndoing(true)
    try {
      const status = await persistContent(lastApplied.previous, lastApplied.snapshot, lastApplied.applied)
      if (status) setAppliedBlocks(entries => {
        if (entries.at(-1) !== lastApplied) return entries
        const remaining = entries.slice(0, -1)
        if (remaining.length) remaining[remaining.length - 1] = { ...remaining[remaining.length - 1], snapshot: status.snapshot }
        return remaining
      })
    } finally { setUndoing(false) }
  }
  function exitEditor() {
    if (dirty) setPendingExit('editor')
    else setEditing(false)
  }
  function startEditing() {
    const sections = [...(content.current?.querySelectorAll<HTMLElement>('[data-hunk-index]') || [])]
    const viewport = content.current?.querySelector<HTMLElement>('.git-diff-scroll')
    const center = viewport ? viewport.getBoundingClientRect().top + viewport.clientHeight / 2 : 0
    const distance = (section: HTMLElement) => {
      const rect = section.getBoundingClientRect()
      return center < rect.top ? rect.top - center : center > rect.bottom ? center - rect.bottom : 0
    }
    const selected = sections.reduce<HTMLElement | undefined>((best, section) => {
      if (!best) return section
      return distance(section) < distance(best) ? section : best
    }, undefined)
    const index = Number(selected?.dataset.hunkIndex || 0)
    const rows = hunks[index]?.rows || []
    setEditLines({
      before: rows.find(row => row.before)?.before?.number || 1,
      after: rows.find(row => row.after)?.after?.number || 1,
    })
    setEditing(true)
  }
  function confirmExit() {
    const action = pendingExit
    setPendingExit(null)
    setDraft(data?.after || '')
    setEditing(false)
    if (action === 'dialog') onClose()
  }
  function showCommit(element: HTMLElement, commit: BlameLine) {
    const rect = element.getBoundingClientRect()
    const width = 300
    const height = 132
    const below = rect.bottom + 6
    setCommitPopover({
      commit,
      x: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(below + height <= window.innerHeight ? below : rect.top - height - 6, window.innerHeight - height - 8)),
    })
  }
  function cell(line: DiffLine | undefined, side: 'before' | 'after', sourceLine?: number, action?: ReactNode) {
    const working = side === 'after' && !data?.target
    const author = working ? (!line?.changed && sourceLine ? authors.before.get(sourceLine) : undefined) : authors[side].get(line?.number || 0)
    const uncommitted = working && line?.changed
    const blameColumn = showBlame ? <span className="git-blame" title={author ? `${author.author} · ${new Date(author.time * 1000).toLocaleString()}\n${author.hash.slice(0, 8)} ${author.message}` : uncommitted ? t('git.newLine') : ''}><span className="git-blame-date">{author ? new Date(author.time * 1000).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }) : ''}</span><MarqueeText className={`git-blame-author${author ? ' is-clickable' : ''}`} speed={36} text={author?.author || (uncommitted ? t('git.newLine') : '')} role={author ? 'button' : undefined} tabIndex={author ? 0 : undefined} onClick={event => { if (author) showCommit(event.currentTarget, author) }} onKeyDown={event => { if (author && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); showCommit(event.currentTarget, author) } }} /></span> : null
    const lineNumber = <span className="git-line-number">{line?.number}</span>
    const source = <code>{line?.text ?? ' '}</code>
    return <div className={`git-code-cell ${line?.changed ? side === 'before' ? 'removed' : 'added' : ''}`} onContextMenu={event => {
      event.preventDefault()
      const width = 188
      const height = 42
      setContextMenu({ x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)) })
    }}>
      {split ? side === 'before' ? <>{source}{action}{blameColumn}{lineNumber}</> : <>{lineNumber}{blameColumn}{source}</> : <>{blameColumn}{lineNumber}{source}</>}
    </div>
  }
  function splitHunk(hunk: DiffHunk, hunkIndex: number) {
    const blocks = new Map(changedBlocks(hunk).map(block => [block.start, block]))
    return <div className="git-hunk-panes" style={{ gridTemplateColumns: `${leftWidth}% minmax(0, 1fr)` }}>
      <div className="git-code-pane" data-diff-side="before">{hunk.rows.map((row, index) => {
        const block = blocks.get(index)
        const key = `${hunkIndex}:${index}`
        const action = editable && <span className="git-copy-slot">{block && <button className="git-copy-block" aria-label={t('git.applyBlock')} title={t('git.applyBlock')} disabled={saving} onClick={() => void applyBlock(hunk, block, key)}>{saving && restoringBlock === key ? <Icon name="loader-circle" className="git-spin" size={14} /> : '≫'}</button>}</span>
        return <div key={index}>{cell(row.before, 'before', undefined, action)}</div>
      })}</div>
      <div className="git-code-pane" data-diff-side="after">{hunk.rows.map((row, index) => <div key={index}>{cell(row.after, 'after', row.before?.number)}</div>)}</div>
    </div>
  }
  return createPortal(<><div className="git-diff-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) requestClose() }}><ResizablePanel ref={dialog} minWidth={360} minHeight={300} className={`git-diff-dialog ${split ? 'split' : 'unified'}${showBlame ? ' has-blame' : ''}`} role="dialog" aria-modal="true" aria-label={t('git.diff')} tabIndex={-1}>
    <header><Icon name="file" size={17} /><strong><span title={path} data-dialog-selectable-text>{path}</span></strong><Button variant="icon" aria-label={t('git.previous')} disabled={editing || index <= 0} onClick={() => onSelect(files[index - 1])}><Icon name="chevron-right" style={{ transform: 'rotate(180deg)' }} size={16} /></Button><Button variant="icon" aria-label={t('git.next')} disabled={editing || index < 0 || index >= files.length - 1} onClick={() => onSelect(files[index + 1])}><Icon name="chevron-right" size={16} /></Button><Button variant="icon" aria-label={t('git.close')} onClick={requestClose}><Icon name="x" size={18} /></Button></header>
    <div className="git-diff-toolbar">{editing ? <><Button size="sm" variant="primary" loading={saving} disabled={!dirty} onClick={() => void save()}><Icon name="check" size={14} />{t('git.saveFile')}</Button><Button size="sm" disabled={saving} onClick={exitEditor}>{t('common.cancel')}</Button><small>{t('git.saveShortcut')}</small></> : <>{lastApplied?.id === id && lastApplied.path === path && <Button size="sm" aria-label={t('git.undoApplied')} loading={undoing} disabled={saving} onClick={() => void undoAppliedBlock()}>{t('git.undoApplied')}</Button>}<Button size="sm" onClick={() => setSplit(!split)}>{split ? t('git.unified') : t('git.split')}</Button><Button size="sm" aria-pressed={fullFile} onClick={() => setFullFile(value => !value)}>{fullFile ? t('git.changedOnly') : t('git.fullFile')}</Button><Button size="sm" loading={blameLoading} aria-pressed={showBlame} onClick={() => setShowBlame(!showBlame)}>{t('git.blame')}</Button>{editable && <Button size="sm" onClick={startEditing}><Icon name="pencil" size={14} />{t('git.editFile')}</Button>}<select aria-label={t('git.hunks')} defaultValue="" onChange={e => { document.getElementById(`git-hunk-${e.target.value}`)?.scrollIntoView({ block: 'start' }) }}><option value="">{t('git.hunks')}</option>{hunks.map((h, i) => <option key={i} value={i}>{h.label}</option>)}</select></>}</div>
    <div className="git-diff-labels" style={{ gridTemplateColumns: `${leftWidth}% minmax(0, 1fr)` }}><span>{t('git.before')} · {data?.base?.slice(0, 8) || '∅'} · {t('git.readonly')}</span><span>{t('git.after')} · {data?.target?.slice(0, 8) || t('git.changes')}{editing ? ` · ${t('git.editable')}` : ''}</span></div>
    {error && <div className="git-error" role="alert">{error}<Button size="sm" onClick={() => setRetry(n => n + 1)}>{t('git.retry')}</Button></div>}
    <div className="git-diff-content" ref={content}>
      {editing && data ? <div className="git-file-editor" style={{ gridTemplateColumns: `${leftWidth}% minmax(0, 1fr)` }}><GitCodeEditor ref={beforeEditor} filename={data.old_path} value={data.before} targetLine={editLines.before} gutter="right" ariaLabel={t('git.before')} onVerticalScroll={syncFromBefore} /><GitCodeEditor ref={afterEditor} filename={data.path} value={draft} targetLine={editLines.after} editable gutter="left" ariaLabel={t('git.editable')} onChange={setDraft} onSave={() => void save()} onVerticalScroll={syncFromAfter} /></div> : <div className="git-diff-scroll">{loading ? <div className="git-empty"><Icon name="loader-circle" className="git-spin" size={24} />{t('git.loading')}</div> : data?.binary || data?.truncated || data?.submodule ? <p className="git-empty">{t('git.noPreview')}</p> : viewHunks.length ? viewHunks.map((h, i) => <section key={i} id={`git-hunk-${i}`} data-hunk-index={i}>{h.header && <h4>{h.header}</h4>}{split ? splitHunk(h, i) : h.rows.map((row, n) => <div key={n}>{row.before?.changed && cell(row.before, 'before')}{row.after && cell(row.after, 'after', row.before?.number)}</div>)}</section>) : !error && <p className="git-empty">{t('git.noDiff')}</p>}</div>}
      {split && <div className="git-diff-divider" role="separator" aria-label={t('git.resizeSplit')} aria-orientation="vertical" aria-valuemin={20} aria-valuemax={80} aria-valuenow={leftWidth} tabIndex={0} style={{ left: `${leftWidth}%` }}
        onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId) }}
        onPointerMove={e => { if (!dragging.current || !content.current) return; const rect = content.current.getBoundingClientRect(); if (rect.width) setLeftWidth(Math.round(Math.max(20, Math.min(80, (e.clientX - rect.left) / rect.width * 100)))) }}
        onPointerUp={e => { dragging.current = false; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId) }}
        onPointerCancel={() => { dragging.current = false }} onLostPointerCapture={() => { dragging.current = false }}
        onDoubleClick={() => setLeftWidth(50)} onKeyDown={e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); setLeftWidth(value => e.key === 'Home' ? 20 : e.key === 'End' ? 80 : Math.max(20, Math.min(80, value + (e.key === 'ArrowRight' ? 5 : -5)))) } }} />}
    </div>
    {contextMenu && <div ref={contextMenuRef} className="git-diff-context-menu" role="menu" aria-label={t('git.diff')} style={{ left: contextMenu.x, top: contextMenu.y }} onContextMenu={event => event.preventDefault()}>
      <button autoFocus role="menuitem" onClick={() => { setShowBlame(true); setContextMenu(null) }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setContextMenu(null) } }}><Icon name="user" size={14} />{t('git.blame')}{showBlame && <Icon name="check" size={14} />}</button>
    </div>}
    {commitPopover && <div ref={commitPopoverRef} className="git-commit-popover" data-git-commit-popover role="dialog" aria-label={t('git.commitDetails')} style={{ left: commitPopover.x, top: commitPopover.y }}>
      <div className="git-commit-popover-header"><strong>{t('git.commitDetails')}</strong><Button variant="icon" aria-label={t('git.close')} onClick={() => setCommitPopover(null)}><Icon name="x" size={14} /></Button></div>
      <p>{commitPopover.commit.message}</p>
      <small>{commitPopover.commit.author} · {new Date(commitPopover.commit.time * 1000).toLocaleString()}</small>
      <code>{commitPopover.commit.hash}</code>
    </div>}
  </ResizablePanel></div><ConfirmDialog open={!!pendingExit} title={t('git.unsavedTitle')} message={t('git.unsavedMessage')} confirmText={t('git.discardEditor')} danger onConfirm={confirmExit} onCancel={() => setPendingExit(null)} /></>, document.body)
}

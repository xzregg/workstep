import { useCallback, useMemo, useRef, useState } from 'react'
import type { GitDiff } from '../api/git'
import { useI18n } from '../i18n'
import { collectMessageFileChanges, relativeMessageFilePath, type FileChangesPage, type FileChangesQuery } from '../utils/messageFileChanges'
import { useProjectStore } from '../stores/projectStore'
import { buildMessageTimeline, type MessageTimelineEvent } from '../utils/messageTimeline'
import { classifyProjectFileLink } from '../utils/markdownFilePreview'
import { useTaskFilePreview } from '../contexts/MarkdownAssetUrlContext'
import Icon from './Icon'
import StreamingStatusText from './StreamingStatusText'
import FilePreviewDialog from './FilePreviewDialog'
import GitDiffDialog from './git/GitDiffDialog'
import FileContextMenu, { type FileContextTarget } from './FileContextMenu'
import './MessageFileChanges.css'
import './git/git.css'

export interface MessageFileChangeDetails {
  available?: boolean
  loaded?: boolean
  loading?: boolean
  error?: string
  edited_files?: string[]
}

export default function MessageFileChanges({ events, projectId, eventDetail, onLoadEventDetails }: {
  events: MessageTimelineEvent[]
  projectId?: string
  eventDetail?: MessageFileChangeDetails
  onLoadEventDetails?: (query?: FileChangesQuery) => void | Promise<unknown>
}) {
  const { t } = useI18n()
  const filePreview = useTaskFilePreview()
  const fileScope = projectId || (filePreview ? 'shared' : undefined)
  const project = useProjectStore(state => state.projects.find(project => project.id === projectId)
    || (projectId && state.activeProject?.id === projectId ? state.activeProject : undefined))
  const projectRoot = project?.path
  const [indexFiles, setIndexFiles] = useState<FileChangesPage['files'] | null>(null)
  const [indexLoading, setIndexLoading] = useState(false)
  const [indexError, setIndexError] = useState('')
  const patches = useRef(new Map<string, GitDiff>())
  const loader = useRef(onLoadEventDetails)
  loader.current = onLoadEventDetails
  const indexInFlight = useRef(false)
  const pendingDetails = Boolean(eventDetail?.available && !eventDetail.loaded && !indexFiles)
  const files = useMemo(() => {
    const recorded = collectMessageFileChanges(buildMessageTimeline(events), events, projectRoot)
    const known = new Set(recorded.map(file => relativeMessageFilePath(file.path, projectRoot)))
    const changes = indexFiles ? indexFiles.map(file => ({ ...file, patch: undefined })) : [...recorded, ...(pendingDetails ? [...new Set(eventDetail?.edited_files ?? [])]
      .filter(path => !known.has(relativeMessageFilePath(path, projectRoot)))
      .map(path => ({ path, added: null, removed: null, patch: undefined })) : [])]
    const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
    const parts = (path: string) => {
      const relative = relativeMessageFilePath(path, projectRoot).replace(/\\/g, '/')
      const separator = relative.lastIndexOf('/')
      return { directory: relative.slice(0, separator < 0 ? 0 : separator), name: relative.slice(separator + 1) }
    }
    return [...changes].sort((a, b) => {
      const left = parts(a.path)
      const right = parts(b.path)
      return collator.compare(left.directory, right.directory) || collator.compare(left.name, right.name)
    })
  }, [events, pendingDetails, eventDetail?.edited_files, projectRoot, indexFiles])
  const [open, setOpen] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [contextTarget, setContextTarget] = useState<FileContextTarget | null>(null)
  const dismissContext = useCallback(() => setContextTarget(null), [])
  const selected = files.find(file => file.path === selectedPath)
  const link = useMemo(() => classifyProjectFileLink(selected?.path, fileScope), [selected?.path, fileScope])
  const recordedDiff = useMemo<GitDiff | undefined>(() => selected?.patch && link ? {
    path: link.path, old_path: link.path, base: null, target: null,
    patch: selected.patch, before: '', after: '', binary: false, truncated: false, submodule: false,
  } : undefined, [selected, link])
  const loadRecordedDiff = useCallback(async (path: string): Promise<GitDiff> => {
    const cached = patches.current.get(path)
    if (cached) return cached
    const page = await loader.current?.({ fileChanges: true, path }) as FileChangesPage | undefined
    if (!page?.patch) throw new Error(t('git.noDiff'))
    const fileLink = classifyProjectFileLink(path, fileScope)
    const diff: GitDiff = { path: fileLink?.path || path, old_path: fileLink?.path || path,
      base: null, target: null, patch: page.patch, before: '', after: '', binary: false,
      truncated: false, submodule: false }
    patches.current.set(path, diff)
    return diff
  }, [fileScope, t])
  if (!files.length) return null
  const diffFiles = files.filter(file => (file.patch || ('has_patch' in file && file.has_patch)) && classifyProjectFileLink(file.path, fileScope))
  const title = t('trace.editedFiles', { count: files.length })
  const loadDetails = async () => {
    if (!pendingDetails || indexInFlight.current || !onLoadEventDetails) return
    indexInFlight.current = true
    setIndexLoading(true)
    setIndexError('')
    try {
      const page = await onLoadEventDetails({ fileChanges: true }) as FileChangesPage | undefined
      if (page) setIndexFiles(page.files)
    } catch (reason) {
      setIndexError(reason instanceof Error ? reason.message : String(reason))
    } finally { indexInFlight.current = false; setIndexLoading(false) }
  }
  return (
    <section className="message-file-changes" aria-label={title}>
      <div className="message-file-changes-header">
        <button type="button" className="message-file-changes-toggle chat-message-action"
          aria-expanded={open} onClick={() => {
            setOpen(value => !value)
            dismissContext()
            if (!open) loadDetails()
          }}>
          <Icon name="file" size={14} />
          <strong>{title}</strong>
          <Icon name="chevron-down" size={12} />
        </button>
        {fileScope && diffFiles.length > 0 && !pendingDetails && (
          <button type="button" className="message-file-changes-view chat-message-action"
            onClick={() => setSelectedPath(diffFiles[0].path)}>{t('trace.viewChanges')}</button>
        )}
      </div>
      {open && (
        <>
        {indexLoading && <StreamingStatusText label={t('trace.loadingDetails')} />}
        {indexError && (
          <button type="button" className="message-file-changes-error chat-message-action"
            onClick={() => { void loadDetails() }}>{indexError} · {t('git.retry')}</button>
        )}
        <ul className="message-file-changes-list">
          {(!pendingDetails || Boolean(eventDetail?.edited_files?.length)) && files.map(file => {
            const displayPath = relativeMessageFilePath(file.path, projectRoot)
            return (
            <li key={file.path} className="message-file-change-row" onContextMenu={event => {
              event.preventDefault()
              event.stopPropagation()
              const fileLink = classifyProjectFileLink(file.path, fileScope)
              setContextTarget({ path: fileLink?.path || file.path, name: fileLink?.name || displayPath.split(/[\\/]/).pop() || displayPath,
                x: event.clientX, y: event.clientY })
            }}>
              {classifyProjectFileLink(file.path, fileScope) ? (
                <button type="button" className="message-file-change-path chat-message-action"
                  disabled={pendingDetails}
                  title={displayPath} onClick={() => setSelectedPath(file.path)}>{displayPath}</button>
              ) : <span className="message-file-change-path" title={displayPath}>{displayPath}</span>}
              {file.added !== null && file.removed !== null && (
                <span className="message-file-change-stats" title={t('trace.editedLines')}>
                  <span className="message-file-change-added">+{file.added}</span>
                  <span className="message-file-change-removed">-{file.removed}</span>
                </span>
              )}
            </li>
          )})}
        </ul>
        </>
      )}
      <FileContextMenu target={contextTarget} projectId={projectId} projectRoot={projectRoot}
        localProject={Boolean(project && project.type !== 'remote')} onDismiss={dismissContext} />
      {selected && link && fileScope && !pendingDetails && (recordedDiff || ('has_patch' in selected && selected.has_patch) ? (
        <GitDiffDialog id={projectId || ''} files={diffFiles.map(file => file.path)} path={selected.path}
          comparison={{}} recordedDiff={recordedDiff} recordedDiffLoader={loadRecordedDiff}
          projectRoot={projectRoot} onSelect={setSelectedPath}
          onClose={() => setSelectedPath(null)} />
      ) : (
        <FilePreviewDialog projectId={projectId} path={link.path} name={link.name}
          onClose={() => setSelectedPath(null)} />
      ))}
    </section>
  )
}

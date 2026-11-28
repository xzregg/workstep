import { useGatewayProjectPermissions } from '../hooks/useGatewayProjectPermissions'
import PrototypeEditor from './prototype/PrototypeEditor'
/** Artifact Preview Component - shows file contents or a directory listing. */

import Icon from './Icon'
import OpenLocationButton from './OpenLocationButton'
import { useProjectStore } from '../stores/projectStore'
import { usesWebDirectoryBrowser } from '../utils/openLocation'
import { useState, useEffect, type ReactNode } from 'react'
import {
  fsApi,
  type FilePreview,
} from '../api/client'
import Button, { ButtonLink } from './Button'
import { useI18n } from '../i18n'
import MarkdownMessage from './MarkdownMessage'
import CodeFilePreview from './CodeFilePreview'
import { copyText } from '../utils/clipboard'
import { openFilePreviewWindow } from '../utils/filePreviewNavigation'
import { gatewayFetch, gatewayWorkspacePath } from '../utils/gatewayWorkspacePath'
import ProjectDirectoryBrowser from './ProjectDirectoryBrowser'
import { HTML_PREVIEW_SANDBOX, isolatedHtmlDocument, prepareFrame } from '../utils/htmlPreviewCompat'
import { webrtcWorkspacePath } from '../webrtc/webrtcLocation'
import { downloadWebRtcFile } from '../webrtc/downloadFile'
import { useTaskFilePreview } from '../contexts/MarkdownAssetUrlContext'
import { HtmlPreviewFrame } from './HtmlPreviewFrame'
import { useDirectResource } from '../webrtc/useDirectResource'
import { retryWebRtcTransfer } from '../webrtc/retryTransfer'

interface ArtifactPreviewProps {
  path: string
  name?: string
  line?: number
  isDir?: boolean
  onClose?: () => void
  projectId?: string
  standalone?: boolean
  onEdit?: () => void
  onOpenPrototype?: (path: string) => void
}

type PreviewView =
  | { kind: 'directory'; path: string }
  | { kind: 'file'; path: string }

function CopyTextButton({ content }: { content: string }) {
  const { t } = useI18n()
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  const copy = async () => {
    const ok = await copyText(content)
    setState(ok ? 'copied' : 'failed')
  }

  return (
    <Button
      variant="ghost"
      className="artifact-toolbar-icon-button"
      aria-label={state === 'copied' ? t('artifact.textCopied') : t('artifact.copyText')}
      title={state === 'copied' ? t('common.copied') : state === 'failed' ? t('meta.copyFailed') : t('artifact.copyText')}
      onClick={() => void copy()}
      style={{
        color: state === 'failed'
          ? 'var(--danger)'
          : state === 'copied'
            ? 'var(--success)'
            : 'var(--muted)',
      }}
    >
      {state === 'copied' ? (
        <Icon name="check" size={16} strokeWidth={2.4} />
      ) : (
        <Icon name="copy" size={16} strokeWidth={2} />
      )}
    </Button>
  )
}

function DownloadFileButton({ href, filename, direct = false, prominent = false, onError }: {
  href: string
  filename: string
  direct?: boolean
  prominent?: boolean
  onError?: (message: string) => void
}) {
  const { t } = useI18n()
  const [downloading, setDownloading] = useState(false)
  if (direct) return (
    <Button variant={prominent ? 'primary' : 'ghost'} size="sm" type="button" loading={downloading}
      className={prominent ? 'artifact-download-action' : 'artifact-download-button artifact-toolbar-icon-button'}
      aria-label={t('artifact.downloadFile')} title={t('artifact.downloadFile')}
      onClick={() => {
        if (downloading) return
        setDownloading(true)
        onError?.('')
        void downloadWebRtcFile(href, filename).catch((error: unknown) => {
          onError?.(t('artifact.loadFailed', { error: error instanceof Error ? error.message : String(error) }))
        }).finally(() => setDownloading(false))
      }}>
      <Icon name="download" size={16} strokeWidth={2} />
      {prominent && t('artifact.downloadFile')}
    </Button>
  )

  return (
    <ButtonLink variant="ghost" size="sm"
      className="artifact-download-button artifact-toolbar-icon-button"
      href={href}
      download={filename}
      aria-label={t('artifact.downloadFile')}
      title={t('artifact.downloadFile')}
    >
      <Icon name="download" size={16} strokeWidth={2} />
    </ButtonLink>
  )
}

function filenameFromPath(path: string) {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'download'
}

function previewWindowUrl(path: string, name: string, projectId: string, line?: number) {
  const params = new URLSearchParams({ path, name, project_id: projectId })
  if (line !== undefined) params.set('line', String(line))
  return `${gatewayWorkspacePath() || webrtcWorkspacePath()}/file-preview?${params.toString()}`
}

export default function ArtifactPreview({
  path,
  name,
  line,
  isDir = false,
  onClose,
  projectId,
  standalone = false,
  onEdit,
  onOpenPrototype,
}: ArtifactPreviewProps) {
  const { t } = useI18n()
  const taskFilePreview = useTaskFilePreview()
  const project = useProjectStore(state => state.projects.find(item => item.id === projectId)
    ?? (state.activeProject?.id === projectId ? state.activeProject : null))
  const canOpenDirectory = project && !gatewayWorkspacePath()
    && !window.location.pathname.startsWith('/share/')
    && !usesWebDirectoryBrowser(project.type, window.location.hostname, navigator.userAgent,
      Boolean(window.workstepDesktop?.directories))
  const [view, setView] = useState<PreviewView>(() =>
    isDir
      ? { kind: 'directory', path }
      : { kind: 'file', path }
  )
  const [showMarkdownSource, setShowMarkdownSource] = useState(false)
  const { can: canPrototype } = useGatewayProjectPermissions(projectId)
  const [prototypeOpen, setPrototypeOpen] = useState(false)
  const directWorkspace = webrtcWorkspacePath()
  const [downloadError, setDownloadError] = useState('')

  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const mediaPath = preview?.content_type === 'application/pdf' || preview?.type === 'audio' || preview?.type === 'video'
    ? (taskFilePreview ? taskFilePreview.rawUrl(view.path) : fsApi.previewFileUrl(view.path, projectId)) : ''
  const directMedia = useDirectResource(mediaPath)

  // Reset the view when the artifact changes.
  useEffect(() => {
    setView(isDir ? { kind: 'directory', path } : { kind: 'file', path })
  }, [path, isDir])

  useEffect(() => {
    setShowMarkdownSource(false)
    setDownloadError('')
  }, [path])

  // Load the file preview.
  useEffect(() => {
    if (view.kind !== 'file') return
    let active = true
    let imageUrl: string | undefined
    const controller = new AbortController()
    setPreviewLoading(true)
    setPreviewError(null)
    const loadPreview = taskFilePreview
      ? taskFilePreview.load(view.path)
      : fsApi.preview(view.path, projectId)
    loadPreview
      .then(async (data) => {
        if (active && directWorkspace && data.type === 'image' && !data.content) {
          const url = taskFilePreview ? taskFilePreview.rawUrl(view.path) : fsApi.previewFileUrl(view.path, projectId)
          const blob = await retryWebRtcTransfer(async()=>{
            const response = await gatewayFetch(url, { signal: controller.signal })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            if (Number(response.headers.get('content-length')) > 20 * 1024 * 1024) {
              await response.body?.cancel()
              throw new Error('HTTP 413')
            }
            return response.blob()
          },controller.signal)
          if (!active) return
          imageUrl = URL.createObjectURL(blob)
          setPreview({ ...data, content: imageUrl })
          return
        }
        if (active) setPreview(data)
      })
      .catch((e) => {
        if (active) {
          setPreviewError(e instanceof Error ? e.message : t('artifact.loadFallbackError'))
        }
      })
      .finally(() => {
        if (active) setPreviewLoading(false)
      })
    return () => {
      active = false
      controller.abort()
      if (imageUrl) URL.revokeObjectURL(imageUrl)
    }
  }, [view.kind, view.path, projectId, taskFilePreview, t, directWorkspace])

  const normalizedPath = view.path.replace(/\\/g, '/')
  const absolutePath = /^(?:[a-z]:\/|\/)/i.test(normalizedPath)
    ? normalizedPath : `${project?.path.replace(/\\/g, '/').replace(/\/$/, '')}/${normalizedPath}`
  const directoryPath = absolutePath.slice(0, absolutePath.lastIndexOf('/') + 1)
    .replace(/([^:])\/$/, '$1') || '/'

  const fileHeader = (label: string, extra?: ReactNode) => (
    <>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <div style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 500, color: 'var(--fg-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {canOpenDirectory && view.kind === 'file' && !previewLoading && !previewError && preview && (
          <OpenLocationButton activeProject={project} directoryPath={directoryPath} t={t} />
        )}
        {extra}
        {onClose && (
          <Button variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
        )}
      </div>
    </div>
    {downloadError && <p className="artifact-error" role="alert">{downloadError}</p>}
    </>
  )

  const fileFooter = (contentType: string, fileSize: number) => (
    <div style={{ marginTop: 8, fontSize: 'calc(13px * var(--font-scale))', color: 'var(--meta)' }}>
      {contentType} | {(fileSize / 1024).toFixed(2)} KB
    </div>
  )

  // ── Directory tree + file preview ──
  if (view.kind === 'directory') {
    return (
      <ProjectDirectoryBrowser projectId={projectId || ''} rootPath={view.path} />
    )
  }

  // ── File preview view ──
  if (previewLoading) {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', padding: 16 }}>
        {fileHeader(t('common.loading'))}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--meta)' }}>
          {t('common.loading')}
        </div>
      </div>
    )
  }

  if (previewError) {
    const fallbackUrl = taskFilePreview ? taskFilePreview.rawUrl(view.path) : directWorkspace
      ? fsApi.previewFileUrl(view.path, projectId) : projectId
      ? fsApi.projectFileUrl(view.path, projectId)
      : fsApi.fileUrl(view.path)
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', padding: 16 }}>
        {fileHeader(t('artifact.file'), !directWorkspace && (
          <DownloadFileButton href={fallbackUrl} filename={filenameFromPath(view.path)} />
        ))}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--danger)', gap: 12 }}>
          {t('artifact.loadFailed', { error: previewError })}
          {directWorkspace && <DownloadFileButton href={fallbackUrl} filename={filenameFromPath(view.path)} direct prominent onError={setDownloadError} />}
          {!directWorkspace && <ButtonLink variant="primary" size="sm" className="artifact-open-link" href={fallbackUrl} target="_blank" rel="noopener noreferrer">
            <Icon name="external-link" size={13} />
            {t('artifact.openFile')}
          </ButtonLink>}
          {onClose && (
            <Button variant="ghost" onClick={onClose}>
              {t('common.close')}
            </Button>
          )}
        </div>
      </div>
    )
  }

  if (!preview) {
    return null
  }

  const { type, content_type, content, file_size, extension = '' } = preview
  const isImage = type === 'image'
  const isText = type === 'text'
  const ext = extension.slice(1).toLowerCase()
  const isHtml = isText && ['html', 'htm'].includes(ext)
  const isMarkdown = isText && ['md', 'markdown'].includes(ext)
  const isCode = isText && !isHtml && !isMarkdown && [
    'bash', 'c', 'cc', 'cpp', 'css', 'go', 'h', 'hpp', 'java', 'js', 'jsx', 'json',
    'mjs', 'py', 'rb', 'rs', 'sh', 'sql', 'toml', 'ts', 'tsx', 'xml', 'yaml', 'yml', 'zsh',
  ].includes(ext)
  const rawUrl = taskFilePreview ? taskFilePreview.rawUrl(preview.relative_path || view.path) : directWorkspace
    ? fsApi.previewFileUrl(view.path, projectId) : projectId
    ? fsApi.projectFileUrl(preview.relative_path || view.path, projectId)
    : fsApi.fileUrl(view.path)
  const downloadButton = (
    <DownloadFileButton href={rawUrl} filename={filenameFromPath(preview.relative_path || view.path)} direct={!!directWorkspace} onError={setDownloadError} />
  )
  const editButton = isText && onEdit ? (
    <Button
      variant="ghost"
      className="artifact-toolbar-icon-button"
      aria-label={t('browser.editMode')}
      title={t('browser.editMode')}
      onClick={onEdit}
    >
      <Icon name="pencil" size={16} strokeWidth={2} />
    </Button>
  ) : null
  const openWindowButton = (projectId || taskFilePreview) && !(directWorkspace && standalone) ? (
    <Button
      variant="primary"
      className="artifact-open-window-button"
      onClick={() => {
        openFilePreviewWindow(
          taskFilePreview?.windowUrl
            ? taskFilePreview.windowUrl(view.path, name || filenameFromPath(view.path), line)
            : projectId
              ? previewWindowUrl(view.path, name || filenameFromPath(view.path), projectId, line)
              : taskFilePreview!.rawUrl(preview.relative_path || view.path),
        )
      }}
    >
      <Icon name="external-link" size={13} />
      {t('artifact.openWindow')}
    </Button>
  ) : null

  if (type === 'video' || type === 'audio') {
    return (
      <div className={`artifact-media-preview artifact-${type}-preview`}>
        {fileHeader(name || filenameFromPath(view.path), <>{downloadButton}{openWindowButton}</>)}
        {type === 'video' ? (
          <video className="artifact-video-player" src={directWorkspace ? directMedia : rawUrl} controls playsInline preload="metadata" />
        ) : (
          <div className="artifact-audio-content">
            <audio className="artifact-audio-player" src={directWorkspace ? directMedia : rawUrl} controls preload="metadata" />
          </div>
        )}
        {fileFooter(content_type, file_size)}
      </div>
    )
  }

  if (isImage) {
    return (
      <div className="artifact-image-preview" style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', padding: 16 }}>
        {fileHeader(t('artifact.imageAlt'), <>{downloadButton}{openWindowButton}</>)}
        <div style={{ flex: 1, overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface)', borderRadius: 8 }}>
          <img
            src={content}
            alt={t('artifact.imageAlt')}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
          />
        </div>
        {fileFooter(content_type, file_size)}
      </div>
    )
  }

  if (isHtml && prototypeOpen && projectId) return <PrototypeEditor projectId={projectId} path={view.path} onClose={() => setPrototypeOpen(false)} />

  if (isHtml) {
    const resourceUrl = preview.html_preview
      ? fsApi.htmlPreviewUrl(preview.html_preview, projectId) : undefined
    return (
      <div className="artifact-html-preview">
        {fileHeader(t('artifact.htmlFile'), (
          <>
            {projectId && canPrototype('file.edit') && !taskFilePreview && !window.location.pathname.startsWith('/share/') && <Button onClick={() => onOpenPrototype ? onOpenPrototype(view.path) : setPrototypeOpen(true)}>{t('prototype.title')}</Button>}
            {editButton}
            {downloadButton}
            <CopyTextButton content={content} />
            {openWindowButton}
          </>
        ))}
        <div className="artifact-html-frame-container">
          <HtmlPreviewFrame
            src={resourceUrl}
            srcDoc={resourceUrl ? undefined : isolatedHtmlDocument(content || '')}
            title={t('artifact.htmlFile')}
            sandbox={HTML_PREVIEW_SANDBOX}
            referrerPolicy="no-referrer"
            onLoad={(event) => prepareFrame(event.currentTarget)}
            className="artifact-html-frame"
          />
        </div>
      </div>
    )
  }

  if (content_type === 'application/pdf') {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', padding: 16 }}>
        {fileHeader(t('artifact.pdfFile'), (
          <>
            {downloadButton}
            {openWindowButton}
          </>
        ))}
        <iframe
          className="artifact-pdf-frame"
          src={directWorkspace ? directMedia : rawUrl}
          title={t('artifact.pdfFile')}
        />
        {fileFooter(content_type, file_size)}
      </div>
    )
  }

  if (isMarkdown) {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', padding: 16 }}>
        {fileHeader(t('artifact.markdownFile'), (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="artifact-markdown-mode-button"
              onClick={() => setShowMarkdownSource((current) => !current)}
            >
              <Icon name={showMarkdownSource ? 'eye' : 'file'} size={13} strokeWidth={1.9} />
              {showMarkdownSource ? t('artifact.viewRendered') : t('artifact.viewSource')}
            </Button>
            {editButton}
            {downloadButton}
            <CopyTextButton content={content} />
            {openWindowButton}
          </>
        ))}
        {showMarkdownSource ? (
          <div style={{ flex: 1, minHeight: 0 }}>
            <CodeFilePreview filename={view.path} content={content} line={line} />
          </div>
        ) : (
          <div className="artifact-markdown-preview" data-standalone={standalone ? 'true' : undefined}>
            <MarkdownMessage content={content} projectId={projectId} mermaidRenderDelayMs={0} />
          </div>
        )}
        {fileFooter(content_type, file_size)}
      </div>
    )
  }

  if (isCode) {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', padding: 16 }}>
        {fileHeader(t('artifact.codeFile', { extension }), (
          <>
            {editButton}
            {downloadButton}
            <CopyTextButton content={content} />
            {openWindowButton}
          </>
        ))}
        <div style={{ flex: 1, minHeight: 0 }}>
          <CodeFilePreview filename={view.path} content={content} line={line} />
        </div>
        {fileFooter(content_type, file_size)}
      </div>
    )
  }

  if (type === 'binary') {
    const filename = filenameFromPath(preview.relative_path || view.path)
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', padding: 16 }}>
        {fileHeader(t('artifact.file'), <>{!directWorkspace && downloadButton}{openWindowButton}</>)}
        <div className="artifact-binary-state">
          <span className="artifact-binary-icon" aria-hidden="true">
            <Icon name="file" size={24} strokeWidth={1.6} />
          </span>
          <strong>{t('artifact.cannotPreview')}</strong>
          <span>{content_type} · {(file_size / 1024).toFixed(2)} KB</span>
          {directWorkspace
            ? <DownloadFileButton href={rawUrl} filename={filename} direct prominent onError={setDownloadError} />
            : <ButtonLink variant="primary" size="sm" className="artifact-open-link" href={rawUrl} target="_blank" rel="noopener noreferrer">
                <Icon name="external-link" size={13} />
                {t('artifact.openFile')}
              </ButtonLink>}
        </div>
      </div>
    )
  }

  // Default text preview
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', padding: 16 }}>
      {fileHeader(t('artifact.textPreview', { name: extension || t('artifact.file') }), (
        <>
          {editButton}
          {downloadButton}
          <CopyTextButton content={content} />
          {openWindowButton}
        </>
      ))}
      <div style={{ flex: 1, overflow: 'auto', background: 'var(--surface)', borderRadius: 8, padding: 16 }}>
        <pre style={{ margin: 0, fontSize: 'calc(13px * var(--font-scale))', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {content}
        </pre>
      </div>
      {fileFooter(content_type, file_size)}
    </div>
  )
}

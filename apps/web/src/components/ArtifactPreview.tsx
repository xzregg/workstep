/** Artifact Preview Component - shows file contents or a directory listing. */

import Icon from './Icon'
import { useState, useEffect, type ReactNode } from 'react'
import {
  fsApi,
  type FilePreview,
} from '../api/client'
import Button from './Button'
import { useI18n } from '../i18n'
import MarkdownMessage from './MarkdownMessage'
import CodeFilePreview from './CodeFilePreview'
import { copyText } from '../utils/clipboard'
import ProjectDirectoryBrowser from './ProjectDirectoryBrowser'
import { prepareFrame } from '../utils/htmlPreviewCompat'
import { useTaskFilePreview } from '../contexts/MarkdownAssetUrlContext'

interface ArtifactPreviewProps {
  path: string
  name?: string
  line?: number
  isDir?: boolean
  onClose?: () => void
  projectId?: string
  standalone?: boolean
  onEdit?: () => void
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
      aria-label={state === 'copied' ? t('artifact.textCopied') : t('artifact.copyText')}
      title={state === 'copied' ? t('common.copied') : state === 'failed' ? t('meta.copyFailed') : t('artifact.copyText')}
      onClick={() => void copy()}
      style={{
        width: 28, height: 28, minWidth: 28, padding: 0,
        justifyContent: 'center',
        color: state === 'failed'
          ? 'var(--danger)'
          : state === 'copied'
            ? 'var(--success)'
            : 'var(--muted)',
      }}
    >
      {state === 'copied' ? (
        <Icon name="check" size={14} strokeWidth={2.4} />
      ) : (
        <Icon name="copy" size={13} strokeWidth={2} />
      )}
    </Button>
  )
}

function DownloadFileButton({ href, filename }: { href: string; filename: string }) {
  const { t } = useI18n()

  return (
    <a
      className="artifact-download-button"
      href={href}
      download={filename}
      aria-label={t('artifact.downloadFile')}
      title={t('artifact.downloadFile')}
    >
      <Icon name="download" size={14} strokeWidth={2} />
    </a>
  )
}

function filenameFromPath(path: string) {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'download'
}

function previewWindowUrl(path: string, name: string, projectId: string, line?: number) {
  const params = new URLSearchParams({ path, name, project_id: projectId })
  if (line !== undefined) params.set('line', String(line))
  return `/file-preview?${params.toString()}`
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
}: ArtifactPreviewProps) {
  const { t } = useI18n()
  const taskFilePreview = useTaskFilePreview()
  const [view, setView] = useState<PreviewView>(() =>
    isDir
      ? { kind: 'directory', path }
      : { kind: 'file', path }
  )
  const [showMarkdownSource, setShowMarkdownSource] = useState(false)

  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  // Reset the view when the artifact changes.
  useEffect(() => {
    setView(isDir ? { kind: 'directory', path } : { kind: 'file', path })
  }, [path, isDir])

  useEffect(() => {
    setShowMarkdownSource(false)
  }, [path])

  // Load the file preview.
  useEffect(() => {
    if (view.kind !== 'file') return
    let active = true
    setPreviewLoading(true)
    setPreviewError(null)
    const loadPreview = taskFilePreview
      ? taskFilePreview.load(view.path)
      : fsApi.preview(view.path, projectId)
    loadPreview
      .then((data) => {
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
    }
  }, [view, projectId, taskFilePreview, t])

  const fileHeader = (label: string, extra?: ReactNode) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <div style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 500, color: 'var(--fg-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {extra}
        {onClose && (
          <Button variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
        )}
      </div>
    </div>
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
    const fallbackUrl = taskFilePreview ? taskFilePreview.rawUrl(view.path) : projectId
      ? fsApi.projectFileUrl(view.path, projectId)
      : fsApi.fileUrl(view.path)
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', padding: 16 }}>
        {fileHeader(t('artifact.file'), (
          <DownloadFileButton href={fallbackUrl} filename={filenameFromPath(view.path)} />
        ))}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--danger)', gap: 12 }}>
          {t('artifact.loadFailed', { error: previewError })}
          <a className="artifact-open-link" href={fallbackUrl} target="_blank" rel="noopener noreferrer">
            <Icon name="external-link" size={13} />
            {t('artifact.openFile')}
          </a>
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
  const rawUrl = taskFilePreview ? taskFilePreview.rawUrl(preview.relative_path || view.path) : projectId
    ? fsApi.projectFileUrl(preview.relative_path || view.path, projectId)
    : fsApi.fileUrl(view.path)
  const downloadButton = (
    <DownloadFileButton href={rawUrl} filename={filenameFromPath(preview.relative_path || view.path)} />
  )
  const editButton = isText && onEdit ? (
    <Button
      variant="ghost"
      aria-label={t('browser.editMode')}
      title={t('browser.editMode')}
      onClick={onEdit}
      style={{ width: 28, height: 28, minWidth: 28, padding: 0, justifyContent: 'center' }}
    >
      <Icon name="pencil" size={14} strokeWidth={2} />
    </Button>
  ) : null
  const openWindowButton = projectId || taskFilePreview ? (
    <Button
      variant="primary"
      className="artifact-open-window-button"
      onClick={() => {
        window.open(
          taskFilePreview
            ? taskFilePreview.rawUrl(preview.relative_path || view.path)
            : previewWindowUrl(view.path, name || filenameFromPath(view.path), projectId!, line),
          '_blank',
          'noopener,noreferrer',
        )
      }}
    >
      <Icon name="external-link" size={13} />
      {t('artifact.openWindow')}
    </Button>
  ) : null

  if (isImage) {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', padding: 16 }}>
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

  if (isHtml) {
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', padding: 16 }}>
        {fileHeader(t('artifact.htmlFile'), (
          <>
            {editButton}
            {downloadButton}
            <CopyTextButton content={content} />
            {openWindowButton}
          </>
        ))}
        <div style={{
          flex: 1, minHeight: 0, borderRadius: 8, overflow: 'hidden',
          border: '1px solid var(--border-soft)', background: '#fff',
          display: 'flex', flexDirection: 'column',
        }}>
          <iframe
            src={rawUrl}
            title={t('artifact.htmlFile')}
            sandbox="allow-scripts allow-same-origin allow-popups"
            onLoad={(event) => prepareFrame(event.currentTarget)}
            style={{ flex: 1, minHeight: 0, width: '100%', border: 'none', background: '#fff', display: 'block' }}
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
          src={rawUrl}
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
    return (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', padding: 16 }}>
        {fileHeader(t('artifact.file'), <>{downloadButton}{openWindowButton}</>)}
        <div className="artifact-binary-state">
          <span className="artifact-binary-icon" aria-hidden="true">
            <Icon name="file" size={24} strokeWidth={1.6} />
          </span>
          <strong>{t('artifact.cannotPreview')}</strong>
          <span>{content_type} · {(file_size / 1024).toFixed(2)} KB</span>
          <a className="artifact-open-link" href={rawUrl} target="_blank" rel="noopener noreferrer">
            <Icon name="external-link" size={13} />
            {t('artifact.openFile')}
          </a>
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

import { useEffect, useRef, useState } from 'react'
import { fsApi } from '../api/client'
import { useI18n } from '../i18n'
import { formatMarkdownAttachment } from '../utils/markdownAttachment'
import Icon from './Icon'
import MarkdownMessage from './MarkdownMessage'
import Textarea from './Textarea'

interface MarkdownEditorProps {
  value: string
  onChange: (value: string) => void
  /** Project id — used to upload attachments and preview `.workstep/uploads/...` paths. */
  projectId?: string
  /** Short id prefix added to uploaded filenames for later cleanup. */
  imagePrefix?: string
  placeholder?: string
  minHeight?: number | string
  maxHeight?: number | string
  disabled?: boolean
  autoFocus?: boolean
  ariaLabel?: string
  maxLength?: number
  /** Show the compact paste/drop capability hint above the editor. */
  showAttachmentHint?: boolean
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

/** Shared compact Markdown editor with attachment upload and preview. */
export default function MarkdownEditor({
  value,
  onChange,
  projectId,
  imagePrefix,
  placeholder,
  minHeight = 160,
  maxHeight = '45vh',
  disabled = false,
  autoFocus = false,
  ariaLabel,
  maxLength,
  showAttachmentHint = false,
}: MarkdownEditorProps) {
  const { t } = useI18n()
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [dragActive, setDragActive] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [expanded, setExpanded] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const valueRef = useRef(value)

  useEffect(() => {
    valueRef.current = value
  }, [value])

  const replaceValue = (next: string, cursor?: number) => {
    valueRef.current = next
    onChange(next)
    if (cursor !== undefined) {
      requestAnimationFrame(() => {
        textareaRef.current?.focus()
        textareaRef.current?.setSelectionRange(cursor, cursor)
      })
    }
  }

  const insertAtCursor = (snippet: string) => {
    const current = valueRef.current
    const textarea = textareaRef.current
    const start = textarea?.selectionStart ?? current.length
    const end = textarea?.selectionEnd ?? current.length
    const separator = start > 0 && current[start - 1] !== '\n' ? '\n' : ''
    const inserted = `${separator}${snippet}`
    replaceValue(current.slice(0, start) + inserted + current.slice(end), start + inserted.length)
    return { marker: snippet, cursor: start + separator.length }
  }

  const replaceUploadMarker = (marker: string, replacement: string, cursor: number) => {
    const current = valueRef.current
    const markerIndex = current.indexOf(marker, cursor)
    if (markerIndex < 0) return
    replaceValue(
      current.slice(0, markerIndex) + replacement + current.slice(markerIndex + marker.length),
      markerIndex + replacement.length,
    )
  }

  const handleAttachment = async (file: File) => {
    if (!projectId || uploading || disabled) return
    setUploadError('')
    setUploading(true)
    const marker = `[${t('md.uploading')} ${file.name}]`
    const insertion = insertAtCursor(marker)
    try {
      const uploaded = file.type.startsWith('image/')
        ? await fsApi.uploadImage(file, projectId, imagePrefix)
        : await fsApi.uploadFile(file, projectId, imagePrefix)
      replaceUploadMarker(
        insertion.marker,
        formatMarkdownAttachment(file, uploaded.url),
        insertion.cursor,
      )
    } catch {
      if (file.type.startsWith('image/')) {
        try {
          const dataUrl = await readAsDataUrl(file)
          replaceUploadMarker(
            insertion.marker,
            formatMarkdownAttachment(file, dataUrl),
            insertion.cursor,
          )
          return
        } catch {
          // Fall through to the shared error state.
        }
      }
      replaceUploadMarker(insertion.marker, '', insertion.cursor)
      setUploadError(t('md.uploadFailed'))
    } finally {
      setUploading(false)
    }
  }

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const fileItem = Array.from(event.clipboardData?.items || [])
      .find((item) => item.kind === 'file')
    const file = fileItem?.getAsFile()
    if (!file || !projectId) return
    event.preventDefault()
    void handleAttachment(file)
  }

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!projectId || disabled) return
    const file = event.dataTransfer.files?.[0]
    if (!file) return
    event.preventDefault()
    setDragActive(false)
    void handleAttachment(file)
  }

  const capabilityText = dragActive
    ? t('md.dropHint')
    : uploading
      ? t('md.uploading')
      : t('md.attachmentHint')

  return (
    <div className="markdown-editor-root">
      {showAttachmentHint && (
        <span className="markdown-editor-capability-hint" aria-live="polite">
          {capabilityText}
        </span>
      )}
      <div
        className="markdown-editor-shell"
        data-dragging={dragActive}
        onDragEnter={(event) => {
          if (!projectId || disabled) return
          event.preventDefault()
          setDragActive(true)
        }}
        onDragOver={(event) => {
          if (!projectId || disabled) return
          event.preventDefault()
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDragActive(false)
          }
        }}
        onDrop={handleDrop}
      >
        {mode === 'edit' ? (
          <Textarea
            ref={textareaRef}
            className="markdown-editor-input"
            aria-label={ariaLabel ?? t('md.ariaLabel')}
            value={value}
            maxLength={maxLength}
            disabled={disabled}
            onChange={(event) => {
              valueRef.current = event.target.value
              onChange(event.target.value)
            }}
            onPaste={handlePaste}
            placeholder={placeholder ?? t('md.placeholder')}
            autoFocus={autoFocus}
            style={{ minHeight, maxHeight, height: expanded ? maxHeight : undefined }}
          />
        ) : (
          <div className="markdown-editor-preview" style={{ minHeight, maxHeight, height: expanded ? maxHeight : undefined }}>
            {value.trim()
              ? <MarkdownMessage content={value} projectId={projectId} />
              : <span className="markdown-editor-empty">{t('md.empty')}</span>}
          </div>
        )}

        <div className="markdown-editor-actions">
          <input
            ref={fileInputRef}
            type="file"
            hidden
            disabled={!projectId || disabled || uploading}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void handleAttachment(file)
              event.target.value = ''
            }}
          />
          <button
            type="button"
            className="markdown-editor-action"
            disabled={!projectId || disabled || uploading}
            aria-label={t('md.uploadAttachment')}
            title={projectId ? t('md.uploadAttachment') : t('md.needProject')}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading
              ? <span className="task-status-spinner" aria-hidden="true" />
              : <Icon name="paperclip" size={14} strokeWidth={1.8} />}
          </button>
          <button
            type="button"
            className="markdown-editor-action"
            data-active={mode === 'preview'}
            disabled={disabled}
            aria-label={mode === 'edit' ? t('md.previewAria') : t('md.editAria')}
            title={mode === 'edit' ? t('md.previewAria') : t('md.editAria')}
            onClick={() => setMode((current) => current === 'edit' ? 'preview' : 'edit')}
          >
            <Icon name="eye" size={14} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className="markdown-editor-action"
            data-testid="markdown-editor-size-toggle"
            aria-label={t(expanded ? 'md.restoreEditor' : 'md.expandEditor')}
            title={t(expanded ? 'md.restoreEditor' : 'md.expandEditor')}
            aria-pressed={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            <Icon name={expanded ? 'minimize-2' : 'maximize-2'} size={14} strokeWidth={1.8} />
          </button>
        </div>

        {dragActive && (
          <div className="markdown-editor-drop-overlay">{t('md.dropHint')}</div>
        )}
      </div>
      {uploadError && <div className="markdown-editor-error" role="alert">{uploadError}</div>}
    </div>
  )
}

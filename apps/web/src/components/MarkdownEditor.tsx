import { useGatewayProjectPermissions } from '../hooks/useGatewayProjectPermissions'
import { useEffect, useRef, useState } from 'react'
import { fsApi } from '../api/client'
import { useI18n, localizeErrorDisplay } from '../i18n'
import { formatMarkdownAttachment } from '../utils/markdownAttachment'
import Icon from './Icon'
import MarkdownPreviewEditor from './MarkdownPreviewEditor'
import Textarea from './Textarea'

interface MarkdownEditorProps {
  /** Input id for a surrounding Field label. */
  id?: string
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
  readOnly?: boolean
  autoFocus?: boolean
  ariaLabel?: string
  maxLength?: number
  /** Show the compact paste/drop capability hint above the editor. */
  showAttachmentHint?: boolean
  /** Prompt assets can opt out of project-scoped attachment upload. */
  allowAttachments?: boolean
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
  id,
  value,
  onChange,
  projectId,
  imagePrefix,
  placeholder,
  minHeight = 160,
  maxHeight = '45vh',
  disabled = false,
  readOnly = false,
  autoFocus = false,
  ariaLabel,
  maxLength,
  showAttachmentHint = false,
  allowAttachments = true,
}: MarkdownEditorProps) {
  const { t } = useI18n()
  const { can } = useGatewayProjectPermissions(projectId)
  const canUpload = allowAttachments && !readOnly && can('file.upload')
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [dragActive, setDragActive] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [expanded, setExpanded] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
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

  const replaceUploadMarker = (marker: string, replacement: string, cursor: number, fromImagePicker: boolean) => {
    const current = valueRef.current
    const markerIndex = current.indexOf(marker, cursor)
    if (markerIndex < 0) return
    const trailing = current.slice(markerIndex + marker.length)
    const separator = fromImagePicker && replacement && trailing && !trailing.startsWith('\n') ? '\n' : ''
    replaceValue(
      current.slice(0, markerIndex) + replacement + separator + trailing,
      markerIndex + replacement.length,
    )
  }

  const handleAttachments = async (files: File[], fromImagePicker = false) => {
    if (!files.length || !projectId || uploading || disabled || !canUpload) return
    setUploadError('')
    setUploading(true)
    const names = files.map(file => file.name).join(', ')
    const marker = `[${t('md.uploading')} ${names}]`
    const insertion = insertAtCursor(marker)
    const attachments: string[] = []
    try {
      for (const file of files) {
        const isImage = file.type.startsWith('image/')
        try {
          const uploaded = isImage
            ? await fsApi.uploadImage(file, projectId, imagePrefix)
            : await fsApi.uploadFile(file, projectId, imagePrefix)
          attachments.push(formatMarkdownAttachment(file, uploaded.url))
        } catch {
          if (isImage) {
            try {
              const dataUrl = await readAsDataUrl(file)
              attachments.push(formatMarkdownAttachment(file, dataUrl))
              continue
            } catch {
              // Fall through to the shared error state.
            }
          }
          setUploadError(t('md.uploadFailed'))
        }
      }
      replaceUploadMarker(insertion.marker, attachments.join('\n'), insertion.cursor, fromImagePicker)
    } finally {
      setUploading(false)
    }
  }

  const handleFileSelection = (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const files = Array.from(input.files ?? [])
    input.value = ''
    const fromImagePicker = input === imageInputRef.current
    void handleAttachments(
      fromImagePicker ? files.filter(file => file.type.startsWith('image/')) : files,
      fromImagePicker,
    )
  }

  const handlePaste = (event: React.ClipboardEvent<HTMLElement>) => {
    const fileItem = Array.from(event.clipboardData?.items || [])
      .find((item) => item.kind === 'file')
    const file = fileItem?.getAsFile()
    if (!file || !projectId) return
    event.preventDefault()
    void handleAttachments([file])
  }

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!projectId || disabled) return
    const file = event.dataTransfer.files?.[0]
    if (!file) return
    event.preventDefault()
    setDragActive(false)
    void handleAttachments([file])
  }

  const uploadDisabled = !projectId || disabled || uploading
  const capabilityText = dragActive
    ? t('md.dropHint')
    : uploading
      ? t('md.uploading')
      : t('md.attachmentHint')

  return (
    <div className="markdown-editor-root">
      {canUpload && showAttachmentHint && (
        <span className="markdown-editor-capability-hint" aria-live="polite">
          {capabilityText}
        </span>
      )}
      <div
        className="markdown-editor-shell"
        data-dragging={dragActive}
        data-expanded={expanded}
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
            id={id}
            ref={textareaRef}
            className="markdown-editor-input"
            readOnly={readOnly}
            aria-label={ariaLabel ?? (id ? undefined : t('md.ariaLabel'))}
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
            <MarkdownPreviewEditor id={id} value={value} onChange={next => replaceValue(next)}
              projectId={projectId} readOnly={readOnly || disabled} maxLength={maxLength}
              label={ariaLabel ?? t('md.ariaLabel')} onPaste={handlePaste} />
          </div>
        )}

        <div className="markdown-editor-actions">
          {canUpload && <input
            ref={fileInputRef}
            type="file"
            hidden
            disabled={uploadDisabled}
            onChange={handleFileSelection}
          />}
          {canUpload && <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            disabled={uploadDisabled}
            onChange={handleFileSelection}
          />}
          {canUpload && <button
            type="button"
            className="markdown-editor-action"
            disabled={uploadDisabled}
            aria-label={t('chatInput.attachImage')}
            title={projectId ? t('chatInput.attachImage') : t('md.needProject')}
            onClick={() => imageInputRef.current?.click()}
          >
            <Icon name="image" size={14} strokeWidth={1.8} />
          </button>}
          {canUpload && <button
            type="button"
            className="markdown-editor-action"
            disabled={uploadDisabled}
            aria-label={t('md.uploadAttachment')}
            title={projectId ? t('md.uploadAttachment') : t('md.needProject')}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading
              ? <span className="task-status-spinner" aria-hidden="true" />
              : <Icon name="paperclip" size={14} strokeWidth={1.8} />}
          </button>}
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
      {uploadError && <div className="markdown-editor-error" role="alert">{localizeErrorDisplay(uploadError)}</div>}
    </div>
  )
}

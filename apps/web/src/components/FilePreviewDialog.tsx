import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import ArtifactPreview from './ArtifactPreview'
import Button from './Button'
import Icon from './Icon'
import { useI18n } from '../i18n'

interface FilePreviewDialogProps {
  path: string
  name: string
  projectId: string
  onClose: () => void
}

export default function FilePreviewDialog({ path, name, projectId, onClose }: FilePreviewDialogProps) {
  const { t } = useI18n()
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab') return
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], iframe, [tabindex]:not([tabindex="-1"])',
      ) ?? [])
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable.at(-1) as HTMLElement
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('keydown', handleKey)
      document.body.style.overflow = previousOverflow
      previous?.focus()
    }
  }, [onClose])

  return createPortal(
    <div
      className="file-preview-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        ref={dialogRef}
        className="file-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-preview-title"
      >
        <header className="file-preview-dialog-header">
          <span className="file-preview-dialog-icon" aria-hidden="true">
            <Icon name="file" size={15} strokeWidth={1.8} />
          </span>
          <div className="file-preview-dialog-heading">
            <strong id="file-preview-title">{name}</strong>
            <span title={path}>{path}</span>
          </div>
          <Button
            ref={closeRef}
            variant="icon"
            className="file-preview-dialog-close"
            title={t('common.close')}
            aria-label={t('common.close')}
            onClick={onClose}
            style={{ width: 30, height: 30, minWidth: 30, padding: 0 }}
          >
            <Icon name="x" size={15} strokeWidth={2} />
          </Button>
        </header>
        <div className="file-preview-dialog-body">
          <ArtifactPreview path={path} projectId={projectId} />
        </div>
      </section>
    </div>,
    document.body,
  )
}

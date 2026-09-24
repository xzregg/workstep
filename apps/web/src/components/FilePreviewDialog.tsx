import { useCompactLayout } from '../hooks/useCompactLayout'
import { useOverlay } from '../hooks/useOverlay'
import { useRef } from 'react'
import { createPortal } from 'react-dom'
import ArtifactPreview from './ArtifactPreview'
import Button from './Button'
import Icon from './Icon'
import ResizablePanel from './ResizablePanel'
import { useI18n } from '../i18n'

interface FilePreviewDialogProps {
  path: string
  name: string
  line?: number
  projectId?: string
  onClose: () => void
}

export default function FilePreviewDialog({
  path,
  name,
  line,
  projectId,
  onClose,
}: FilePreviewDialogProps) {
  const { t } = useI18n()
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const compact = useCompactLayout()
  useOverlay(true, onClose, dialogRef, compact)

  return createPortal(
    <div
      className="file-preview-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <ResizablePanel
        ref={dialogRef}
        className="file-preview-dialog"
        minWidth={520}
        minHeight={320}
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-preview-title"
      >
        <header className="file-preview-dialog-header">
          <span className="file-preview-dialog-icon" aria-hidden="true">
            <Icon name="file" size={15} strokeWidth={1.8} />
          </span>
          <div className="file-preview-dialog-heading">
            <strong id="file-preview-title" data-dialog-selectable-text>{name}</strong>
            <span title={path} data-dialog-selectable-text>{path}</span>
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
          <ArtifactPreview
            path={path}
            name={name}
            line={line}
            projectId={projectId}
          />
        </div>
      </ResizablePanel>
    </div>,
    document.body,
  )
}

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../i18n'
import Icon from './Icon'

const MIN_ZOOM = 0.5
const MAX_ZOOM = 3
const ZOOM_STEP = 0.25

interface MermaidPreviewDialogProps {
  svg: string
  onClose: () => void
}

export default function MermaidPreviewDialog({ svg, onClose }: MermaidPreviewDialogProps) {
  const { t } = useI18n()
  const [zoom, setZoom] = useState(1)

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  return createPortal(
    <div
      className="mermaid-preview"
      role="dialog"
      aria-modal="true"
      aria-label={t('md.mermaidPreview')}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="mermaid-preview__toolbar" aria-label={t('md.mermaidZoomControls')}>
        <button
          type="button"
          data-testid="mermaid-preview-zoom-out"
          aria-label={t('md.mermaidZoomOut')}
          title={t('md.mermaidZoomOut')}
          disabled={zoom <= MIN_ZOOM}
          onClick={() => setZoom((value) => Math.max(MIN_ZOOM, value - ZOOM_STEP))}
        >
          <Icon name="minus" size={15} />
        </button>
        <button
          type="button"
          className="mermaid-preview__zoom-level"
          data-testid="mermaid-preview-zoom-level"
          aria-label={t('md.mermaidZoomReset')}
          title={t('md.mermaidZoomReset')}
          onClick={() => setZoom(1)}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          data-testid="mermaid-preview-zoom-in"
          aria-label={t('md.mermaidZoomIn')}
          title={t('md.mermaidZoomIn')}
          disabled={zoom >= MAX_ZOOM}
          onClick={() => setZoom((value) => Math.min(MAX_ZOOM, value + ZOOM_STEP))}
        >
          <Icon name="plus" size={15} />
        </button>
        <button
          type="button"
          aria-label={t('common.close')}
          title={t('common.close')}
          onClick={onClose}
        >
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="mermaid-preview__viewport">
        <div
          className="mermaid-preview__canvas"
          style={{ width: `${zoom * 100}%` }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>,
    document.body,
  )
}

import { useEffect } from 'react'
import Icon from './Icon'
import { resolveMarkdownImageSrc } from '../utils/markdownImages'
import { useI18n } from '../i18n'

/* ══════════════════════════════════════════
   ImagePreview — shared full-screen image
   preview (dark overlay + enlarged image +
   close button; Esc or backdrop click closes
   it). Used by the composer attach chips, the
   user message bubbles and the prompt viewer
   so every image click shows the same effect.
   ══════════════════════════════════════════ */

export interface ImagePreviewProps {
  /** Image source as stored (raw relative path or absolute URL). */
  src: string
  alt?: string
  /** Project id used to resolve `.workstep/uploads/...` relative paths. */
  projectId?: string
  onClose: () => void
}

export default function ImagePreview({ src, alt, projectId, onClose }: ImagePreviewProps) {
  const { t } = useI18n()
  const resolved = resolveMarkdownImageSrc(src, projectId)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="image-preview"
      role="dialog"
      aria-modal="true"
      aria-label={`${t('md.preview')}：${alt || t('md.image')}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <button
        type="button"
        className="image-preview-close"
        aria-label={t('common.close')}
        title={t('common.close')}
        onClick={onClose}
      >
        <Icon name="x" size={16} strokeWidth={2} />
      </button>
      <img src={resolved} alt={alt || t('md.image')} />
    </div>
  )
}

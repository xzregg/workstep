import { useState } from 'react'
import Button from './Button'
import ImagePreview from './ImagePreview'
import MarkdownMessage from './MarkdownMessage'
import { useI18n } from '../i18n'

/* ══════════════════════════════════════════
   PromptViewerDialog — shared "view prompt"
   modal. Renders the full prompt sent to the
   LLM as markdown and resolves project
   relative image paths (.workstep/uploads/…)
   via MarkdownMessage's projectId, so images
   attached to the prompt display correctly.
   Prompt images are clickable (same shared
   ImagePreview as the composer / user
   message thumbnails). Used by the task
   detail page and the assistant chat panels
   so the two never drift.
   ══════════════════════════════════════════ */

export interface PromptViewerDialogProps {
  prompt: string
  /** Project id used to resolve `.workstep/uploads/...` image paths. */
  projectId?: string
  title?: string
  closeLabel?: string
  zIndex?: number
  onClose: () => void
}

export default function PromptViewerDialog({
  prompt,
  projectId,
  title,
  closeLabel,
  zIndex = 1350,
  onClose,
}: PromptViewerDialogProps) {
  const { t } = useI18n()
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null)
  const dialogTitle = title ?? t('aiFlow.fullPrompt')
  const closeText = closeLabel ?? t('aiFlow.closePrompt')

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={dialogTitle}
      style={{
        position: 'fixed', inset: 0, zIndex,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 'min(860px, 92vw)', maxHeight: '84vh',
          background: 'var(--bg)', borderRadius: 12,
          boxShadow: '0 18px 48px rgba(0,0,0,0.24)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <strong style={{ flex: 1, fontSize: 'calc(13px * var(--font-scale))' }}>{dialogTitle}</strong>
          <Button variant="icon" aria-label={closeText} onClick={onClose}>✕</Button>
        </div>
        <div style={{ padding: 18, overflow: 'auto', fontSize: 'calc(13px * var(--font-scale))', lineHeight: 1.65 }}>
          {/* Images thumbnail exactly like user chat messages (.user-message-markdown). */}
          <MarkdownMessage
            content={prompt}
            projectId={projectId}
            className="prompt-viewer-markdown"
            onImageClick={(src, alt) => setPreviewImage({ src, alt })}
          />
        </div>
      </div>
      {previewImage && (
        <ImagePreview
          src={previewImage.src}
          alt={previewImage.alt}
          projectId={projectId}
          onClose={() => setPreviewImage(null)}
        />
      )}
    </div>
  )
}

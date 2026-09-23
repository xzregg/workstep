import ResizablePanel from './ResizablePanel'
import { useCompactLayout } from '../hooks/useCompactLayout'
import { useOverlay } from '../hooks/useOverlay'
import { useRef, type ReactNode } from 'react'
import Button from './Button'
import { useI18n } from '../i18n'

interface Props {
  open: boolean
  title: string
  message?: string
  confirmText?: string
  cancelText?: string
  secondaryText?: string
  danger?: boolean
  /** Optional body content rendered below the message (e.g. forms). */
  children?: ReactNode
  /** Disable the confirm button while an async action is in flight. */
  loading?: boolean
  /** Disable confirmation until the dialog content is valid. */
  confirmDisabled?: boolean
  secondaryLoading?: boolean
  secondaryDisabled?: boolean
  /** Override the default dialog width (px). */
  width?: number
  zIndex?: number
  onConfirm: () => void
  onSecondary?: () => void
  onCancel: () => void
}

export default function ConfirmDialog({ open, title, message, confirmText, cancelText, secondaryText, danger, children, loading, confirmDisabled, secondaryLoading, secondaryDisabled, width = 380, zIndex = 2000, onConfirm, onSecondary, onCancel }: Props) {
  const { t } = useI18n()
  const compact = useCompactLayout()
  const dialogRef = useRef<HTMLDivElement>(null)
  useOverlay(open, onCancel, dialogRef, compact)

  if (!open) return null

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex,
        background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16, boxSizing: 'border-box',
      }}
    >
      <ResizablePanel
        ref={dialogRef} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg)', borderRadius: 'var(--radius-md)',
          boxShadow: 'var(--elev-raised), 0 0 0 1px var(--border-soft)',
          width, maxWidth: '100%', maxHeight: 'calc(100dvh - 32px)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div data-dialog-drag-handle style={{ flexShrink: 0, padding: '16px 20px 0' }}>
          <div style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600, fontFamily: 'var(--font-display)', color: 'var(--fg)' }}>
            {title}
          </div>
          {message && (
            <div style={{ fontSize: 'calc(13px * var(--font-scale))', color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>
              {message}
            </div>
          )}
        </div>

        {children && (
          <div
            data-confirm-dialog-body="true"
            style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '0 20px' }}
          >
            {children}
          </div>
        )}

        {/* Footer */}
        <div style={{ flexShrink: 0, padding: '16px 20px', display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <Button variant="ghost" onClick={onCancel}>{cancelText ?? t('common.cancel')}</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            loading={loading}
            disabled={confirmDisabled}
            onClick={onConfirm}
            style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 500, padding: '6px 16px' }}
          >
            {confirmText ?? t('common.confirm')}
          </Button>
          {secondaryText && onSecondary && (
            <Button
              variant="ghost"
              loading={secondaryLoading}
              disabled={secondaryDisabled}
              onClick={onSecondary}
            >
              {secondaryText}
            </Button>
          )}
        </div>
      </ResizablePanel>
    </div>
  )
}

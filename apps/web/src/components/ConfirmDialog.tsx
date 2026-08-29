import { useEffect, type ReactNode } from 'react'
import Button from './Button'
import { useI18n } from '../i18n'

interface Props {
  open: boolean
  title: string
  message?: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
  /** Optional body content rendered below the message (e.g. forms). */
  children?: ReactNode
  /** Disable the confirm button while an async action is in flight. */
  loading?: boolean
  /** Override the default dialog width (px). */
  width?: number
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({ open, title, message, confirmText, cancelText, danger, children, loading, width = 380, onConfirm, onCancel }: Props) {
  const { t } = useI18n()
  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onCancel])

  if (!open) return null

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 2000,
        background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg)', borderRadius: 'var(--radius-md)',
          boxShadow: 'var(--elev-raised), 0 0 0 1px var(--border-soft)',
          width, maxWidth: '92vw', overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{ padding: '16px 20px 0' }}>
          <div style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 600, fontFamily: 'var(--font-display)', color: 'var(--fg)' }}>
            {title}
          </div>
          {message && (
            <div style={{ fontSize: 'calc(13px * var(--font-scale))', color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>
              {message}
            </div>
          )}
          {children}
        </div>

        {/* Footer */}
        <div style={{ padding: '16px 20px', display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <Button variant="ghost" onClick={onCancel}>{cancelText ?? t('common.cancel')}</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            loading={loading}
            onClick={onConfirm}
            style={{ fontSize: 'calc(13px * var(--font-scale))', fontWeight: 500, padding: '6px 16px' }}
          >
            {confirmText ?? t('common.confirm')}
          </Button>
        </div>
      </div>
    </div>
  )
}

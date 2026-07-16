import { useEffect } from 'react'

interface Props {
  open: boolean
  title: string
  message?: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({ open, title, message, confirmText = '确认', cancelText = '取消', danger, onConfirm, onCancel }: Props) {
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
          width: 380, overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{ padding: '16px 20px 0' }}>
          <div style={{ fontSize: 15, fontWeight: 600, fontFamily: 'var(--font-display)', color: 'var(--fg)' }}>
            {title}
          </div>
          {message && (
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>
              {message}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '16px 20px', display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button className="btn-ghost" onClick={onCancel}>{cancelText}</button>
          <button
            onClick={onConfirm}
            style={{
              fontSize: 13, fontWeight: 500, padding: '6px 16px',
              borderRadius: 'var(--radius-sm)', border: 'none', cursor: 'pointer',
              background: danger ? 'var(--danger)' : 'var(--accent)',
              color: '#fff',
            }}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

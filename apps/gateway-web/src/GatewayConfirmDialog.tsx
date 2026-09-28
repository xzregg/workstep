import type { ReactNode } from 'react'

export function GatewayConfirmDialog({ title, message, confirmLabel = '确认', busy = false,
  disabled = false, children, onConfirm, onCancel }: {
  title: string; message: string; confirmLabel?: string; busy?: boolean; disabled?: boolean
  children?: ReactNode; onConfirm: () => void; onCancel: () => void
}) {
  return <div className="gateway-dialog-backdrop">
    <div className="gateway-confirm-dialog" role="dialog" aria-modal="true" aria-label={title}>
      <h3>{title}</h3>
      <p>{message}</p>
      {children}
      <div className="gateway-dialog-actions">
        <button type="button" className="gateway-dialog-cancel" disabled={busy} onClick={onCancel}>取消</button>
        <button type="button" disabled={busy || disabled} onClick={onConfirm}>{busy ? '处理中…' : confirmLabel}</button>
      </div>
    </div>
  </div>
}

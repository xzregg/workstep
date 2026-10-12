import type { ReactNode } from 'react'
import { useGatewayModal } from './useGatewayModal'

export function GatewayConfirmDialog({ title, message, confirmLabel = '确认', cancelLabel = '取消', busy = false,
  disabled = false, children, onConfirm, onCancel, className = '' }: {
  title: string; message: string; confirmLabel?: string; cancelLabel?: string; busy?: boolean; disabled?: boolean
  children?: ReactNode; onConfirm: () => void; onCancel: () => void; className?: string
}) {
  const dialog = useGatewayModal()
  return <dialog ref={dialog} className="gateway-dialog-backdrop" aria-modal="true" aria-label={title}
    onCancel={event => { event.preventDefault(); if (!busy) onCancel() }}>
    <div className={`gateway-confirm-dialog ${className}`}>
      <h3>{title}</h3>
      <p>{message}</p>
      {children}
      <div className="gateway-dialog-actions">
        <button type="button" className="gateway-dialog-cancel" disabled={busy} onClick={onCancel}>{cancelLabel}</button>
        <button type="button" disabled={busy || disabled} onClick={onConfirm}>{busy ? '处理中…' : confirmLabel}</button>
      </div>
    </div>
  </dialog>
}

import type { ReactNode } from 'react'
import { GatewayModal } from './GatewayModal'

/** Keep the list in place; nested editors finish their confirmation before closing the workspace. */
export function AdminManagementDialog({ title, children, onClose }: {
  title: string; children: ReactNode; onClose: () => void
}) {
  function close() {
    if (!document.querySelector('dialog.gateway-dialog-backdrop[open]')) onClose()
  }
  return <GatewayModal title={title} onClose={close}
    footer={<button type="button" onClick={close}>完成</button>}>{children}</GatewayModal>
}

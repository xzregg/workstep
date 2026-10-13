import { useState, type ReactNode } from 'react'
import { AdminManagementDialog } from './AdminManagementDialog'

export function AdminRecordDetails({ label = '详情', title, children }: {
  label?: string; title: string; children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return <><button type="button" aria-label={title} onClick={() => setOpen(true)}>{label}</button>
    {open && <AdminManagementDialog title={title} onClose={() => setOpen(false)}>{children}</AdminManagementDialog>}
  </>
}

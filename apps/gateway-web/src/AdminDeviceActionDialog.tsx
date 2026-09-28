import { useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

export type AdminDevice = { id: string; name: string; status: string; online: boolean;
  daemon_health?: boolean | null; version: string | null; app_instance_id: string | null;
  latest_version?: string | null; update_available?: boolean | null }
export type DeviceAction = 'approve' | 'disable' | 'revoke'

const actionLabel: Record<DeviceAction, string> = { approve: '批准', disable: '停用', revoke: '撤销' }

export function AdminDeviceActionDialog({ device, action, csrf, onComplete, onClose }: {
  device: AdminDevice; action: DeviceAction; csrf: string
  onComplete: () => void; onClose: () => void
}) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function confirm() {
    setBusy(true); setError('')
    try {
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
      const step = await fetch('/api/auth/step-up', {
        method: 'POST', credentials: 'same-origin', headers,
        body: JSON.stringify({ password }),
      })
      if (!step.ok) throw new Error('密码验证失败。')
      const response = await fetch(`/api/admin/devices/${encodeURIComponent(device.id)}/${action}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf },
      })
      if (!response.ok) throw new Error(`${actionLabel[action]}设备失败。`)
      onComplete()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '设备操作失败。') }
    finally { setBusy(false) }
  }

  return <GatewayConfirmDialog title={`${actionLabel[action]}设备`}
    message={`${device.name}（${device.id}）${action === 'revoke' ? '撤销后须重新注册并获批才能连接。' : ''}`}
    confirmLabel={`确认${actionLabel[action]}`} busy={busy} disabled={!password}
    onConfirm={() => void confirm()} onCancel={onClose}>
    <label htmlFor="admin-device-step-password">输入管理员密码确认</label>
    <input id="admin-device-step-password" type="password" autoComplete="current-password" value={password}
      onChange={event => setPassword(event.target.value)} />
    {error && <p className="gateway-auth-error" role="alert">{error}</p>}
  </GatewayConfirmDialog>
}

import { PasswordConfirmation, confirmStepUp, useStepUpPassword } from './PasswordConfirmation'
import { useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

export type AdminDevice = { owner_user_id?: string | null; owner_name?: string | null; id: string; name: string; status: string; online: boolean;
  connection_ip?: string | null; daemon_health?: boolean | null; version: string | null; app_instance_id: string | null;
  latest_version?: string | null; update_available?: boolean | null }
export type DeviceAction = 'approve' | 'enable' | 'disable' | 'revoke' | 'delete'

const actionLabel: Record<DeviceAction, string> = { approve: '批准', enable: '重新启用', disable: '停用', revoke: '撤销', delete: '彻底删除' }

export function AdminDeviceActionDialog({ device, action, csrf, onComplete, onClose }: {
  device: AdminDevice; action: DeviceAction; csrf: string
  onComplete: () => void; onClose: () => void
}) {
  const { password, setPassword, passwordRequired, passwordReady } = useStepUpPassword()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function confirm() {
    if (busy) return
    setBusy(true); setError('')
    try {
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
      const step = await confirmStepUp(csrf, password, passwordRequired)
      if (!step.ok) throw new Error('密码验证失败。')
      const endpoint = action === 'delete' ? '' : `/${action === 'enable' ? 'approve' : action}`
      const response = await fetch(`/api/admin/devices/${encodeURIComponent(device.id)}${endpoint}`, {
        method: action === 'delete' ? 'DELETE' : 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf },
      })
      if (!response.ok) throw new Error(`${actionLabel[action]}设备失败。`)
      onComplete()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '设备操作失败。') }
    finally { setBusy(false) }
  }

  return <GatewayConfirmDialog title={`${actionLabel[action]}设备`}
    message={`${device.name}（${device.id}）${action === 'delete'
      ? '将永久清除网关中的设备登记、关联授权及项目/分享登记，旧授权和分享链接失效。本机项目和文件保留。该电脑再次登录时可重新登记，获得新设备 ID，并按当前审批规则接入。'
      : action === 'revoke'
      ? '撤销后该设备身份不能再登录，此操作无法直接恢复。'
      : action === 'disable' ? '停用后将断开连接，之后可重新启用。'
      : action === 'enable' ? '重新启用后，请在桌面端再次完成网关登录。' : ''}`}
    confirmLabel={`确认${actionLabel[action]}`} busy={busy} disabled={!passwordReady}
    onConfirm={() => void confirm()} onCancel={onClose}>
    <PasswordConfirmation id="admin-device-step-password" label="输入管理员密码确认" value={password} onChange={setPassword} />
    {busy && <p role="status"><span className="gateway-spinner" aria-hidden="true" /> 正在{actionLabel[action]}设备…</p>}
    {error && <p className="gateway-auth-error" role="alert">{error}</p>}
  </GatewayConfirmDialog>
}

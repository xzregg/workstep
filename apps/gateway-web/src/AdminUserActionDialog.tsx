import { localizeGatewayError } from './gatewayErrorText'
import { PasswordConfirmation, confirmStepUp, useStepUpPassword } from './PasswordConfirmation'
import { useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'
import type { AdminUser } from './AdminUsersPage'

export function AdminUserActionDialog({ user, action, csrf, onComplete, onClose }: {
  user: AdminUser; action: 'approve' | 'disable'; csrf: string
  onComplete: () => void; onClose: () => void
}) {
  const { password, setPassword, passwordRequired, passwordReady } = useStepUpPassword()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const approval = action === 'approve'

  async function confirm() {
    setBusy(true); setError('')
    try {
      if (!approval) {
        const step = await confirmStepUp(csrf, password, passwordRequired)
        if (!step.ok) throw new Error('Password verification failed.')
      }
      const response = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}/${action}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf },
      })
      if (!response.ok) throw new Error(response.status === 403 ? 'Current permissions cannot operate this account.' : 'Account operation failed, please try again.')
      onComplete()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Account operation failed.') }
    finally { setBusy(false) }
  }

  return <GatewayConfirmDialog title={approval ? '批准用户' : '停用用户'}
    message={`${user.display_name}${approval ? '将获准登录。' : '的所有登录会话将失效。'}`}
    confirmLabel={approval ? '批准' : '确认停用'} busy={busy} disabled={!approval && !passwordReady}
    onConfirm={() => void confirm()} onCancel={onClose}
      passwordConfirmation={!approval && <><PasswordConfirmation id="admin-user-step-password" label="输入你的密码确认" value={password} onChange={setPassword} /></>}>
    {error && <p className="gateway-auth-error" role="alert">{localizeGatewayError(error)}</p>}
  </GatewayConfirmDialog>
}

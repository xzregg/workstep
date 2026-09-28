import { useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'
import type { AdminUser } from './AdminUsersPage'

export function AdminUserActionDialog({ user, action, csrf, onComplete, onClose }: {
  user: AdminUser; action: 'approve' | 'disable'; csrf: string
  onComplete: () => void; onClose: () => void
}) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const approval = action === 'approve'

  async function confirm() {
    setBusy(true); setError('')
    try {
      if (!approval) {
        const step = await fetch('/api/auth/step-up', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
          body: JSON.stringify({ password }),
        })
        if (!step.ok) throw new Error('密码验证失败。')
      }
      const response = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}/${action}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf },
      })
      if (!response.ok) throw new Error(response.status === 403 ? '当前权限无法操作这个账号。' : '账号操作失败，请重试。')
      onComplete()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '账号操作失败。') }
    finally { setBusy(false) }
  }

  return <GatewayConfirmDialog title={approval ? '批准用户' : '停用用户'}
    message={`${user.display_name}（${user.username}）${approval ? '将获准登录。' : '的所有登录会话将失效。'}`}
    confirmLabel={approval ? '批准' : '确认停用'} busy={busy} disabled={!approval && !password}
    onConfirm={() => void confirm()} onCancel={onClose}>
    {!approval && <><label htmlFor="admin-user-step-password">输入你的密码确认</label>
      <input id="admin-user-step-password" type="password" autoComplete="current-password" value={password}
        onChange={event => setPassword(event.target.value)} /></>}
    {error && <p className="gateway-auth-error" role="alert">{error}</p>}
  </GatewayConfirmDialog>
}

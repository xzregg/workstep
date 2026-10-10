import { passwordRequirements } from './portalAccount'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'
import { validPortalAccount } from './PortalAuthPage'

export function AdminCreateUserDialog({ csrf, onSaved, onClose }: {
  csrf: string; onSaved: () => void; onClose: () => void
}) {
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [status, setStatus] = useState<'active' | 'pending'>('active')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmClose, setConfirmClose] = useState(false)
  const dirty = !!(username || displayName || password || status !== 'active')

  function requestClose() {
    if (dirty) setConfirmClose(true)
    else onClose()
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!validPortalAccount(username, displayName, password) || busy) return
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/admin/users', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ username, display_name: displayName, password, status }),
      })
      if (!response.ok) throw new Error(response.status === 409 ? '用户名已存在。' : '创建账号失败，请重试。')
      onSaved()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '创建账号失败。') }
    finally { setBusy(false) }
  }

  return <div className="gateway-dialog-backdrop">
    <section className="gateway-confirm-dialog gateway-create-user-dialog" role="dialog" aria-modal="true" aria-label="创建用户">
      <h3>创建用户</h3>
      <p>创建后，用户可使用初始密码登录，并在个人账户中自行修改密码。</p>
      <form className="gateway-auth-form" onSubmit={event => void submit(event)}>
        <label htmlFor="admin-user-username">用户名</label>
        <input id="admin-user-username" autoComplete="off" value={username} onChange={event => setUsername(event.target.value)} required />
        <label htmlFor="admin-user-display-name">显示名称</label>
        <input id="admin-user-display-name" value={displayName} onChange={event => setDisplayName(event.target.value)} required />
        <p>{passwordRequirements}</p>
        <label htmlFor="admin-user-password">初始密码（至少 8 位）</label>
        <input id="admin-user-password" type="password" autoComplete="new-password" minLength={8} required value={password}
          onChange={event => setPassword(event.target.value)} />
        <label htmlFor="admin-create-user-status">账号状态</label>
        <select id="admin-create-user-status" value={status} onChange={event => setStatus(event.target.value as 'active' | 'pending')}>
          <option value="active">启用</option><option value="pending">待审核</option>
        </select>
        {error && <p className="gateway-auth-error" role="alert">{error}</p>}
        <div className="gateway-dialog-actions">
          <button type="button" className="gateway-dialog-cancel" disabled={busy} onClick={requestClose}>取消</button>
          <button type="submit" disabled={busy || !validPortalAccount(username, displayName, password)}>
            {busy ? '正在创建…' : '创建用户'}
          </button>
        </div>
      </form>
      {confirmClose && <GatewayConfirmDialog title="放弃创建用户" message="已填写的内容将丢失。"
        confirmLabel="放弃并关闭" onConfirm={onClose} onCancel={() => setConfirmClose(false)} />}
    </section>
  </div>
}

import { passwordRequirements, validPortalPassword } from './portalAccount'
import { useState } from 'react'
import { GatewayModal } from './GatewayModal'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'
import { PasswordConfirmation, confirmStepUp, useStepUpPassword } from './PasswordConfirmation'
import { loginUsername } from './AdminSelection'
import type { AdminUser } from './AdminUsersPage'

export function AdminEditUserDialog({ user, csrf, onSaved, onClose }: {
 user: AdminUser; csrf: string; onSaved: () => void; onClose: () => void
}) {
 const [name, setName] = useState(user.display_name)
 const [newPassword, setNewPassword] = useState('')
 const [repeat, setRepeat] = useState('')
 const [busy, setBusy] = useState(false)
 const [error, setError] = useState('')
 const [discard, setDiscard] = useState(false)
 const { password, setPassword, passwordRequired, passwordReady } = useStepUpPassword()
 const local = !!loginUsername(user)
 const dirty = name !== user.display_name || !!newPassword || !!repeat
 const valid = !!name.trim() && name.trim().length <= 256 && dirty && (!newPassword || (validPortalPassword(loginUsername(user) ?? '', newPassword) && repeat === newPassword && passwordReady))
 function close() { if (!busy) { if (dirty) setDiscard(true); else onClose() } }
 async function save() {
  if (!valid || busy) return
  setBusy(true); setError('')
  try {
   if (newPassword) {
    const step = await confirmStepUp(csrf, password, passwordRequired)
    if (!step.ok) throw Error('管理员密码验证失败。')
   }
   const response = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}`, {
    method: 'PATCH', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ display_name: name.trim(), ...(newPassword ? { new_password: newPassword } : {}) }),
   })
   if (!response.ok) throw Error(response.status === 403 ? '没有编辑该用户的权限，或操作凭据已失效。' : '保存失败，请重试。')
   onSaved()
  } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败。') }
  finally { setBusy(false) }
 }
 return <>
  <GatewayModal title="编辑用户" onClose={close} footer={<>
   <button type="button" disabled={busy} onClick={close}>取消</button>
   <button type="button" disabled={!valid || busy || !csrf} onClick={() => void save()}>{busy ? <><span className="gateway-spinner"/> 正在保存…</> : '保存修改'}</button>
  </>}>
   <div className="gateway-auth-form">
    <label htmlFor="edit-user-login">登录用户名</label>
    <input id="edit-user-login" value={loginUsername(user) ?? '企业扫码登录'} readOnly />
    <label htmlFor="edit-user-name">显示名称</label>
    <input id="edit-user-name" value={name} maxLength={256} disabled={busy} onChange={event => setName(event.target.value)} />
    {local ? <>
     <p>{passwordRequirements}</p>
        <label htmlFor="edit-user-password">新密码（可选）</label>
     <input id="edit-user-password" type="password" autoComplete="new-password" value={newPassword} disabled={busy} maxLength={128} onChange={event => setNewPassword(event.target.value)} />
     <p>留空保持原密码；设置至少 8 位的新密码后，该用户需要重新登录。</p>
     {newPassword && <>
      <label htmlFor="edit-user-password-repeat">确认新密码</label>
      <input id="edit-user-password-repeat" type="password" autoComplete="new-password" value={repeat} disabled={busy} onChange={event => setRepeat(event.target.value)} />
      {repeat && repeat !== newPassword && <p role="alert">两次输入的密码不一致。</p>}
      <PasswordConfirmation id="edit-user-admin-password" label="输入你的密码确认" value={password} onChange={setPassword} disabled={busy} />
     </>}
    </> : <p>该用户通过企业身份登录，登录密码由钉钉或企业微信管理。企业同步可能更新显示名称。</p>}
    {error && <p role="alert" className="gateway-auth-error">{error}</p>}
   </div>
  </GatewayModal>
  {discard && <GatewayConfirmDialog title="放弃修改" message="未保存的修改将丢失。" confirmLabel="放弃并关闭" onConfirm={onClose} onCancel={() => setDiscard(false)} />}
 </>
}

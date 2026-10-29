import { passwordRequirements, validPortalPassword } from './portalAccount'
import { useEffect, useState } from 'react'
import { GatewayModal } from './GatewayModal'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'
import { PasswordConfirmation, confirmStepUp, useStepUpPassword } from './PasswordConfirmation'
import { loginUsername } from './AdminSelection'
import type { AdminUser } from './AdminUsersPage'

type UserGroupChoice = { id: string; name: string; selected: boolean; editable: boolean; synced?: boolean }

export function AdminEditUserDialog({ user, csrf, onSaved, onClose }: {
 user: AdminUser; csrf: string; onSaved: () => void; onClose: () => void
}) {
 const [groups, setGroups] = useState<UserGroupChoice[]>([])
 const [groupsReady, setGroupsReady] = useState(false)
 const [groupsError, setGroupsError] = useState('')
 const [groupsRevision, setGroupsRevision] = useState(0)
 const [selectedGroups, setSelectedGroups] = useState<string[]>([])
 useEffect(() => {
  const controller = new AbortController()
  setGroupsError(''); setGroupsReady(false)
  void fetch(`/api/admin/users/${encodeURIComponent(user.id)}/groups`, { credentials: 'same-origin', signal: controller.signal })
   .then(async response => {
    if (!response.ok) throw Error('用户组加载失败。')
    const data = await response.json()
    if (!Array.isArray(data.groups)) throw Error('用户组加载失败。')
    if (!controller.signal.aborted) {
     setGroups(data.groups); setSelectedGroups(data.groups.filter((group: UserGroupChoice) => group.selected).map((group: UserGroupChoice) => group.id)); setGroupsReady(true)
    }
   }).catch(reason => { if (!controller.signal.aborted) setGroupsError(reason instanceof Error ? reason.message : '用户组加载失败。') })
  return () => controller.abort()
 }, [user.id, groupsRevision])
 const groupsChanged = groupsReady && groups.some(group => group.selected !== selectedGroups.includes(group.id))
 const initialUsername = loginUsername(user) ?? ''
 const [username, setUsername] = useState(initialUsername)
 const [name, setName] = useState(user.display_name)
 const [newPassword, setNewPassword] = useState('')
 const [repeat, setRepeat] = useState('')
 const [busy, setBusy] = useState(false)
 const [error, setError] = useState('')
 const [discard, setDiscard] = useState(false)
 const { password, setPassword, passwordRequired, passwordReady } = useStepUpPassword()
 const local = !!initialUsername
 const credentialsChanged = username !== initialUsername || !!newPassword
 const dirty = groupsChanged || name !== user.display_name || credentialsChanged || !!repeat
 const usernameValid = /^[a-z][a-z0-9_-]{2,63}$/.test(username) || (!local && !username && !newPassword)
 const valid = !!name.trim() && name.trim().length <= 256 && dirty && usernameValid
  && (!credentialsChanged || passwordReady) && (local || !username || !!newPassword)
  && (!newPassword || (validPortalPassword(username, newPassword) && repeat === newPassword))
 function close() { if (!busy) { if (dirty) setDiscard(true); else onClose() } }
 async function save() {
  if (!valid || busy) return
  setBusy(true); setError('')
  try {
   if (credentialsChanged) {
    const step = await confirmStepUp(csrf, password, passwordRequired)
    if (!step.ok) throw Error('管理员密码验证失败。')
   }
   const response = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}`, {
    method: 'PATCH', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ display_name: name.trim(), ...(groupsChanged ? { group_ids: groups.filter(group => selectedGroups.includes(group.id)).map(group => group.id) } : {}), ...(username !== initialUsername ? {username} : {}), ...(newPassword ? { new_password: newPassword } : {}) }),
   })
   if (!response.ok) throw Error(response.status === 409 ? (groupsChanged ? '用户组关系或登录用户名发生冲突，请重新打开编辑并确认。' : '登录用户名已被使用，请更换。') : response.status === 403 ? '没有编辑该用户的权限，或操作凭据已失效。' : '保存失败，请重试。')
   onSaved()
  } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败。') }
  finally { setBusy(false) }
 }
 return <>
  <GatewayModal className="gateway-edit-user-dialog" title="编辑用户" onClose={close} footer={<>
   <button type="button" disabled={busy} onClick={close}>取消</button>
   <button type="button" disabled={!valid || busy || !csrf} onClick={() => void save()}>{busy ? <><span className="gateway-spinner"/> 正在保存…</> : '保存修改'}</button>
  </>}>
   <div className="gateway-auth-form">
    <label htmlFor="edit-user-login">登录用户名</label>
    <input id="edit-user-login" value={username} placeholder={local ? undefined : '可选，设置后支持账号密码登录'} maxLength={64} disabled={busy} onChange={event=>setUsername(event.target.value)} />
    <p>用户名为 3–64 位，以小写字母开头，可包含小写字母、数字、下划线和短横线。</p>
    <label htmlFor="edit-user-name">显示名称</label>
    <input id="edit-user-name" value={name} maxLength={256} disabled={busy} onChange={event => setName(event.target.value)} />
    <fieldset className="gateway-user-group-choices" disabled={busy}>
     <legend>用户组（可多选）</legend>
     <p>一个用户可以加入多个组；企业同步的成员关系由组织同步维护。</p>
     {!groupsReady && !groupsError && <p role="status"><span className="gateway-spinner" /> 正在加载用户组…</p>}
     {groupsError && <p role="status">用户组加载失败。<button type="button" onClick={() => setGroupsRevision(value => value + 1)}>重试加载用户组</button></p>}
     {groupsReady && groups.map(group => <label className="gateway-check-label" key={group.id}>
      <input type="checkbox" checked={selectedGroups.includes(group.id)} disabled={!group.editable || busy}
       onChange={event => setSelectedGroups(current => event.target.checked ? [...current, group.id] : current.filter(id => id !== group.id))} />
      {group.name}{!group.editable && (group.synced ? '（企业同步，只读）' : '（只读）')}
     </label>)}
     {groupsReady && !groups.length && <p>暂无可分配的用户组。</p>}
    </fieldset>
    <>
     <p>{passwordRequirements}</p>
        <label htmlFor="edit-user-password">新密码（可选）</label>
     <input id="edit-user-password" type="password" autoComplete="new-password" value={newPassword} disabled={busy} maxLength={128} onChange={event => setNewPassword(event.target.value)} />
     <p>{local ? '留空保持原密码；修改登录信息后，该用户需要重新登录。' : '首次开启账号密码登录，需同时填写用户名和新密码。企业扫码登录仍可使用；同步不会覆盖平台用户名和密码。'}</p>
     {newPassword && <>
      <label htmlFor="edit-user-password-repeat">确认新密码</label>
      <input id="edit-user-password-repeat" type="password" autoComplete="new-password" value={repeat} disabled={busy} onChange={event => setRepeat(event.target.value)} />
      {repeat && repeat !== newPassword && <p role="alert">两次输入的密码不一致。</p>}
     </>}
     {credentialsChanged && <PasswordConfirmation id="edit-user-admin-password" label="输入你的密码确认" value={password} onChange={setPassword} disabled={busy} />}
     {!local && <p>企业同步仍管理员工状态和组织关系，可能更新显示名称。</p>}
    </>
    {error && <p role="alert" className="gateway-auth-error">{error}</p>}
   </div>
  </GatewayModal>
  {discard && <GatewayConfirmDialog title="放弃修改" message="未保存的修改将丢失。" confirmLabel="放弃并关闭" onConfirm={onClose} onCancel={() => setDiscard(false)} />}
 </>
}

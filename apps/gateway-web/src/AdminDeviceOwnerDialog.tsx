import { useEffect, useState } from 'react'
import { GatewayModal } from './GatewayModal'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'
import { PasswordConfirmation, confirmStepUp, useStepUpPassword } from './PasswordConfirmation'
import type { AdminDevice } from './AdminDeviceActionDialog'

type User = { id: string; username: string; display_name?: string; status: string }
export function AdminDeviceOwnerDialog({ device, csrf, onComplete, onClose }: {
 device: AdminDevice; csrf: string; onComplete: () => void; onClose: () => void
}) {
 const [query, setQuery] = useState('')
 const [search, setSearch] = useState('')
 const [users, setUsers] = useState<User[]>([])
 const [userId, setUserId] = useState('')
 const [loading, setLoading] = useState(false)
 const [busy, setBusy] = useState(false)
 const [error, setError] = useState('')
 const [discard, setDiscard] = useState(false)
 const { password, setPassword, passwordRequired, passwordReady } = useStepUpPassword()
 const dirty = !!userId || !!password
 const valid = !!csrf && !!userId && userId !== device.owner_user_id && passwordReady
 useEffect(() => {
  const controller = new AbortController(); setLoading(true); setError('')
  void fetch(`/api/admin/users?q=${encodeURIComponent(search)}&status=active&page_size=25`, { credentials: 'same-origin', signal: controller.signal }).then(async response => {
   if (!response.ok) throw Error('用户加载失败，请重新搜索。')
   const data = await response.json()
   if (!controller.signal.aborted) setUsers(data.users ?? [])
  }).catch(reason => { if (!controller.signal.aborted) setError(reason.message) })
   .finally(() => { if (!controller.signal.aborted) setLoading(false) })
  return () => controller.abort()
 }, [search])
 function close() { if (!busy) { if (dirty) setDiscard(true); else onClose() } }
 async function save() {
  if (!valid || busy) return
  setBusy(true); setError('')
  try {
   const step = await confirmStepUp(csrf, password, passwordRequired)
   if (!step.ok) throw Error('管理员身份验证失败。')
   const response = await fetch(`/api/admin/devices/${encodeURIComponent(device.id)}/owner`, {
    method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ user_id: userId }),
   })
   if (!response.ok) throw Error('所有者转移失败，请确认用户有效且拥有设备管理权限。')
   onComplete()
  } catch (reason) { setError(reason instanceof Error ? reason.message : '所有者转移失败。') }
  finally { setBusy(false) }
 }
 return <GatewayModal title="转移设备所有者" onClose={close} footer={<>
  <button type="button" disabled={busy} onClick={close}>取消</button>
  <button type="button" disabled={busy || !valid} onClick={() => void save()}>确认转移</button>
 </>}>
  <p>{device.name} · 当前所有者：{device.owner_name ?? '未确定'}</p>
  <p>新所有者将获得整台设备访问和创建项目权限。原所有者的普通访问授权保留，可在管理授权中另行撤销。</p>
  <form className="gateway-admin-search" onSubmit={event => { event.preventDefault(); setSearch(query.trim()); setUserId('') }}>
   <label htmlFor="owner-search">搜索用户</label><input id="owner-search" value={query} disabled={busy} onChange={event => setQuery(event.target.value)} />
   <button type="submit" disabled={busy || loading}>搜索</button>
  </form>
  <div className="gateway-auth-form">
   <label htmlFor="new-device-owner">新所有者（最多显示 25 人，可搜索）</label>
   <select id="new-device-owner" value={userId} disabled={busy || loading} onChange={event => setUserId(event.target.value)}>
    <option value="">请选择用户</option>{users.filter(user => user.status === 'active' && user.id !== device.owner_user_id).map(user => <option key={user.id} value={user.id}>{user.display_name || user.username} · {user.username}</option>)}
   </select>
   <PasswordConfirmation id="owner-password" label="输入管理员密码确认" value={password} onChange={setPassword} disabled={busy} />
  </div>
  {(busy || loading) && <p role="status"><span className="gateway-spinner" /> {busy ? '正在转移…' : '正在加载用户…'}</p>}
  {error && <p role="alert" className="gateway-auth-error">{error}</p>}
  {discard && <GatewayConfirmDialog title="放弃转移" message="尚未提交的修改将丢失。" confirmLabel="放弃并关闭" onConfirm={onClose} onCancel={() => setDiscard(false)} />}
 </GatewayModal>
}

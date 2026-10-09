import { useState } from 'react'
import { GatewayModal } from './GatewayModal'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'
import { PasswordConfirmation, confirmStepUp, useStepUpPassword } from './PasswordConfirmation'
import type { AdminDevice } from './AdminDeviceActionDialog'

export function AdminDeviceNameDialog({ device, csrf, onComplete, onClose }: {
  device: AdminDevice; csrf: string; onComplete: () => void; onClose: () => void
}) {
  const [name, setName] = useState(device.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [discard, setDiscard] = useState(false)
  const { password, setPassword, passwordRequired, passwordReady } = useStepUpPassword()
  const dirty = name !== device.name || !!password
  const valid = !!csrf && passwordReady && !!name.trim() && name.trim() !== device.name && name.trim().length <= 256

  function requestClose() {
    if (busy) return
    if (dirty) setDiscard(true)
    else onClose()
  }

  async function save() {
    if (!valid || busy) return
    setBusy(true); setError('')
    try {
      const step = await confirmStepUp(csrf, password, passwordRequired)
      if (!step.ok) throw new Error('管理员密码验证失败。')
      const response = await fetch(`/api/admin/devices/${encodeURIComponent(device.id)}/name`, {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ name: name.trim() }),
      })
      if (!response.ok) throw new Error(response.status === 403
        ? '当前账号没有修改此设备名称的权限。' : '设备名称保存失败，请重试。')
      onComplete()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '设备名称保存失败。') }
    finally { setBusy(false) }
  }

  return <GatewayModal title="修改设备名称" onClose={requestClose}
    footer={<>
      <button type="button" disabled={busy} onClick={requestClose}>取消</button>
      <button type="submit" form="admin-device-name-form" disabled={busy || !valid}>保存名称</button>
    </>}>
    <form id="admin-device-name-form" className="gateway-auth-form" onSubmit={event => {
      event.preventDefault(); void save()
    }}>
      <p>设备 ID：{device.id}</p>
      <p>名称用于辨认电脑；修改名称不会改变设备 ID 或授权状态，重新登录后仍会保留。</p>
      <label htmlFor="admin-device-name">设备名称</label>
      <input id="admin-device-name" value={name} maxLength={256} disabled={busy}
        onChange={event => setName(event.target.value)} />
      <PasswordConfirmation id="admin-device-name-password" label="输入管理员密码确认"
        value={password} onChange={setPassword} disabled={busy} />
      {busy && <p role="status"><span className="gateway-spinner" aria-hidden="true" /> 正在保存名称…</p>}
      {error && <p className="gateway-auth-error" role="alert">{error}</p>}
    </form>
    {discard && <GatewayConfirmDialog title="放弃修改设备名称" message="尚未保存的名称将丢失。"
      confirmLabel="放弃并关闭" cancelLabel="继续编辑" onConfirm={onClose} onCancel={() => setDiscard(false)} />}
  </GatewayModal>
}

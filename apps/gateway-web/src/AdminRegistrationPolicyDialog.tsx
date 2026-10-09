import { PasswordConfirmation, confirmStepUp, useStepUpPassword } from './PasswordConfirmation'
import { useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

export type RegistrationMode = 'open' | 'open_with_approval' | 'closed'
export const registrationLabels: Record<RegistrationMode, string> = {
  open: '开放注册，立即启用',
  open_with_approval: '开放注册，管理员审核',
  closed: '关闭注册',
}

export function AdminRegistrationPolicyDialog({ mode, csrf, onSaved, onClose, devicePolicy = false }: {
  mode: RegistrationMode | 'manual' | 'automatic'; devicePolicy?: boolean; csrf: string; onSaved: () => void; onClose: () => void
}) {
  const title = devicePolicy ? '修改设备审批策略' : '修改注册策略'
  const labels = devicePolicy ? { manual: '人工审批', automatic: '自动审批' } : registrationLabels
  const [selected, setSelected] = useState(mode)
  const { password, setPassword, passwordRequired, passwordReady } = useStepUpPassword()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [discard, setDiscard] = useState(false)

  async function save() {
    if (selected === mode || !passwordReady) return
    setBusy(true); setError('')
    try {
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
      const step = await confirmStepUp(csrf, password, passwordRequired)
      if (!step.ok) throw new Error('密码验证失败。')
      const response = await fetch(devicePolicy ? '/api/admin/device-approval-policy' : '/api/admin/registration-policy', {
        method: 'PUT', credentials: 'same-origin', headers,
        body: JSON.stringify({ mode: selected }),
      })
      if (!response.ok) throw new Error(title + '保存失败。')
      onSaved()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : title + '保存失败。')
    } finally { setBusy(false) }
  }

  return <>
    <GatewayConfirmDialog title={title} message={devicePolicy ? '仅影响新注册设备；已有待审批设备和密钥更换仍需人工审批。' : '新策略会影响后续注册，不改变现有账号。'}
      className="gateway-platform-policy-dialog"
      confirmLabel="保存策略" busy={busy} disabled={selected === mode || !passwordReady}
      onConfirm={() => void save()} onCancel={() => {
        if (selected !== mode || password) setDiscard(true)
        else onClose()
      }}>
      <label htmlFor="gateway-registration-mode">{devicePolicy ? '设备审批策略' : '注册策略'}</label>
      <select id="gateway-registration-mode" value={selected}
        onChange={event => setSelected(event.target.value as RegistrationMode)}>
        {Object.entries(labels).map(([key, label]) =>
          <option key={key} value={key}>{label}</option>)}</select>
      <PasswordConfirmation id="gateway-registration-password" label="管理员密码" value={password} onChange={setPassword} />
      {error && <p role="alert" className="gateway-auth-error">{error}</p>}
    </GatewayConfirmDialog>
    {discard && <GatewayConfirmDialog title="放弃修改" message="注册策略尚未保存。"
      confirmLabel="放弃修改" onConfirm={onClose} onCancel={() => setDiscard(false)} />}
  </>
}

import { useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

export type RegistrationMode = 'open' | 'open_with_approval' | 'closed'
export const registrationLabels: Record<RegistrationMode, string> = {
  open: '开放注册，立即启用',
  open_with_approval: '开放注册，管理员审核',
  closed: '关闭注册',
}

export function AdminRegistrationPolicyDialog({ mode, csrf, onSaved, onClose }: {
  mode: RegistrationMode; csrf: string; onSaved: () => void; onClose: () => void
}) {
  const [selected, setSelected] = useState(mode)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [discard, setDiscard] = useState(false)

  async function save() {
    if (selected === mode || !password) return
    setBusy(true); setError('')
    try {
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
      const step = await fetch('/api/auth/step-up', { method: 'POST', credentials: 'same-origin', headers,
        body: JSON.stringify({ password }) })
      if (!step.ok) throw new Error('密码验证失败。')
      const response = await fetch('/api/admin/registration-policy', {
        method: 'PUT', credentials: 'same-origin', headers,
        body: JSON.stringify({ mode: selected }),
      })
      if (!response.ok) throw new Error('注册策略保存失败。')
      onSaved()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '注册策略保存失败。')
    } finally { setBusy(false) }
  }

  return <>
    <GatewayConfirmDialog title="修改注册策略" message="新策略会影响后续注册，不改变现有账号。"
      className="gateway-platform-policy-dialog"
      confirmLabel="保存策略" busy={busy} disabled={selected === mode || !password}
      onConfirm={() => void save()} onCancel={() => {
        if (selected !== mode || password) setDiscard(true)
        else onClose()
      }}>
      <label htmlFor="gateway-registration-mode">注册策略</label>
      <select id="gateway-registration-mode" value={selected}
        onChange={event => setSelected(event.target.value as RegistrationMode)}>
        {Object.entries(registrationLabels).map(([key, label]) =>
          <option key={key} value={key}>{label}</option>)}</select>
      <label htmlFor="gateway-registration-password">管理员密码</label>
      <input id="gateway-registration-password" type="password" autoComplete="current-password"
        value={password} onChange={event => setPassword(event.target.value)} />
      {error && <p role="alert" className="gateway-auth-error">{error}</p>}
    </GatewayConfirmDialog>
    {discard && <GatewayConfirmDialog title="放弃修改" message="注册策略尚未保存。"
      confirmLabel="放弃修改" onConfirm={onClose} onCancel={() => setDiscard(false)} />}
  </>
}

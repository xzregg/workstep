import { publishCompanyName } from './platformBranding'
import { PasswordConfirmation, confirmStepUp, useStepUpPassword } from './PasswordConfirmation'
import { useRef, useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

export function AdminCompanyNameDialog({name, csrf, onClose, onSaved}: {
  name: string; csrf: string; onClose: () => void; onSaved: () => void
}) {
  const [value, setValue] = useState(name)
  const { password, setPassword, passwordRequired, passwordReady } = useStepUpPassword()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [discard, setDiscard] = useState(false)
  const pending = useRef(false)
  const normalized = value.trim()
  const valid = value.length <= 100 && !/[\x00-\x1f\x7f\u2028\u2029]/.test(value)
  function close() { if (value !== name || password) setDiscard(true); else onClose() }
  async function save() {
    if (pending.current || !valid || normalized === name || !csrf || !passwordReady) return
    pending.current = true; setBusy(true); setError('')
    try {
      const headers = {'Content-Type': 'application/json', 'X-CSRF-Token': csrf}
      const proof = await confirmStepUp(csrf, password, passwordRequired)
      if (!proof.ok) throw Error('管理员密码验证失败。')
      const response = await fetch('/api/admin/company-display-name', {method: 'PUT', credentials: 'same-origin', headers, body: JSON.stringify({company_display_name: normalized})})
      if (!response.ok) throw Error(response.status === 422 ? '公司名称无效，请填写不超过 100 字的单行名称。' : '公司名称保存失败，请重试。')
      publishCompanyName(normalized)
      onSaved()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '公司名称保存失败。') }
    finally { pending.current = false; setBusy(false) }
  }
  return <>
    <GatewayConfirmDialog title="修改公司显示名称" message="公司名称将另起一行显示在登录页、设备认证页的主标题下方；留空则隐藏。"
      confirmLabel="保存公司名称" disabled={!valid || normalized === name || !passwordReady || !csrf} busy={busy} onCancel={close} onConfirm={() => void save()}>
      <label>公司显示名称<input type="text" value={value} maxLength={100} disabled={busy} placeholder="例如：示例科技有限公司" onChange={event => setValue(event.target.value)}/></label>
      {!valid && <p className="gateway-auth-error">请填写不超过 100 字的单行公司名称。</p>}
      <PasswordConfirmation label="管理员密码" value={password} onChange={setPassword} disabled={busy} />
      {busy && <p role="status"><span className="gateway-spinner"/>正在保存公司名称…</p>}
      {error && <p role="alert" className="gateway-auth-error">{error}</p>}
    </GatewayConfirmDialog>
    {discard && <GatewayConfirmDialog title="放弃公司名称修改" message="公司名称尚未保存。" confirmLabel="放弃并关闭" onConfirm={onClose} onCancel={() => setDiscard(false)}/>}
  </>
}

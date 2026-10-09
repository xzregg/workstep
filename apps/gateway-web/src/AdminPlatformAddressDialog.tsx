import { PasswordConfirmation, confirmStepUp, useStepUpPassword } from './PasswordConfirmation'
import { useRef, useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

function normalizedAddress(value: string): string | null {
  const input = value.trim().replace(/\/$/, '')
  try {
    const url = new URL(input)
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== input || url.username || url.password) return null
    return input
  } catch { return null }
}

export function AdminPlatformAddressDialog({address, csrf, onClose, onSaved}: {
  address: string | null; csrf: string; onClose: () => void; onSaved: () => void
}) {
  const [value, setValue] = useState(address ?? '')
  const { password, setPassword, passwordRequired, passwordReady } = useStepUpPassword()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [discard, setDiscard] = useState(false)
  const pending = useRef(false)
  const normalized = normalizedAddress(value)
  function close() { if (value !== (address ?? '') || password) setDiscard(true); else onClose() }
  async function save() {
    if (pending.current || !normalized || normalized === address || !csrf || !passwordReady) return
    pending.current = true; setBusy(true); setError('')
    try {
      const headers = {'Content-Type': 'application/json', 'X-CSRF-Token': csrf}
      const proof = await confirmStepUp(csrf, password, passwordRequired)
      if (!proof.ok) throw Error('管理员密码验证失败。')
      const response = await fetch('/api/admin/platform-address', {method: 'PUT', credentials: 'same-origin', headers, body: JSON.stringify({public_origin: normalized})})
      if (!response.ok) throw Error(response.status === 422 ? '地址无效：请使用 HTTPS 域名或本地、内网 HTTP 地址，不包含路径。' : '平台地址保存失败，请重试。')
      onSaved()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '平台地址保存失败。') }
    finally { pending.current = false; setBusy(false) }
  }
  return <>
    <GatewayConfirmDialog title="修改平台地址" message="保存后立即用于安装页、设备访问及分享链接，重启后保留。"
      confirmLabel="保存平台地址" disabled={!normalized || normalized === address || !passwordReady || !csrf} busy={busy} onCancel={close} onConfirm={() => void save()}>
      <label>平台地址<input type="url" value={value} disabled={busy} placeholder="https://workstep.example.com" onChange={event => setValue(event.target.value)}/></label>
      {value && !normalized && <p className="gateway-auth-error">请输入完整的 HTTP 或 HTTPS 地址，不包含路径、参数或账号密码。</p>}
      <p>域名须已指向网关，并配置好对应的 HTTPS 服务；本机或内网可使用 HTTP 地址。其他电脑不能使用 localhost 连接此网关。</p>
      <PasswordConfirmation label="管理员密码" value={password} onChange={setPassword} disabled={busy} />
      {busy && <p role="status"><span className="gateway-spinner"/>正在保存平台地址…</p>}
      {error && <p role="alert" className="gateway-auth-error">{error}</p>}
    </GatewayConfirmDialog>
    {discard && <GatewayConfirmDialog title="放弃平台地址修改" message="平台地址尚未保存。" confirmLabel="放弃并关闭" onConfirm={onClose} onCancel={() => setDiscard(false)}/>}
  </>
}

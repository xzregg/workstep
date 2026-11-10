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

export function AdminPlatformAddressDialog({address, allowedOrigins = [], csrf, onClose, onSaved}: {
  address: string | null; allowedOrigins?: string[]; csrf: string; onClose: () => void; onSaved: () => void
}) {
  const [value, setValue] = useState(address ?? '')
  const [aliases, setAliases] = useState(allowedOrigins.join('\n'))
  const { password, setPassword, passwordRequired, passwordReady } = useStepUpPassword()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [discard, setDiscard] = useState(false)
  const pending = useRef(false)
  const normalized = normalizedAddress(value)
  const lines = aliases.split('\n').map(line => line.trim()).filter(Boolean)
  const validAliases = lines.length <= 32 && lines.every(line => normalizedAddress(line))
  const origins = [...new Set(lines.map(line => normalizedAddress(line)!))]
  const changed = normalized !== address || JSON.stringify(origins) !== JSON.stringify(allowedOrigins)
  function close() { if (value !== (address ?? '') || aliases !== allowedOrigins.join('\n') || password) setDiscard(true); else onClose() }
  async function save() {
    if (pending.current || !normalized || !validAliases || !changed || !csrf || !passwordReady) return
    pending.current = true; setBusy(true); setError('')
    try {
      const headers = {'Content-Type': 'application/json', 'X-CSRF-Token': csrf}
      const proof = await confirmStepUp(csrf, password, passwordRequired)
      if (!proof.ok) throw Error('管理员密码验证失败。')
      const response = await fetch('/api/admin/platform-address', {method: 'PUT', credentials: 'same-origin', headers, body: JSON.stringify({public_origin: normalized, allowed_origins: origins})})
      if (!response.ok) throw Error(response.status === 422 ? '地址无效：请使用 HTTPS 域名或本地、内网 HTTP 地址，不包含路径。' : '平台地址保存失败，请重试。')
      onSaved()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '平台地址保存失败。') }
    finally { pending.current = false; setBusy(false) }
  }
  return <>
    <GatewayConfirmDialog className="gateway-platform-address-dialog" title="修改平台地址" message="管理默认地址和其他访问入口，保存后立即生效。"
      confirmLabel="保存平台地址" disabled={!normalized || !validAliases || !changed || !passwordReady || !csrf} busy={busy} onCancel={close} onConfirm={() => void save()}
      passwordConfirmation={<PasswordConfirmation label="管理员密码" value={password} onChange={setPassword} disabled={busy} />}>
      <div className="gateway-platform-address-fields">
        <div className="gateway-platform-address-field">
          <label htmlFor="platform-default-address">平台地址<span className="gateway-platform-address-tag" aria-hidden="true">默认</span></label>
          <input id="platform-default-address" aria-label="平台地址" type="url" value={value} disabled={busy} placeholder="https://workstep.example.com" onChange={event => setValue(event.target.value)}/>
          <p className="gateway-platform-address-hint">用于安装页和默认链接。</p>
          {value && !normalized && <p className="gateway-auth-error">请输入完整地址，不包含路径、参数或账号密码。</p>}
        </div>
        <div className="gateway-platform-address-field">
          <label htmlFor="platform-other-addresses">其他入口地址<span className="gateway-platform-address-optional" aria-hidden="true">选填 · 每行一个</span></label>
          <textarea id="platform-other-addresses" aria-label="其他入口地址（每行一个）" rows={4} value={aliases} disabled={busy} placeholder={'https://a.example.com\nhttps://b.example.com'} onChange={event => setAliases(event.target.value)}/>
          <p className="gateway-platform-address-hint">最多 32 个，无需重复默认地址。授权完成后返回原入口。</p>
          {!validAliases && <p className="gateway-auth-error">最多配置 32 个完整地址，不包含路径、参数或账号密码。</p>}
        </div>
        <div className="gateway-platform-address-note">
          <strong>配置提示</strong>
          <p>域名需指向网关并启用 HTTPS；本机或内网可用 HTTP。</p>
          <p>使用企业登录时，请同步配置各入口的回调地址。</p>
        </div>
      </div>
      {busy && <p role="status"><span className="gateway-spinner"/>正在保存平台地址…</p>}
      {error && <p role="alert" className="gateway-auth-error">{error}</p>}
    </GatewayConfirmDialog>
    {discard && <GatewayConfirmDialog title="放弃平台地址修改" message="平台地址尚未保存。" confirmLabel="放弃并关闭" onConfirm={onClose} onCancel={() => setDiscard(false)}/>}
  </>
}

import { localizeGatewayError } from './gatewayErrorText'
import { PasswordConfirmation, confirmStepUp, useStepUpPassword } from './PasswordConfirmation'
import { useRef, useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

export const DEFAULT_PUBLIC_STUN_URLS = [
  'stun:stun.miwifi.com:3478',
  'stun:stun.chat.bilibili.com:3478',
  'stun:stun.yy.com:3478',
  'stun:stun.cloudflare.com:3478',
  'stun:stun.l.google.com:19302',
] as const

const HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

function isValidHostname(host: string): boolean {
  if (!host || host.length > 253 || host.startsWith('.') || host.endsWith('.') || host.includes('..')) {
    return false
  }
  return host.split('.').every(label => HOST_LABEL_RE.test(label))
}

function normalizedStunUrl(value: string): string | null {
  const cleaned = value.trim()
  if (!cleaned || !/^[\x21-\x7e]+$/.test(cleaned) || cleaned.includes('\\') || cleaned.includes('://')) {
    return null
  }

  let rest = cleaned
  if (cleaned.toLowerCase().startsWith('stun:')) {
    rest = cleaned.slice(5)
    if (!rest || rest.startsWith('//')) return null
  } else if (!cleaned.startsWith('[')) {
    const colon = cleaned.indexOf(':')
    if (colon > 0) {
      const head = cleaned.slice(0, colon)
      const tail = cleaned.slice(colon + 1)
      if (/^[a-zA-Z]+$/.test(head) && !/^\d+$/.test(tail)) return null
    }
  }

  if (rest.endsWith(':')) return null
  try {
    const parsed = new URL(`stun://${rest}`)
    const host = parsed.hostname.toLowerCase()
    if (!host || parsed.username || parsed.password || parsed.pathname || parsed.search || parsed.hash) {
      return null
    }
    const bareHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
    if (!host.startsWith('[') && !isValidHostname(bareHost)) return null
    const port = parsed.port ? Number(parsed.port) : 3478
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
    return `stun:${host}:${port}`
  } catch {
    return null
  }
}

export function AdminWebRtcStunDialog({ stunUrls = [], csrf, onClose, onSaved }: {
  stunUrls?: string[]; csrf: string; onClose: () => void; onSaved: () => void
}) {
  const initialDraft = stunUrls.join('\n')
  const [value, setValue] = useState(initialDraft)
  const { password, setPassword, passwordRequired, passwordReady } = useStepUpPassword()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [discard, setDiscard] = useState(false)
  const pending = useRef(false)

  const lines = value.split('\n').map(line => line.trim()).filter(Boolean)
  const normalizedLines = lines.map(line => normalizedStunUrl(line))
  const uniqueUrls = [...new Set(normalizedLines.filter((entry): entry is string => entry !== null))]
  const valid = normalizedLines.every(entry => entry !== null) && uniqueUrls.length <= 16
  const changed = JSON.stringify(uniqueUrls) !== JSON.stringify(stunUrls)
  const matchesDefaults = JSON.stringify(uniqueUrls) === JSON.stringify(DEFAULT_PUBLIC_STUN_URLS)

  function close() {
    if (value !== initialDraft || password) setDiscard(true)
    else onClose()
  }

  async function save() {
    if (pending.current || !valid || !changed || !csrf || !passwordReady) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
      const proof = await confirmStepUp(csrf, password, passwordRequired)
      if (!proof.ok) throw Error('Administrator password verification failed.')
      const response = await fetch('/api/admin/webrtc-stun', {
        method: 'PUT',
        credentials: 'same-origin',
        headers,
        body: JSON.stringify({ stun_urls: uniqueUrls }),
      })
      if (!response.ok) {
        throw Error(
          response.status === 422
            ? 'Invalid STUN server address. Enter up to 16 host:port or stun:host:port lines.'
            : 'Save failed, please try again.',
        )
      }
      onSaved()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Save failed, please try again.')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return <>
    <GatewayConfirmDialog
      className="gateway-platform-address-dialog"
      title="修改 STUN 服务器"
      message="可填多个国内外公共 STUN 地址（保存后与内置 STUN 一并下发）；清空则仅用网关内置 STUN。"
      confirmLabel="保存 STUN 服务器"
      disabled={!valid || !changed || !passwordReady || !csrf}
      busy={busy}
      onCancel={close}
      onConfirm={() => void save()}
      passwordConfirmation={<PasswordConfirmation label="管理员密码" value={password} onChange={setPassword} disabled={busy} />}
    >
      <div className="gateway-platform-address-fields">
        <div className="gateway-platform-address-field">
          <div className="gateway-stun-field-header">
            <label htmlFor="platform-stun-urls">
              STUN 服务器<span className="gateway-platform-address-optional" aria-hidden="true">选填 · 每行一个</span>
            </label>
            <div className="gateway-stun-preset-actions">
              <button
                type="button"
                disabled={busy || matchesDefaults}
                onClick={() => { setValue(DEFAULT_PUBLIC_STUN_URLS.join('\n')); setError('') }}
              >
                恢复默认推荐
              </button>
              <button
                type="button"
                disabled={busy || !value.trim()}
                onClick={() => { setValue(''); setError('') }}
              >
                清空（仅内置）
              </button>
            </div>
          </div>
          <textarea
            id="platform-stun-urls"
            aria-label="STUN 服务器"
            rows={5}
            value={value}
            disabled={busy}
            placeholder={DEFAULT_PUBLIC_STUN_URLS.join('\n')}
            onChange={event => setValue(event.target.value)}
          />
          <p className="gateway-platform-address-hint">支持域名:端口或 stun:域名:端口，未填端口默认 3478，最多 16 个。</p>
          {!valid && <p className="gateway-auth-error">每行填写一个有效 STUN 地址，不包含路径或账号密码，最多 16 个。</p>}
        </div>
      </div>
      {busy && <p role="status"><span className="gateway-spinner" />正在保存 STUN 服务器…</p>}
      {error && <p role="alert" className="gateway-auth-error">{localizeGatewayError(error)}</p>}
    </GatewayConfirmDialog>
    {discard && <GatewayConfirmDialog title="放弃 STUN 服务器修改" message="STUN 服务器配置尚未保存。" confirmLabel="放弃并关闭" onConfirm={onClose} onCancel={() => setDiscard(false)} />}
  </>
}

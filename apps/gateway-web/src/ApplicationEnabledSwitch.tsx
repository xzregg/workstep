import { localizeGatewayError } from './gatewayErrorText'
import { useRef, useState } from 'react'

export function ApplicationEnabledSwitch({ sourceId, label, enabled, csrf, onSaved }: {
  sourceId: string; label: string; enabled: boolean; csrf: string; onSaved: (enabled: boolean) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  async function toggle() {
    if (!csrf || pending.current) return
    pending.current = true; setBusy(true); setError('')
    try {
      const response = await fetch(`/api/admin/identity-sources/${encodeURIComponent(sourceId)}/enabled`, {
        method: 'PUT', credentials: 'same-origin', headers: {'Content-Type':'application/json', 'X-CSRF-Token':csrf},
        body: JSON.stringify({enabled: !enabled}),
      })
      if (!response.ok) throw Error(response.status === 409
        ? 'Cannot disable the last login entry. Please enable account/password login or another enterprise application first.'
        : 'Failed to save application state, please try again.')
      onSaved(!enabled)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Failed to save application state, please try again.') }
    finally { pending.current = false; setBusy(false) }
  }
  return <div className="gateway-application-enabled">
    <div className="gateway-application-enabled-control">
      <button type="button" role="switch" aria-label={`启用${label}`} aria-checked={enabled}
        className="gateway-application-enabled-switch" disabled={!csrf || busy} onClick={() => void toggle()}><span /></button>
      <span>{enabled ? '已启用' : '已停用'}</span>
    </div>
    {busy && <span role="status"><span className="gateway-spinner" aria-hidden="true" />正在保存…</span>}
    {error && <p role="alert" className="gateway-auth-error">{localizeGatewayError(error)}</p>}
  </div>
}

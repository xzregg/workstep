import { useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { gatewayRemotePortalUrl } from '../utils/gatewayRemote'
import { gatewayFetch } from '../utils/gatewayWorkspacePath'
import Button from './Button'

export default function GatewayLogoutButton() {
  const { t } = useI18n()
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function logout() {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    try {
      const portal = gatewayRemotePortalUrl()
      if (portal) {
        const origin = new URL(portal).origin
        const session = await fetch(origin + '/api/auth/session', { credentials: 'include' })
        if (session.status !== 401) {
          if (!session.ok) throw Error()
          const data = await session.json()
          const response = await fetch(origin + '/api/auth/logout', { method: 'POST', credentials: 'include',
            headers: { 'X-CSRF-Token': data.csrf_token } })
          if (!response.ok && response.status !== 401) throw Error()
        }
        window.location.assign(origin + '/auth')
      } else {
        const response = await gatewayFetch('/api/gateway-platform/logout', { method: 'POST' })
        if (!response.ok) throw Error()
        window.location.assign('/gateway/login')
      }
    } catch {
      setError(t('gatewayLogout.error'))
      pending.current = false; setBusy(false)
    }
  }
  return <><Button loading={busy} onClick={() => void logout()}>{t('gatewayLogout.button')}</Button>
    {error && <span role="alert" className="settings-system-feedback settings-system-feedback--error">{error}</span>}</>
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { useGatewayConnection, useGatewayConnectionStore } from '../stores/gatewayConnectionStore'
import { gatewayFetch } from '../utils/gatewayWorkspacePath'
import Button from './Button'
import './GatewayDesktopAuthentication.css'

export default function GatewayDesktopAuthentication() {
  const { t } = useI18n()
  const { status } = useGatewayConnection()
  const attempted = useRef('')
  const submitting = useRef(false)
  const mounted = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const needsLogin = Boolean(window.workstepDesktop && status?.enabled && !status.package_locked
    && !status.pending_device && !status.reconnecting && (status.authorization_required || !status.authenticated))

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const authenticate = useCallback(async () => {
    if (!status || !needsLogin || submitting.current) return
    const origin = status.url
    submitting.current = true; setBusy(true); setError('')
    try {
      const response = await gatewayFetch('/api/gateway-platform/login', {
        method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ url:origin }),
      })
      if (!response.ok) throw Error(t('gatewayPlatform.connectError'))
      const data = await response.json()
      const target = new URL(data.authorization_url)
      if (target.origin !== new URL(origin).origin || target.pathname !== '/desktop/login') throw Error(t('gatewayPlatform.connectError'))
      const latest = useGatewayConnectionStore.getState().status
      if (mounted.current && latest?.enabled && latest.url === origin) window.location.assign(target.href)
    } catch {
      if (mounted.current) setError(t('gatewayPlatform.connectError'))
    } finally {
      submitting.current = false
      if (mounted.current) setBusy(false)
    }
  }, [status, needsLogin, t])

  useEffect(() => {
    if (needsLogin && status && attempted.current !== status.url) {
      attempted.current = status.url
      void authenticate()
    }
  }, [needsLogin, status, authenticate])

  if (!needsLogin) return null
  return <div className="gateway-desktop-authentication" role={error ? 'alert' : 'status'}>
    <span>{busy ? t('gatewayPlatform.redirecting') : error || t('gatewayPlatform.authenticationWindowHint')}</span>
    <Button type="button" size="sm" loading={busy} onClick={() => void authenticate()}>{t('gatewayPlatform.reopenAuthentication')}</Button>
  </div>
}

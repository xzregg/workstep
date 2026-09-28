import { useEffect, useState, type ReactNode } from 'react'
import { useI18n } from '../i18n'
import './GatewayRemoteFrame.css'

type RemoteContext = {
  device_id: string
  device_name: string
  username: string
  gateway_url: string
}

function remoteGatewayUrl(): string | null {
  if (typeof window === 'undefined') return null
  const hostname = window.location.hostname
  const dot = hostname.indexOf('.')
  if (window.location.protocol !== 'https:' || dot < 3 || !hostname.startsWith('d-')) return null
  return `https://${hostname.slice(dot + 1)}/devices`
}

export default function GatewayRemoteFrame({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const gatewayUrl = remoteGatewayUrl()
  const [context, setContext] = useState<RemoteContext | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!gatewayUrl) return
    let active = true
    let timer: number | undefined
    let controller: AbortController | undefined
    async function refresh() {
      controller = new AbortController()
      try {
        const response = await fetch('/api/remote/session', {
          credentials: 'same-origin', signal: controller.signal,
        })
        if (!response.ok) throw new Error('remote session unavailable')
        const next: RemoteContext = await response.json()
        if (active) { setContext(next); setError(false) }
      } catch {
        if (active) setError(true)
      } finally {
        if (active) timer = window.setTimeout(() => void refresh(), 20000)
      }
    }
    void refresh()
    return () => { active = false; controller?.abort(); window.clearTimeout(timer) }
  }, [gatewayUrl])

  if (!gatewayUrl) return <>{children}</>
  return <div className="gateway-remote-frame">
    <div className="gateway-remote-banner" role="status">
      <strong>{context?.device_name ?? t('gatewayRemote.loading')}</strong>
      <span>{error ? t('gatewayRemote.disconnected') : t('gatewayRemote.online')}</span>
      {context && <span>{context.username}</span>}
      <a href={context?.gateway_url ?? gatewayUrl}>{t('gatewayRemote.back')}</a>
    </div>
    <div className="gateway-remote-content">{children}</div>
  </div>
}

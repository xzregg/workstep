import { useI18n } from '../i18n'
import { gatewayConnectionState, useGatewayConnection } from '../stores/gatewayConnectionStore'
import Icon from './Icon'
import './GatewayConnectionStatus.css'
import { useGatewaySessionStore } from '../stores/gatewaySessionStore'
import { gatewayRemotePortalUrl } from '../utils/gatewayRemote'
import { useWebSocketConnectionStore } from '../stores/webSocketConnectionStore'

export default function GatewayConnectionStatus({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useI18n()
  const { status, error } = useGatewayConnection()
  const { session, errorStatus } = useGatewaySessionStore()
  const { connected, latencyMs } = useWebSocketConnectionStore()
  const remote = !!gatewayRemotePortalUrl()
  if (!status?.enabled) return null
  const state = error ? 'unavailable' : remote && (errorStatus === 401 || errorStatus === 403)
    ? 'notAuthenticated' : remote && !connected ? 'connecting'
    : gatewayConnectionState(status)
  const latency = remote && session && state === 'online' && latencyMs !== null && Number.isFinite(latencyMs)
    ? ` · ${latencyMs} ms` : ''
  const latencyClass = latency && latencyMs! > 1000 ? ' gateway-connection-latency--slow'
    : latency && latencyMs! >= 500 ? ' gateway-connection-latency--warning' : ''
  return <button type="button" className={`gateway-connection-status gateway-connection-status--${state}`}
    onClick={onOpenSettings} title={`${t(`gatewayPlatform.${state}`)}${latency} · ${status.url} · ${t('gatewayPlatform.openSettings')}`}>
    {state === 'connecting' ? <Icon name="loader-circle" size={12} className="gateway-connection-spinner" /> : <span className="gateway-connection-dot" aria-hidden="true" />}
    <span role="status">{t(state === 'online' && latency ? 'gatewayPlatform.shortLabel' : `gatewayPlatform.${state}`)}{latency && <span className={`gateway-connection-latency${latencyClass}`}> · {latencyMs} ms</span>}</span>
  </button>
}

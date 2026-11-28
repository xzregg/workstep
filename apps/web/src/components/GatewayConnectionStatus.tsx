import { useI18n } from '../i18n'
import { gatewayConnectionState, useGatewayConnection } from '../stores/gatewayConnectionStore'
import Icon from './Icon'
import './GatewayConnectionStatus.css'
import { useGatewaySessionStore } from '../stores/gatewaySessionStore'
import { gatewayRemotePortalUrl } from '../utils/gatewayRemote'
import { useWebSocketConnectionStore } from '../stores/webSocketConnectionStore'
import { formatLatencyDisplay, useWebRtcConnectionStore } from '../webrtc/webrtcConnectionStore'
import { isWebRtcRemoteBrowser } from '../webrtc/webrtcLocation'

export default function GatewayConnectionStatus({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useI18n()
  const { status, error } = useGatewayConnection()
  const { session, errorStatus } = useGatewaySessionStore()
  const { connected, latencyMs } = useWebSocketConnectionStore()
  const webrtcConn = useWebRtcConnectionStore()
  const webrtcActive = isWebRtcRemoteBrowser()

  if (webrtcActive) {
    if (!webrtcConn.connected && !webrtcConn.reconnecting) return null
    const state = webrtcConn.connected ? 'online' : 'connecting'
    const latency = state === 'online' ? formatLatencyDisplay(webrtcConn.latencyMs) : formatLatencyDisplay(null)
    const statusText = state === 'online' ? t('webrtcP2p.directConnected') : t('webrtcP2p.connecting')
    return <button type="button" className={`gateway-connection-status gateway-connection-status--${state}`}
      onClick={() => window.WorkStepP2p ? window.WorkStepP2p.postMessage('settings') : onOpenSettings()}
      title={`${statusText}${latency.suffix} · ${t('gatewayPlatform.openSettings')}`}>
      {state === 'connecting' ? <Icon name="loader-circle" size={12} className="gateway-connection-spinner" /> : <span className="gateway-connection-dot" aria-hidden="true" />}
      <span role="status">{statusText}{latency.valid && <span className={`gateway-connection-latency${latency.modifierClass}`}>{latency.suffix}</span>}</span>
    </button>
  }

  const remote = !!gatewayRemotePortalUrl()
  if (!status?.enabled) return null
  const state = error ? 'unavailable' : remote && (errorStatus === 401 || errorStatus === 403)
    ? 'notAuthenticated' : remote && !connected ? 'connecting'
    : gatewayConnectionState(status)
  const gwLatency = remote && session && state === 'online'
    ? formatLatencyDisplay(latencyMs)
    : formatLatencyDisplay(null)
  return <button type="button" className={`gateway-connection-status gateway-connection-status--${state}`}
    onClick={onOpenSettings} title={`${t(`gatewayPlatform.${state}`)}${gwLatency.suffix} · ${status.url} · ${t('gatewayPlatform.openSettings')}`}>
    {state === 'connecting' ? <Icon name="loader-circle" size={12} className="gateway-connection-spinner" /> : <span className="gateway-connection-dot" aria-hidden="true" />}
    <span role="status">{t(state === 'online' && gwLatency.valid ? 'gatewayPlatform.shortLabel' : `gatewayPlatform.${state}`)}{gwLatency.valid && <span className={`gateway-connection-latency${gwLatency.modifierClass}`}>{gwLatency.suffix}</span>}</span>
  </button>
}

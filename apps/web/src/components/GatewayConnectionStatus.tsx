import { useI18n } from '../i18n'
import { gatewayConnectionState, useGatewayConnection } from '../stores/gatewayConnectionStore'
import Icon from './Icon'
import './GatewayConnectionStatus.css'

export default function GatewayConnectionStatus({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useI18n()
  const { status, error } = useGatewayConnection()
  if (!status?.enabled) return null
  const state = error ? 'unavailable' : gatewayConnectionState(status)
  return <button type="button" className={`gateway-connection-status gateway-connection-status--${state}`}
    onClick={onOpenSettings} title={`${t(`gatewayPlatform.${state}`)} · ${status.url} · ${t('gatewayPlatform.openSettings')}`}>
    {state === 'connecting' ? <Icon name="loader-circle" size={12} className="gateway-connection-spinner" /> : <span className="gateway-connection-dot" aria-hidden="true" />}
    <span role="status">{t(`gatewayPlatform.${state}`)}</span>
  </button>
}

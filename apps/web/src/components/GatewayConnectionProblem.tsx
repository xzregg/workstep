import { useGatewayRecoveryStore } from '../stores/gatewayRecoveryStore'
import { useI18n } from '../i18n'
import ConfirmDialog from './ConfirmDialog'

export default function GatewayConnectionProblem() {
  const { t } = useI18n()
  const { paused, dialogOpen, retry, dismiss } = useGatewayRecoveryStore()
  if (!paused) return null
  return <>
    <div className="gateway-connection-paused" role="status">
      <span>{t('gatewayRecovery.paused')}</span>
      <button type="button" className="btn-secondary" onClick={retry}>{t('gatewayRecovery.retry')}</button>
    </div>
    <ConfirmDialog open={dialogOpen} title={t('gatewayRecovery.title')} message={t('gatewayRecovery.message')}
      confirmText={t('gatewayRecovery.retry')} cancelText={t('gatewayRecovery.dismiss')}
      onConfirm={retry} onCancel={dismiss} />
  </>
}

import { useState } from 'react'
import { useI18n } from '../i18n'
import { useGatewayConnection } from '../stores/gatewayConnectionStore'
import { gatewayRemotePortalUrl } from '../utils/gatewayRemote'
import { gatewayWorkspacePath } from '../utils/gatewayWorkspacePath'
import { copyText } from '../utils/clipboard'
import Button from './Button'
import Icon from './Icon'

export default function ChatSessionLinkButton({ projectName, sessionId, mobile = false }: {
  projectName: string; sessionId: string; mobile?: boolean
}) {
  const { t } = useI18n()
  const { status } = useGatewayConnection()
  const [result, setResult] = useState<{ sessionId: string; ok: boolean } | null>(null)
  const notice = result?.sessionId === sessionId ? t(result.ok ? 'common.copied' : 'meta.copyFailed') : ''
  return <Button variant="icon" size="sm"
    className={mobile ? 'mobile-session-link' : undefined}
    aria-label={notice || t('chatSession.copyLink')}
    title={notice || t('chatSession.copyLink')}
    onClick={async () => {
      const url = new URL(window.location.href)
      url.pathname = `${gatewayWorkspacePath()}/chat`
      // Remote browsers already have the externally reachable device address.
      if (!gatewayRemotePortalUrl() && status?.enabled && status.authenticated && status.device_id) {
        const gateway = new URL(status.url)
        url.protocol = gateway.protocol
        url.host = gateway.host
        url.port = gateway.port
        url.pathname = `/workspace/${encodeURIComponent(status.device_id)}/chat`
      }
      url.search = new URLSearchParams({ project: projectName, session: sessionId }).toString()
      url.hash = ''
      setResult({ sessionId, ok: await copyText(url.href) })
    }}>
    <Icon name={notice ? (result?.ok ? 'check' : 'x') : 'share'} size={mobile ? 20 : 16} />
  </Button>
}

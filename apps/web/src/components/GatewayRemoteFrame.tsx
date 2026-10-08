import GatewayDeviceSidebar from './GatewayDeviceSidebar'
import { useEffect, useState, type ReactNode } from 'react'
import { useI18n } from '../i18n'
import './GatewayRemoteFrame.css'
import { gatewayRemotePortalUrl } from '../utils/gatewayRemote'
import { useGatewaySessionStore } from '../stores/gatewaySessionStore'
import { useProjectStore } from '../stores/projectStore'
import Spinner from './Spinner'

export default function GatewayRemoteFrame({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const gatewayUrl = gatewayRemotePortalUrl()
  const context = useGatewaySessionStore(state => state.session)
  const sessionError = useGatewaySessionStore(state => state.error)
  const load = useGatewaySessionStore(state => state.load)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(false)
  const disconnected = error || !!sessionError

  useEffect(() => {
    if (!gatewayUrl) return
    let active = true
    let timer: number | undefined
    async function refresh() {
      try {
        const next = await load(true)
        if (!active) return
        if (next.host_project_id && useProjectStore.getState().activeProject?.id !== next.host_project_id) {
          await useProjectStore.getState().fetchProjects()
          if (useProjectStore.getState().activeProject?.id !== next.host_project_id) {
            throw new Error('Remote project unavailable')
          }
        }
        if (active) { setReady(true); setError(false) }
      } catch {
        if (active) { setReady(false); setError(true) }
      } finally {
        if (active) timer = window.setTimeout(() => void refresh(), 20000)
      }
    }
    void refresh()
    return () => { active = false; window.clearTimeout(timer) }
  }, [gatewayUrl, load])

  if (!gatewayUrl) return <>{children}</>
  return <div className="gateway-remote-frame">
    <div className="gateway-remote-banner" role="status">
      <strong>{context?.device_name ?? t('gatewayRemote.loading')}</strong>
      <span>{disconnected ? t('gatewayRemote.disconnected') : ready && context ? t('gatewayRemote.online') : t('gatewayRemote.loading')}</span>
      {context && <span>{context.username}</span>}
      <a href={context?.gateway_url ?? gatewayUrl}>{t('gatewayRemote.back')}</a>
    </div>
    <div className="gateway-remote-body">
      {ready && context && !context.project_id && <GatewayDeviceSidebar currentDeviceId={context.device_id}/>}
      <div className="gateway-remote-content">{ready && context ? children : <div className="gateway-remote-loading" role="status">
      {!disconnected && <Spinner size={16} />}
      {disconnected ? t('gatewayRemote.disconnected') : t('gatewayRemote.loading')}
    </div>}</div>
    </div>
  </div>
}

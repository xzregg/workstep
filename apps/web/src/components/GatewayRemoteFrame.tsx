import GatewayDeviceTabs from './GatewayDeviceTabs'
import GatewayWorkspaceNotifications from './GatewayWorkspaceNotifications'
import { gatewayWorkspacePath } from '../utils/gatewayWorkspacePath'
import '@workstep/gateway-ui/DeviceTabs.css'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useI18n } from '../i18n'
import './GatewayRemoteFrame.css'
import { gatewayRemotePortalUrl } from '../utils/gatewayRemote'
import { useGatewaySessionStore } from '../stores/gatewaySessionStore'
import { useProjectStore } from '../stores/projectStore'
import Spinner from './Spinner'

export default function GatewayRemoteFrame({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const embedded = typeof window !== 'undefined' && window.parent !== window && window.frameElement?.getAttribute('data-workstep-embedded') === 'true'
  const gatewayUrl = gatewayRemotePortalUrl()
  const context = useGatewaySessionStore(state => state.session)
  const sessionError = useGatewaySessionStore(state => state.error)
  const load = useGatewaySessionStore(state => state.load)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(false)
  const disconnected = error || !!sessionError
  const lastContext=useRef(context)
  if(context)lastContext.current=context
  const displayContext=context ?? lastContext.current

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
    {!embedded && <div className="gateway-remote-banner" role="status">
      {displayContext ? <GatewayDeviceTabs currentDeviceId={displayContext.device_id} currentProjectId={displayContext.project_id}/> :
        <strong>{t('gatewayRemote.loading')}</strong>}
      {disconnected && <span>{t('gatewayRemote.disconnected')}</span>}
      {displayContext && <span className="gateway-remote-username" title={displayContext.username}>{displayContext.username}</span>}
      <a className="gateway-header-control" href={new URL('/account', displayContext?.gateway_url ?? gatewayUrl).href}>{t('gatewayRemote.back')}</a>
      {gatewayWorkspacePath() && <GatewayWorkspaceNotifications/>}
    </div>}
    <div className="gateway-remote-body">
      <div className="gateway-remote-content">{ready && context ? children : <div className="gateway-remote-loading" role="status">
      {!disconnected && <Spinner size={16} />}
      {disconnected ? t('gatewayRemote.disconnected') : t('gatewayRemote.loading')}
    </div>}</div>
    </div>
  </div>
}

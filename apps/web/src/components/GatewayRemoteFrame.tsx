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
import Icon from './Icon'
import { NavigationHeaderContext } from './NavigationHeaderContext'
import { useCompactLayout } from '../hooks/useCompactLayout'
import { useOverlay } from '../hooks/useOverlay'
import { initializeAppearancePreferences } from '../utils/appearancePreferences'

export default function GatewayRemoteFrame({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const compact = useCompactLayout()
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)
  useOverlay(pickerOpen, () => setPickerOpen(false), pickerRef, false)
  useEffect(() => setPickerOpen(false), [compact])
  const embedded = typeof window !== 'undefined' && window.parent !== window && window.frameElement?.getAttribute('data-workstep-embedded') === 'true'
  const gatewayUrl = gatewayRemotePortalUrl()
  const context = useGatewaySessionStore(state => state.session)
  const sessionError = useGatewaySessionStore(state => state.error)
  const load = useGatewaySessionStore(state => state.load)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(false)
  const appearanceIdentity = useRef<string | null>(null)
  const disconnected = error || !!sessionError
  const lastContext=useRef(context)
  if(context)lastContext.current=context
  const displayContext=context ?? lastContext.current

  useEffect(() => {
    if (!gatewayUrl) return
    let active = true
    let timer: number | undefined
    let refreshing = false
    async function refresh() {
      if (!active || refreshing) return
      refreshing = true
      window.clearTimeout(timer)
      try {
        const next = await load(true)
        if (!active) return
        if (next.user_id) {
          const identity = `${next.device_id}:${next.user_id}`
          if (appearanceIdentity.current && appearanceIdentity.current !== identity) {
            setReady(false)
            await initializeAppearancePreferences()
            if (!active) return
          }
          appearanceIdentity.current = identity
        }
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
        refreshing = false
        if (active) timer = window.setTimeout(() => void refresh(), 20000)
      }
    }
    const resume = () => void refresh()
    const visible = () => { if (document.visibilityState === 'visible') resume() }
    void refresh()
    window.addEventListener('workstep:resume', resume)
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', visible)
    return () => {
      active = false
      window.clearTimeout(timer)
      window.removeEventListener('workstep:resume', resume)
      window.removeEventListener('online', resume)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [gatewayUrl, load])

  const deviceTrigger = compact && !embedded ? <button type="button" className="gateway-mobile-device-trigger" aria-label={t('gatewayRemote.switchDevices')}
        title={displayContext?.device_name} aria-expanded={pickerOpen} aria-controls="gateway-device-picker" onClick={() => setPickerOpen(value => !value)}>
        <Icon name="layers" size={18}/>
      </button> : null

  if (!gatewayUrl) return <>{children}</>
  return <div className={`gateway-remote-frame${compact && !embedded ? ' gateway-remote-frame--mobile' : ''}`}>
    {!embedded && <>
      {pickerOpen && <button type="button" className="gateway-mobile-picker-backdrop" aria-label={t('common.close')} onClick={() => setPickerOpen(false)}/>}
    </>}
    {!embedded && <div ref={pickerRef} id="gateway-device-picker" hidden={compact && !pickerOpen}
      className={compact ? 'gateway-mobile-picker' : 'gateway-remote-banner'} role={compact ? 'dialog' : undefined}
      aria-modal={compact && pickerOpen ? true : undefined} aria-label={t('gatewayRemote.switchDevices')}>
      {displayContext ? <GatewayDeviceTabs currentDeviceId={displayContext.device_id} currentProjectId={displayContext.project_id}
        header={<>
          {compact && <strong>{t('gatewayRemote.switchDevices')}</strong>}
          <button type="button" className="gateway-header-control gateway-return-control" aria-label={t('gatewayRemote.back')} title={t('gatewayRemote.back')} onClick={() => window.location.assign(new URL('/account', displayContext.gateway_url ?? gatewayUrl).href)}>{compact ? <><Icon name="external-link" size={18}/><span>{t('gatewayRemote.backCompact')}</span></> : t('gatewayRemote.back')}</button>
          {gatewayWorkspacePath() && <GatewayWorkspaceNotifications/>}
          {compact && <button type="button" className="gateway-mobile-picker-close gateway-header-control gateway-header-icon-control" aria-label={t('common.close')} onClick={() => setPickerOpen(false)}><Icon name="x" size={18}/></button>}
        </>}/>: <strong>{t('gatewayRemote.loading')}</strong>}
      {disconnected && <span>{t('gatewayRemote.disconnected')}</span>}
    </div>}
    <div className="gateway-remote-body">
      <div className="gateway-remote-content">{ready && context ? <NavigationHeaderContext.Provider value={deviceTrigger}>{children}</NavigationHeaderContext.Provider> : <div className="gateway-remote-loading" role="status">
      {!disconnected && <Spinner size={16} />}
      {disconnected ? t('gatewayRemote.disconnected') : t('gatewayRemote.loading')}
    </div>}</div>
    </div>
  </div>
}

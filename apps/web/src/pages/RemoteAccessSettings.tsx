import { useState } from 'react'
import { useManagedMode } from '../hooks/useManagedMode'
import { useI18n } from '../i18n'
import GatewayPlatformSettings from './GatewayPlatformSettings'
import RemoteProjectSettings from './RemoteProjectSettings'
import './RemoteAccessSettings.css'

export default function RemoteAccessSettings() {
 const managed = useManagedMode()
 const { t } = useI18n()
 const [tab, setTab] = useState<'gateway' | 'legacy'>('gateway')
 return <div className="remote-access-settings">
  <nav className="remote-access-tabs" aria-label={t('settings.remoteAccessTitle')}>
   <button type="button" aria-current={tab === 'gateway' || managed ? 'page' : undefined} onClick={() => setTab('gateway')}>{t('gatewayPlatform.title')}</button>
   {managed !== true && <button type="button" aria-current={tab === 'legacy' ? 'page' : undefined} onClick={() => setTab('legacy')}>{t('nav.remoteProjects')}</button>}
  </nav>
  {tab === 'gateway' || managed === true ? <GatewayPlatformSettings /> : <RemoteProjectSettings />}
 </div>
}
